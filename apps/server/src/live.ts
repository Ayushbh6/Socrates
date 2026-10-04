import { randomUUID } from "node:crypto";
import { type AnchorDecision, type HandleResult, MAX_RUNNING_LANES, SocratesBusyError } from "@socrates/agent";
import type { ApprovalOrigin, ApprovalRequest } from "@socrates/tools";
import type { WebSocket } from "ws";
import { z } from "zod";
import { activityOf } from "./activity";
import type { Runtime } from "./runtime";

/** A reconnecting page catches up on at most this many events; further behind, it reloads its history. */
export const REPLAY_MAX_EVENTS = 5_000;
/** The main conversation's queue holds at most this many messages. */
export const QUEUE_MAX = 20;
const TEXT_MAX_CHARS = 100_000;
/** A page this far behind on reading is disconnected; it reconnects and catches up. */
const SEND_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Text = z.string().trim().min(1).max(TEXT_MAX_CHARS);
const Decision = z.object({ goalId: z.string(), path: z.string(), role: z.string(), decision: z.enum(["approve", "reject", "supersede"]) }).strict();

/** What a page may send (architecture/server.md, "Live connection"). */
const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), after: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal("send"), id: Id, text: Text, to: z.union([z.literal("main"), z.literal("new_lane"), Id]), anchorDecisions: z.array(Decision).max(10).optional() }).strict(),
  z.object({ type: z.literal("queue"), id: Id, text: Text }).strict(),
  z.object({ type: z.literal("queue_edit"), id: Id, text: Text }).strict(),
  z.object({ type: z.literal("queue_remove"), id: Id }).strict(),
  z.object({ type: z.literal("queue_to_lane"), id: Id }).strict(),
  z.object({ type: z.literal("cancel"), conversation: z.union([z.literal("main"), Id]) }).strict(),
  z.object({ type: z.literal("approve"), approval: Id, granted: z.boolean() }).strict(),
  z.object({ type: z.literal("close_lane"), lane: Id }).strict(),
]);
type Command = z.infer<typeof Command>;

/** An approval waiting for the user, shown in the panel of the conversation that asked. */
export interface PendingApproval {
  id: string;
  conversation: string;
  lane: number | null;
  turnId: string | null;
  task: string | null;
  kind: ApprovalRequest["kind"];
  tool: string;
  detail: string;
}

interface Run {
  id: string;
  /** "main" or the lane it runs in; a handed-off main message moves to its lane. */
  conversation: string;
  controller: AbortController;
  /** Settles once the message's work is recorded, however it ended. */
  settled?: Promise<unknown>;
}

/**
 * The live connection (architecture/server.md, "Live connection"): every page
 * sees every activity as its event is saved, the shared state (busy, lanes,
 * the main queue, pending approvals), and every message's result. Pages send
 * messages to main or a lane, queue messages for main, answer approvals,
 * cancel, and close lanes. State lives here, not in a page, so a reload or a
 * second tab sees the same thing.
 */
export class LiveHub {
  private readonly clients = new Set<WebSocket>();
  private readonly queue: { id: string; text: string }[] = [];
  private readonly approvals = new Map<string, { view: PendingApproval; runId: string; resolve: (granted: boolean) => void }>();
  private readonly runs = new Map<string, Run>();
  private readonly unsubscribe: () => void;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private readonly replayMax: number;

  constructor(private readonly runtime: Runtime, options: { replayMax?: number } = {}) {
    this.replayMax = options.replayMax ?? REPLAY_MAX_EVENTS;
    this.unsubscribe = runtime.store.onEvent((event) => {
      const activity = activityOf(runtime.store, event);
      if (activity) this.broadcast({ type: "activity", ...activity });
      // Turns and lanes change what is running; coalesce the state that follows.
      if (event.turn_id || event.type.startsWith("lane_")) this.scheduleState();
    });
  }

