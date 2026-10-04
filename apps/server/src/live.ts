import { randomUUID } from "node:crypto";
import { type AnchorDecision, type Draft, type HandleResult, MAX_RUNNING_LANES, SocratesBusyError } from "@socrates/agent";
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
/** Drafts of a reply that is arriving go out at most this often per page. */
const DRAFT_INTERVAL_MS = 50;
/** What replaces a draft: the saved narration, answer or question, or the end of the turn. */
const SETTLES_DRAFT = new Set(["step", "answer", "question", "finished"]);
/** A page this far behind on reading is disconnected; it reconnects and catches up. */
const SEND_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Text = z.string().min(1).max(TEXT_MAX_CHARS).refine((text) => text.trim().length > 0, "Write a message.");
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

/** The reply a turn is writing, as the live connection sends it: everything readable so far. */
interface DraftMessage extends Draft {
  type: "draft";
  conversation: string;
  turnId: string;
}

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
  /** What will change, such as an edit's texts or a patch, when the request shows it. */
  preview: string | null;
}

interface Run {
  id: string;
  /** The message's panel; compound main messages retain main until all parts finish. */
  conversation: string;
  /** The current handed-off part; compound messages retain their main reservation. */
  handedTurnId?: string;
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
  /** Subscribe at hello, so events saved between upgrade and replay arrive once. */
  private readonly subscribed = new Set<WebSocket>();
  private readonly queue: { id: string; text: string }[] = [];
  private readonly approvals = new Map<string, { view: PendingApproval; runId: string; resolve: (granted: boolean) => void }>();
  private readonly runs = new Map<string, Run>();
  /** Accepted IDs remain reserved across reconnects for this server launch. */
  private readonly acceptedIds = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeRuntime: () => void;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The reply each working turn is writing now: temporary, never saved, sent to a page that joins late. */
  private readonly drafts = new Map<string, { runId: string; message: DraftMessage }>();
  private readonly draftsUnsent = new Set<string>();
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  private readonly replayMax: number;

  constructor(private readonly runtime: Runtime, options: { replayMax?: number } = {}) {
    this.replayMax = options.replayMax ?? REPLAY_MAX_EVENTS;
    this.unsubscribe = runtime.store.onEvent((event) => {
      const activity = activityOf(runtime.store, event);
      if (activity && SETTLES_DRAFT.has(activity.kind) && "turnId" in activity && activity.turnId) this.settleDraft(activity.turnId);
      if (activity) this.broadcast({ type: "activity", ...activity });
      // Turns and lanes change what is running; coalesce the state that follows.
      if (event.turn_id || event.type.startsWith("lane_")) this.scheduleState();
    });
    this.unsubscribeRuntime = runtime.onChange(() => {
      this.publishState();
      this.drain();
    });
  }

  attach(socket: WebSocket): void {
    if (this.closed) {
      socket.close(1001, "Socrates is stopping.");
      return;
    }
    this.clients.add(socket);
    socket.on("message", (raw) => this.command(socket, raw.toString()));
    const detach = () => { this.clients.delete(socket); this.subscribed.delete(socket); };
    socket.on("close", detach);
    socket.on("error", detach);
  }

  /** Cancel every run and wait until each is recorded, refuse pending approvals, and disconnect every page. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const settling = [...this.runs.values()].map((r) => r.settled);
    this.unsubscribe();
    this.unsubscribeRuntime();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.drafts.clear();
    this.draftsUnsent.clear();
    for (const run of this.runs.values()) run.controller.abort();
    for (const approval of this.approvals.values()) approval.resolve(false);
    this.approvals.clear();
    for (const socket of this.clients) socket.close(1001, "Socrates is stopping.");
    this.clients.clear();
    this.subscribed.clear();
    this.closing = Promise.allSettled(settling).then(() => {});
    return this.closing;
  }

  state() {
    const socrates = this.runtime.socrates;
    return {
      type: "state" as const,
      seq: this.runtime.store.latestEventSeq(),
      ready: socrates !== null && this.runtime.acceptingMessages,
      setup: this.runtime.setup,
      access: this.runtime.settings.access,
      busy: socrates?.busy ?? false,
      lanes: this.runtime.lanes(),
      queue: [...this.queue],
      approvals: [...this.approvals.values()].map((a) => a.view),
    };
  }

  private command(socket: WebSocket, raw: string): void {
    if (this.closed) return;
    let command: Command;
    try {
      command = Command.parse(JSON.parse(raw));
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ") : "Send one JSON command.";
      this.send(socket, { type: "error", code: "invalid_command", message });
      return;
    }
    try {
      // A command without hello opts into fresh updates without history replay.
      if (command.type !== "hello") this.subscribed.add(socket);
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
        this.assertNewId(command.id);
        if (this.queue.length >= QUEUE_MAX) throw new LiveError("queue_full", `At most ${QUEUE_MAX} messages can wait for the main conversation.`);
        this.acceptedIds.add(command.id);
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
        this.start(item.id, item.text, "new_lane", undefined, true);
        this.queue.splice(this.queue.indexOf(item), 1);
        return this.publishState();
      }
      case "cancel": {
        const runs = [...this.runs.values()].filter((r) => {
          if (r.conversation === command.conversation) return true;
          const handed = r.handedTurnId ? this.runtime.store.getTurn(r.handedTurnId) : null;
          return handed?.status === "in_progress" && handed.laneId === command.conversation;
        });
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
        if (!this.runtime.store.getLane(command.lane)) throw new LiveError("not_found", "There is no such lane.");
        this.socrates().closeLane(command.lane);
        return this.publishState();
    }
  }

  /** The current state, then every activity after `after` (or a reset when too far behind). */
  private hello(socket: WebSocket, after: number | undefined): void {
    this.subscribed.add(socket);
    const store = this.runtime.store;
    this.send(socket, this.state());
    if (after !== undefined) {
      const latest = store.latestEventSeq();
      if (after > latest || latest - after > this.replayMax) this.send(socket, { type: "reset", seq: latest });
      else {
        for (const event of store.listEvents({ afterSeq: after })) {
          const activity = activityOf(store, event);
          if (activity) this.send(socket, { type: "activity", ...activity });
        }
      }
    }
    // The replies being written now, after the saved activity they follow.
    for (const { message } of this.drafts.values()) this.send(socket, message);
  }

  /** Keep the newest draft of a turn and send it with the next interval's. */
  private draft(runId: string, turnId: string, draft: Draft): void {
    if (this.closed) return;
    const turn = this.runtime.store.getTurn(turnId);
    this.drafts.set(turnId, { runId, message: { type: "draft", conversation: turn?.laneId ?? "main", turnId, ...draft } });
    this.draftsUnsent.add(turnId);
    this.draftTimer ??= setTimeout(() => {
      this.draftTimer = null;
      for (const id of this.draftsUnsent) {
        const entry = this.drafts.get(id);
        if (entry) this.broadcast(entry.message);
      }
      this.draftsUnsent.clear();
    }, DRAFT_INTERVAL_MS);
  }

  /** The saved reply replaces a turn's draft; a draft not yet sent is dropped with it. */
  private settleDraft(turnId: string): void {
    this.drafts.delete(turnId);
    this.draftsUnsent.delete(turnId);
  }

  /** Start one message: in main (refused while main is busy; queue it instead), a new lane, or an open lane. */
  private start(id: string, text: string, to: string, anchorDecisions?: AnchorDecision[], fromQueue = false): void {
    const socrates = this.socrates();
    if (!fromQueue) this.assertNewId(id);
    if (to !== "main" && to !== "new_lane") {
      const lane = this.runtime.store.getLane(to);
      if (!lane || lane.closedAt) throw new LiveError("lane_closed", "That lane is closed.");
    }
    if (to === "main" && socrates.busy) throw new LiveError("main_busy", "Socrates is working in the main conversation; queue this message or send it in a lane.");
    const running = socrates.lanes().filter((l) => l.running);
    if (to !== "main" && !running.some((l) => l.id === to) && running.length >= MAX_RUNNING_LANES) {
      throw new LiveError("lane_limit", `${MAX_RUNNING_LANES} lanes are already working; wait for one to finish or stop one.`);
    }
    const run: Run = { id, conversation: to === "new_lane" ? "starting" : to, controller: new AbortController() };
    this.acceptedIds.add(id);
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
      onHandoff: (laneId, turnId) => {
        run.handedTurnId = turnId;
        // Single-part handoffs free main. A compound message still owns it.
        if (!socrates.busy) run.conversation = laneId;
        this.broadcast({ type: "handed_off", id, conversation: laneId, lane: this.runtime.store.requireLane(laneId).number, mainReleased: !socrates.busy });
        this.publishState();
        this.drain();
      },
      onDraft: (turnId, draft) => this.draft(id, turnId, draft),
      onAcknowledgment: (line) => this.broadcast({ type: "status", id, conversation: run.conversation, text: line }),
      onStatus: (line) => {
        const handed = run.handedTurnId ? this.runtime.store.getTurn(run.handedTurnId) : null;
        const conversation = handed?.status === "in_progress" ? handed.laneId ?? run.conversation : run.conversation;
        this.broadcast({ type: "status", id, conversation, text: line });
      },
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
        for (const [turnId, entry] of this.drafts) if (entry.runId === id) this.settleDraft(turnId);
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
    if (this.closed || !this.runtime.acceptingMessages || !socrates || socrates.busy || !this.queue.length) return;
    const next = this.queue.shift()!;
    try {
      this.start(next.id, next.text, "main", undefined, true);
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
      preview: request.preview ?? null,
    };
    return new Promise((resolve) => {
      const finish = (granted: boolean) => {
        run.controller.signal.removeEventListener("abort", abort);
        resolve(granted);
      };
      // Stopping the run counts as a refusal.
      const abort = () => {
        if (this.approvals.delete(view.id)) {
          finish(false);
          this.publishState();
        }
      };
      this.approvals.set(view.id, { view, runId: run.id, resolve: finish });
      run.controller.signal.addEventListener("abort", abort, { once: true });
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
    if (!this.runtime.acceptingMessages) throw new LiveError("busy", "Socrates is rebuilding or stopping; wait until it is ready.");
    const socrates = this.runtime.socrates;
    if (!socrates) throw new LiveError("setup_needed", this.runtime.setup.join(" ") || "Socrates is not ready.");
    return socrates;
  }

  private assertNewId(id: string): void {
    if (this.acceptedIds.has(id)) throw new LiveError("duplicate", "A message with this id was already sent.");
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
    if (this.closed) return;
    const data = JSON.stringify(message);
    for (const socket of this.subscribed) this.write(socket, data);
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