  attach(socket: WebSocket): void {
    if (this.closed) {
      socket.close(1001, "Socrates is stopping.");
      return;
    }
    this.clients.add(socket);
    socket.on("message", (raw) => this.command(socket, raw.toString()));
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  /** Cancel every run and wait until each is recorded, refuse pending approvals, and disconnect every page. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const settling = [...this.runs.values()].map((r) => r.settled);
    this.unsubscribe();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    for (const run of this.runs.values()) run.controller.abort();
    for (const approval of this.approvals.values()) approval.resolve(false);
    this.approvals.clear();
    for (const socket of this.clients) socket.close(1001, "Socrates is stopping.");
    this.clients.clear();
    await Promise.allSettled(settling);
  }

  state() {
    const socrates = this.runtime.socrates;
    return {
      type: "state" as const,
      seq: this.runtime.store.latestEventSeq(),
      ready: socrates !== null,
      setup: this.runtime.setup,
      busy: socrates?.busy ?? false,
      lanes: this.runtime.lanes(),
      queue: [...this.queue],
      approvals: [...this.approvals.values()].map((a) => a.view),
    };
  }

  private command(socket: WebSocket, raw: string): void {
    let command: Command;
    try {
      command = Command.parse(JSON.parse(raw));
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ") : "Send one JSON command.";
      this.send(socket, { type: "error", code: "invalid_command", message });
      return;
    }
    try {
      this.run(socket, command);
    } catch (error) {
      this.send(socket, { type: "error", ...("id" in command ? { id: command.id } : {}), ...problemOf(error) });
    }
  }

  private run(socket: WebSocket, command: Command): void {
    switch (command.type) {
      case "hello":
        return this.hello(socket, command.after);
      case "send":
        return this.start(command.id, command.text, command.to, command.anchorDecisions);
      case "queue":
        if (this.queue.some((q) => q.id === command.id) || this.runs.has(command.id)) throw new LiveError("duplicate", "A message with this id was already sent.");
        if (this.queue.length >= QUEUE_MAX) throw new LiveError("queue_full", `At most ${QUEUE_MAX} messages can wait for the main conversation.`);
        this.queue.push({ id: command.id, text: command.text });
        this.publishState();
        return this.drain();
      case "queue_edit":
        this.queued(command.id).text = command.text;
        return this.publishState();
      case "queue_remove":
        this.queue.splice(this.queue.indexOf(this.queued(command.id)), 1);
        return this.publishState();
      case "queue_to_lane": {
        const item = this.queued(command.id);
        this.start(item.id, item.text, "new_lane");
        this.queue.splice(this.queue.indexOf(item), 1);
        return this.publishState();
      }
      case "cancel": {
        const runs = [...this.runs.values()].filter((r) => r.conversation === command.conversation);
        if (!runs.length) throw new LiveError("not_running", "Nothing is running there.");
        for (const r of runs) r.controller.abort();
        return;
      }
      case "approve": {
        const approval = this.approvals.get(command.approval);
        if (!approval) throw new LiveError("not_found", "That approval is no longer waiting.");
        this.approvals.delete(command.approval);
        approval.resolve(command.granted);
        return this.publishState();
      }
      case "close_lane":
        this.socrates().closeLane(command.lane);
        return this.publishState();
    }
  }

  /** The current state, then every activity after `after` (or a reset when too far behind). */
  private hello(socket: WebSocket, after: number | undefined): void {
    const store = this.runtime.store;
    this.send(socket, this.state());
    if (after === undefined) return;
    const latest = store.latestEventSeq();
    if (latest - after > this.replayMax) {
      this.send(socket, { type: "reset", seq: latest });
      return;
    }
    for (const event of store.listEvents({ afterSeq: after })) {
      const activity = activityOf(store, event);
      if (activity) this.send(socket, { type: "activity", ...activity });
    }
  }

  /** Start one message: in main (refused while main is busy; queue it instead), a new lane, or an open lane. */
  private start(id: string, text: string, to: string, anchorDecisions?: AnchorDecision[]): void {
    const socrates = this.socrates();
    if (this.runs.has(id)) throw new LiveError("duplicate", "A message with this id was already sent.");
    if (to === "main" && socrates.busy) throw new LiveError("main_busy", "Socrates is working in the main conversation; queue this message or send it in a lane.");
    const running = socrates.lanes().filter((l) => l.running);
    if (to !== "main" && !running.some((l) => l.id === to) && running.length >= MAX_RUNNING_LANES) {
      throw new LiveError("lane_limit", `${MAX_RUNNING_LANES} lanes are already working; wait for one to finish or stop one.`);
    }
    const run: Run = { id, conversation: to === "new_lane" ? "starting" : to, controller: new AbortController() };
    this.runs.set(id, run);
    const work = socrates.handle(text, {
      signal: run.controller.signal,
      approve: (request, origin) => this.ask(run, request, origin),
      ...(to === "main" ? {} : { lane: to === "new_lane" ? "new" : to }),
      ...(anchorDecisions?.length ? { anchorDecisions } : {}),
      onLane: (laneId) => {
        run.conversation = laneId;
        this.broadcast({ type: "accepted", id, conversation: laneId });
      },
      onHandoff: (laneId) => {
        run.conversation = laneId;
        this.broadcast({ type: "handed_off", id, conversation: laneId, lane: this.runtime.store.requireLane(laneId).number });
        this.publishState();
        this.drain();
      },
      onAcknowledgment: (line) => this.broadcast({ type: "status", id, conversation: run.conversation, text: line }),
      onStatus: (line) => this.broadcast({ type: "status", id, conversation: run.conversation, text: line }),
    });
    if (to !== "new_lane") this.broadcast({ type: "accepted", id, conversation: to });
    this.publishState();
    run.settled = work
      .then((result) => this.broadcast({ type: "result", id, conversation: run.conversation, result: summary(result) }))
      .catch((error) => {
        if (!(error instanceof SocratesBusyError)) this.runtime.log(`message ${id} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        this.broadcast({ type: "error", id, conversation: run.conversation, ...problemOf(error) });
      })
      .finally(() => {
        this.runs.delete(id);
        // An approval the run never got an answer for is refused.
        for (const [key, approval] of this.approvals) if (approval.runId === id) {
          this.approvals.delete(key);
          approval.resolve(false);
        }
        this.publishState();
        this.drain();
      });
  }

  /** The next queued message, as soon as the main conversation is free. */
  private drain(): void {
    const socrates = this.runtime.socrates;
    if (this.closed || !socrates || socrates.busy || !this.queue.length) return;
    const next = this.queue.shift()!;
    try {
      this.start(next.id, next.text, "main");
    } catch (error) {
      this.broadcast({ type: "error", id: next.id, conversation: "main", ...problemOf(error) });
    }
    this.publishState();
  }

  private ask(run: Run, request: ApprovalRequest, origin: ApprovalOrigin | undefined): Promise<boolean> {
    if (run.controller.signal.aborted || this.closed) return Promise.resolve(false);
    const store = this.runtime.store;
    const task = origin?.taskId ? store.getTask(origin.taskId) : null;
    const view: PendingApproval = {
      id: randomUUID(),
      conversation: origin?.laneId ?? run.conversation,
      lane: origin?.laneId ? store.requireLane(origin.laneId).number : null,
      turnId: origin?.turnId ?? null,
      task: task ? `g${store.requireGoal(task.goalId).number}/t${task.number} ${task.title}` : null,
      kind: request.kind,
      tool: request.tool,
      detail: request.detail,
    };
    return new Promise((resolve) => {
      this.approvals.set(view.id, { view, runId: run.id, resolve });
      // Stopping the run counts as a refusal.
      run.controller.signal.addEventListener("abort", () => {
        if (this.approvals.delete(view.id)) {
          resolve(false);
          this.publishState();
        }
      }, { once: true });
      this.broadcast({ type: "approval", ...view });
      this.publishState();
    });
  }

  private queued(id: string): { id: string; text: string } {
    const item = this.queue.find((q) => q.id === id);
    if (!item) throw new LiveError("not_found", "That message is no longer queued.");
    return item;
  }

  private socrates() {
    const socrates = this.runtime.socrates;
    if (!socrates) throw new LiveError("setup_needed", this.runtime.setup.join(" ") || "Socrates is not ready.");
    return socrates;
  }

  private scheduleState(): void {
    if (this.stateTimer || this.closed) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.publishState();
    }, 50);
  }

  private publishState(): void {
    if (!this.closed) this.broadcast(this.state());
  }

  private broadcast(message: object): void {
    const data = JSON.stringify(message);
    for (const socket of this.clients) this.write(socket, data);
  }

  private send(socket: WebSocket, message: object): void {
    this.write(socket, JSON.stringify(message));
  }

  private write(socket: WebSocket, data: string): void {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > SEND_BUFFER_MAX_BYTES) {
      socket.close(1013, "Too far behind; reconnect to catch up.");
      return;
    }
    socket.send(data);
  }
}

export class LiveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LiveError";
  }
}

function problemOf(error: unknown): { code: string; message: string } {
  if (error instanceof LiveError) return { code: error.code, message: error.message };
  if (error instanceof SocratesBusyError) return { code: error.reason, message: error.message };
  return { code: "failed", message: "The message could not be handled. Details are in the server log." };
}

/** A result without the ledger internals a page does not need. */
function summary(result: HandleResult) {
  if (result.kind === "clarify") return { kind: result.kind, text: result.text, laneId: result.laneId, notices: result.notices };
  return {
    kind: result.kind,
    text: result.text,
    laneId: result.laneId,
    notices: result.notices,
    parts: result.parts.map((p) => ({ order: p.order, status: p.status, turnId: p.turn.id, projectTurn: p.turn.projectTurn, task: p.task.title, laneId: p.turn.laneId, toolCalls: p.toolCalls, anchorChanges: p.anchorChanges ?? [] })),
  };
}
