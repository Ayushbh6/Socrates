import { randomUUID } from "node:crypto";
import { type AnchorDecision, type Draft, type HandleResult, MAX_RUNNING_CHATS, MAX_RUNNING_LANES, RedoError, SocratesBusyError } from "@socrates/agent";
import type { Attachment } from "@socrates/contracts";
import { abortable } from "@socrates/shared";
import type { ApprovalOrigin, ApprovalRequest } from "@socrates/tools";
import type { WebSocket } from "ws";
import { z } from "zod";
import { activityOf } from "./activity";
import { ATTACHMENTS_MAX, findAttachment, viewOf } from "./attachments";
import type { Runtime } from "./runtime";
import { TerminalPanel, TerminalPanelError } from "./terminals";
import { provisionalTitle } from "./titles";

/** A reconnecting page catches up on at most this many events; further behind, it reloads its history. */
export const REPLAY_MAX_EVENTS = 5_000;
/** The main conversation's queue holds at most this many messages. */
export const QUEUE_MAX = 20;
const TEXT_MAX_CHARS = 100_000;
/** Drafts of a reply that is arriving go out at most this often per page. */
const DRAFT_INTERVAL_MS = 50;
/** What replaces a draft: the saved narration, answer or question, or the end of the turn. */
const SETTLES_DRAFT = new Set(["step", "answer", "question", "finished"]);
/**
 * A thinking draft shows only its newest lines, so a long one goes out as its
 * last this-many characters with its full `length`, rather than all of it
 * twenty times a second.
 */
export const THINKING_DRAFT_CHARS = 4_000;
/** A page this far behind on reading is disconnected; it reconnects and catches up. */
const SEND_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
/** A message's exact text; it may be empty when images are attached (`hasWords`). */
const Text = z.string().max(TEXT_MAX_CHARS);
/** An attachment named in a message: a stored image's id, with the name the page gives it. */
const Attached = z.array(z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), name: z.string().max(1000) }).strict()).max(ATTACHMENTS_MAX);
/** Standard mode's choice of where a message goes: a goal (null: the Chats goal) and its chat (null: a new one). */
const Chat = z.object({ goal: z.number().int().positive().nullable(), task: z.number().int().positive().nullable() }).strict();
export type ChatChoice = z.infer<typeof Chat>;
/** Flow mode's "Keep my next message in this task": a task chosen for one message, which is then not routed. */
const Keep = z.object({ goal: z.number().int().positive(), task: z.number().int().positive() }).strict();
type KeepChoice = z.infer<typeof Keep>;
/** A terminal session's id, as the terminal panel lists it. */
const Session = z.string().regex(/^term-\d{1,9}$/);
/** What one keystroke or paste may send to a terminal. */
const TERMINAL_INPUT_MAX = 64 * 1024;
const Decision = z.object({ goalId: z.string(), path: z.string(), role: z.string(), decision: z.enum(["approve", "reject", "supersede"]) }).strict();

/** What a page may send (architecture/server.md, "Live connection"). */
const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), after: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal("send"), id: Id, text: Text, to: z.union([z.literal("main"), z.literal("new_lane"), Id]), anchorDecisions: z.array(Decision).max(10).optional(), attachments: Attached.optional(), chat: Chat.optional(), keep: Keep.optional() }).strict(),
  z.object({ type: z.literal("reply"), id: Id, clarification: Id, text: Text }).strict(),
  z.object({ type: z.literal("cancel_question"), clarification: Id }).strict(),
  z.object({ type: z.literal("queue"), id: Id, text: Text, attachments: Attached.optional(), chat: Chat.optional(), keep: Keep.optional() }).strict(),
  /** Ask a finished or stopped question again in a chosen chat, or in today's general conversation, setting the first attempt aside. */
  z.object({ type: z.literal("redo"), id: Id, turn: z.string().min(1).max(100), chat: Chat.optional(), general: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("queue_edit"), id: Id, text: Text }).strict(),
  z.object({ type: z.literal("queue_remove"), id: Id }).strict(),
  z.object({ type: z.literal("queue_to_lane"), id: Id }).strict(),
  // With `chat`, only the message working in that standard-mode chat stops.
  z.object({ type: z.literal("cancel"), conversation: z.union([z.literal("main"), Id]), chat: Chat.optional() }).strict(),
  z.object({ type: z.literal("approve"), approval: Id, granted: z.boolean() }).strict(),
  z.object({ type: z.literal("close_lane"), lane: Id }).strict(),
  // The terminal panel (architecture/server.md, "Terminal panel").
  z.object({ type: z.literal("terminal_open"), session: Session }).strict(),
  z.object({ type: z.literal("terminal_shut"), session: Session }).strict(),
  z.object({ type: z.literal("terminal_input"), session: Session, data: z.string().min(1).max(TERMINAL_INPUT_MAX) }).strict(),
  z.object({ type: z.literal("terminal_resize"), session: Session, cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).strict(),
  z.object({ type: z.literal("terminal_stop"), session: Session }).strict(),
  z.object({ type: z.literal("terminal_restart"), session: Session }).strict(),
  z.object({ type: z.literal("terminal_dismiss"), session: Session }).strict(),
]);
type Command = z.infer<typeof Command>;

/** A turn's reply, its thinking, and each running call's output are drafts of their own. */
const draftKey = (turnId: string, draft: Pick<Draft, "kind" | "handle">) =>
  draft.kind === "thinking" ? `${turnId}:thinking` : draft.kind === "output" ? `${turnId}:output:${draft.handle}` : turnId;

/** The reply a turn is writing, as the live connection sends it: everything readable so far. */
interface DraftMessage extends Draft {
  type: "draft";
  conversation: string;
  turnId: string;
  /** The draft's full length when `text` is only its end (a long thought). */
  length?: number;
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
  /** A standard-mode chat message, which runs beside the main conversation rather than in it. */
  chat: boolean;
  /** The tasks its parts were bound to, once they are. */
  tasks: Set<string>;
  /** The saved message's sequence number, once it is bound without routing, so the page that sent it knows it. */
  seq?: number;
  /** The current handed-off part; compound messages retain their main reservation. */
  handedTurnId?: string;
  controller: AbortController;
  /** Settles once the message's work is recorded, however it ended. */
  settled?: Promise<unknown>;
  schedule: Schedule;
}

/** Acceptance order survives queuing. Binding and finishing also settle on removal, failure and Stop. */
interface Schedule {
  receivedAt: string;
  order: number;
  tasks: Set<string>;
  bound: Promise<void>;
  bind: () => void;
  done: Promise<void>;
  finish: () => void;
  handedOff: Promise<void>;
  handOff: () => void;
}

/** A message waiting to start: for the main conversation, or for its standard-mode chat. */
interface Queued {
  id: string;
  text: string;
  attachments: Attachment[];
  chat?: ChatChoice;
  keep?: KeepChoice;
  replyTo?: string;
  contextFromTask?: string;
  conversation?: string;
  schedule: Schedule;
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
  private readonly queue: Queued[] = [];
  private readonly approvals = new Map<string, { view: PendingApproval; runId: string; resolve: (granted: boolean) => void }>();
  private readonly runs = new Map<string, Run>();
  private nextOrder = 0;
  /** Accepted IDs remain reserved across reconnects for this server launch. */
  private readonly acceptedIds = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeRuntime: () => void;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The reply each working turn is writing now: temporary, never saved, sent to a page that joins late. */
  /** Keyed by turn, with the turn's thinking kept beside its reply. */
  private readonly drafts = new Map<string, { runId: string; message: DraftMessage }>();
  private readonly draftsUnsent = new Set<string>();
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly terminals: TerminalPanel;

  private readonly replayMax: number;

  constructor(private readonly runtime: Runtime, options: { replayMax?: number } = {}) {
    this.replayMax = options.replayMax ?? REPLAY_MAX_EVENTS;
    this.terminals = new TerminalPanel(runtime, (message) => this.broadcast(message), (socket, message) => this.send(socket, message));
    this.unsubscribe = runtime.store.onEvent((event) => {
      const activity = activityOf(runtime.store, event);
      // A step that only thought replaces the thinking draft and leaves the reply's.
      if (activity && SETTLES_DRAFT.has(activity.kind) && "turnId" in activity && activity.turnId) this.settleDraft(activity.turnId, activity.kind === "step" && !activity.text);
      // A call's saved result replaces what it printed while it ran.
      if (activity?.kind === "tool_finished") this.dropDraft(draftKey(activity.turnId, { kind: "output", handle: activity.handle }));
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
    const detach = () => { this.clients.delete(socket); this.subscribed.delete(socket); this.terminals.detach(socket); };
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
    this.terminals.close();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.drafts.clear();
    this.draftsUnsent.clear();
    for (const run of this.runs.values()) run.controller.abort();
    for (const item of this.queue) { item.schedule.bind(); item.schedule.finish(); }
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
      settings: this.runtime.settings,
      busy: socrates?.busy ?? false,
      lanes: this.runtime.lanes(),
      working: this.working(),
      queue: this.queue.map((q) => ({ id: q.id, text: q.text, ...(q.attachments.length ? { attachments: q.attachments.map(viewOf) } : {}), ...(q.chat ? { chat: q.chat } : {}), ...(q.replyTo ? {replyTo: q.replyTo} : {}) })),
      approvals: [...this.approvals.values()].map((a) => a.view),
      routingQuestions: this.runtime.store.clarifications().filter(q => q.state === "pending" || q.state === "resuming").map(q => {
        const queued = this.queue.find(item => item.replyTo === q.turnId);
        return queued ? {...q, state: "resuming" as const, answer: queued.text} : q;
      }),
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
        hasWords(command.text, command.attachments);
        return this.start(command.id, command.text, command.to, command.anchorDecisions, false, this.attachments(command.attachments), command.chat, command.keep);
      case "reply": {
        this.assertNewId(command.id);
        hasWords(command.text, undefined);
        const q = this.runtime.store.clarification(command.clarification);
        if (q.state !== "pending" || this.queue.some(item => item.replyTo === q.turnId)) throw new LiveError("clarification_resolved", "That routing question already has a reply.");
        if (q.conversation === "main" && this.socrates().busy) {
          if (this.queue.length >= QUEUE_MAX) throw new LiveError("queue_full", "The queue is full. Try again when a message finishes.");
          this.acceptedIds.add(command.id);
          this.queue.push({id: command.id, text: command.text, attachments: [], replyTo: q.turnId, conversation: q.conversation, schedule: this.schedule()});
          return this.publishState();
        }
        return this.start(command.id, command.text, q.conversation, undefined, false, [], undefined, undefined, undefined, undefined, q.turnId);
      }
      case "cancel_question": {
        const queued = this.queue.find(item => item.replyTo === command.clarification);
        if (queued) { this.queue.splice(this.queue.indexOf(queued), 1); queued.schedule.bind(); queued.schedule.finish(); }
        this.runtime.store.cancelClarification(command.clarification);
        return this.publishState();
      }
      case "queue": {
        this.assertNewId(command.id);
        hasWords(command.text, command.attachments);
        if (this.queue.length >= QUEUE_MAX) throw new LiveError("queue_full", `At most ${QUEUE_MAX} messages can wait for the main conversation.`);
        const attachments = this.attachments(command.attachments);
        this.acceptedIds.add(command.id);
        if (command.keep) this.keptTask(command.keep);
        const schedule = this.schedule();
        const viewed = command.chat ? this.chatTask(command.chat) : null;
        const selected = command.chat?.task != null ? this.chatTarget(command.chat, command.text, attachments.length, new Date(schedule.receivedAt)) : null;
        const contextFromTask = viewed?.general && selected && "taskId" in selected && viewed.id !== selected.taskId ? viewed.id : undefined;
        if (selected && "taskId" in selected) {
          const task = this.runtime.store.requireTask(selected.taskId);
          command.chat = {goal: this.runtime.store.requireGoal(task.goalId).number, task: task.number};
        }
        const taskId = command.chat ? this.chatTask(command.chat)?.id : command.keep ? this.keptTask(command.keep).taskId : undefined;
        if (taskId) { schedule.tasks.add(taskId); schedule.bind(); }
        this.queue.push({ id: command.id, text: command.text, attachments, schedule, ...(contextFromTask ? {contextFromTask} : {}), ...(command.chat ? { chat: command.chat } : {}), ...(command.keep ? { keep: command.keep } : {}) });
        this.publishState();
        return this.drain();
      }
      case "redo": {
        const store = this.runtime.store;
        if (!command.chat === !command.general) throw new LiveError("bad_request", "Choose one place to ask it again.");
        if (!store.getTurn(command.turn)) throw new LiveError("not_found", "That question no longer exists.");
        const { request, attachments } = store.requestForTurn(command.turn);
        let chat = command.chat;
        if (command.general) {
          const today = store.ensureGeneral(this.runtime.timeZone);
          chat = { goal: today.goal.number, task: today.task.number };
        }
        return this.start(command.id, request, "main", undefined, false, attachments, chat, undefined, command.turn);
      }
      case "queue_edit": {
        const item = this.queued(command.id);
        hasWords(command.text, item.attachments);
        item.text = command.text;
        return this.publishState();
      }
      case "queue_remove": {
        const item = this.queued(command.id);
        this.queue.splice(this.queue.indexOf(item), 1);
        item.schedule.bind();
        item.schedule.finish();
        return this.publishState();
      }
      case "queue_to_lane": {
        const item = this.queued(command.id);
        this.start(item.id, item.text, "new_lane", undefined, true, item.attachments);
        this.queue.splice(this.queue.indexOf(item), 1);
        item.schedule.bind();
        item.schedule.finish();
        return this.publishState();
      }
      case "cancel": {
        const task = command.chat ? this.chatTask(command.chat) : null;
        const runs = [...this.runs.values()].filter((r) => {
          if (command.chat) return !!task && r.tasks.has(task.id);
          // Stopping the main conversation leaves the standard-mode chats running beside it.
          if (r.conversation === command.conversation) return !(r.chat && command.conversation === "main");
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
      case "terminal_open":
        return this.terminals.open(socket, command.session);
      case "terminal_shut":
        return this.terminals.shut(socket, command.session);
      case "terminal_input":
        return this.terminals.input(command.session, command.data);
      case "terminal_resize":
        return this.terminals.resize(command.session, command.cols, command.rows);
      case "terminal_dismiss":
        return this.terminals.dismiss(command.session);
      case "terminal_stop":
        return void this.terminals.stop(command.session).catch((error) => this.send(socket, { type: "error", ...problemOf(error) }));
      case "terminal_restart":
        return void this.terminals.restart(command.session).then(
          (next) => this.send(socket, { type: "terminal_restarted", session: command.session, next }),
          (error) => this.send(socket, { type: "error", ...problemOf(error) }),
        );
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
    this.send(socket, { type: "terminals", terminals: this.terminals.list() });
  }

  /** Keep the newest draft of a turn and send it with the next interval's. */
  private draft(runId: string, turnId: string, draft: Draft): void {
    if (this.closed) return;
    const run = this.runs.get(runId);
    const turn = this.runtime.store.getTurn(turnId);
    if (!run || run.controller.signal.aborted || turn?.status !== "in_progress") return;
    const key = draftKey(turnId, draft);
    if ((this.drafts.get(key)?.message.call ?? 0) > draft.call) return;
    const tail = draft.kind === "thinking" && draft.text.length > THINKING_DRAFT_CHARS ? { text: draft.text.slice(-THINKING_DRAFT_CHARS), length: draft.text.length } : {};
    this.drafts.set(key, { runId, message: { type: "draft", conversation: turn.laneId ?? "main", turnId, ...draft, ...tail } });
    this.draftsUnsent.add(key);
    this.draftTimer ??= setTimeout(() => {
      this.draftTimer = null;
      for (const id of this.draftsUnsent) {
        const entry = this.drafts.get(id);
        if (entry) this.broadcast(entry.message);
      }
      this.draftsUnsent.clear();
    }, DRAFT_INTERVAL_MS);
  }

  /** The saved reply replaces a turn's drafts (or only its thinking); a draft not yet sent is dropped with it. */
  private settleDraft(turnId: string, thinkingOnly = false): void {
    if (thinkingOnly) return this.dropDraft(draftKey(turnId, { kind: "thinking" }));
    for (const key of [...this.drafts.keys()]) if (key === turnId || key.startsWith(`${turnId}:`)) this.dropDraft(key);
  }

  private dropDraft(key: string): void {
    this.drafts.delete(key);
    this.draftsUnsent.delete(key);
  }

  /** Start one message: in main (refused while main is busy; queue it instead), a new lane, or an open lane. */
  /** The stored images a message names; every one must exist. */
  private attachments(named: { id: string; name: string }[] | undefined): Attachment[] {
    return (named ?? []).map(({ id, name }) => {
      const found = findAttachment(this.runtime.config.attachmentsDir, id, name);
      if (!found) throw new LiveError("attachment_missing", `The attached image ${name} is no longer stored; attach it again.`);
      return found;
    });
  }

  private start(id: string, text: string, to: string, anchorDecisions?: AnchorDecision[], fromQueue = false, attachments: Attachment[] = [], chat?: ChatChoice, keep?: KeepChoice, redoOf?: string, queuedSchedule?: Schedule, replyTo?: string, contextFromTaskOverride?: string): void {
    const socrates = this.socrates();
    if (!fromQueue) this.assertNewId(id);
    if ((chat || keep) && to !== "main") throw new LiveError("bad_request", "A message for a chosen chat or task is sent in the main conversation.");
    if (chat && keep) throw new LiveError("bad_request", "A message goes to a chosen chat or is kept in a task, not both.");
    const viewed = chat ? this.chatTask(chat) : null;
    const target = chat ? this.chatTarget(chat, text, attachments.length, new Date(queuedSchedule?.receivedAt ?? this.runtime.store.clock.now())) : keep ? this.keptTask(keep) : undefined;
    const contextFromTask = contextFromTaskOverride ?? (viewed?.general && target && "taskId" in target && viewed.id !== target.taskId ? viewed.id : undefined);
    if (viewed?.general && target && "taskId" in target) {
      const task = this.runtime.store.requireTask(target.taskId);
      chat = {goal: this.runtime.store.requireGoal(task.goalId).number, task: task.number};
    }
    const refused = redoOf ? socrates.redoProblem(redoOf, target && "taskId" in target ? target.taskId : null) : null;
    if (refused) throw new LiveError("redo_refused", refused);
    // A chat runs beside the main conversation, one message at a time: while it works, or another chat message waits for it, this one waits in the queue.
    if (chat && (this.chatWorking(chat, queuedSchedule?.order) || (!fromQueue && chat.task !== null && this.queue.some((q) => q.chat && sameChat(q.chat, chat))))) throw new LiveError("chat_busy", "Socrates is working in this chat; queue this message.");
    if (chat && socrates.runningChats >= MAX_RUNNING_CHATS) throw new LiveError("chat_busy", `${MAX_RUNNING_CHATS} chats are already working; queue this message.`);
    if (to !== "main" && to !== "new_lane") {
      const lane = this.runtime.store.getLane(to);
      if (!lane || lane.closedAt) throw new LiveError("lane_closed", "That lane is closed.");
    }
    if (to === "main" && !chat && socrates.busy) throw new LiveError("main_busy", "Socrates is working in the main conversation; queue this message or send it in a lane.");
    const running = socrates.lanes().filter((l) => l.running);
    if (to !== "main" && !running.some((l) => l.id === to) && running.length >= MAX_RUNNING_LANES) {
      throw new LiveError("lane_limit", `${MAX_RUNNING_LANES} lanes are already working; wait for one to finish or stop one.`);
    }
    const schedule = queuedSchedule ?? this.schedule();
    if (target && "taskId" in target) schedule.tasks.add(target.taskId);
    const run: Run = { id, conversation: to === "new_lane" ? "starting" : to, chat: !!chat, tasks: schedule.tasks, schedule, controller: new AbortController() };
    this.acceptedIds.add(id);
    this.runs.set(id, run);
    const work = socrates.handle(text, {
      signal: run.controller.signal,
      newRequest: !replyTo,
      receivedAt: schedule.receivedAt,
      ...(replyTo ? {replyTo} : {}),
      ...(contextFromTask ? {contextFromTask} : {}),
      ...(attachments.length ? { attachments } : {}),
      approve: (request, origin) => this.ask(run, request, origin),
      ...(to === "main" ? {} : { lane: to === "new_lane" ? "new" : to }),
      ...(anchorDecisions?.length ? { anchorDecisions } : {}),
      // Standard mode: no routing, a chat that never rolls over, and one that runs beside the others. A message kept in its task is not routed, and rolls over as usual.
      ...(target ? (keep ? { target, pinned: true } : { target, rollover: false, alongside: true }) : {}),
      ...(redoOf ? { redoOf } : {}),
      beforeBind: (taskIds, signal) => this.beforeBind(run, taskIds, signal),
      onRecorded: (userEventId) => { if (target || replyTo) run.seq = this.runtime.store.requestRoot(userEventId).seq; },
      onBound: (turnId, taskId) => {
        run.tasks.add(taskId);
        schedule.bind();
        run.seq ??= this.runtime.store.requestRoot(this.runtime.store.requireTurn(turnId).userEventId).seq;
        this.scheduleState();
      },
      onLane: (laneId) => {
        run.conversation = laneId;
        this.broadcast({ type: "accepted", id, conversation: laneId });
      },
      onHandoff: (laneId, turnId) => {
        run.handedTurnId = turnId;
        // Single-part handoffs free main. A compound message still owns it. A chat never held it.
        if (run.chat || !socrates.busy) run.conversation = laneId;
        if (run.conversation === laneId) schedule.handOff();
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
    if (to !== "new_lane") this.broadcast({ type: "accepted", id, conversation: to, ...(run.seq ? { seq: run.seq } : {}) });
    this.publishState();
    run.settled = work
      .then((result) => {
        this.broadcast({ type: "result", id, conversation: run.conversation, result: summary(result) });
        const part = result.kind === "answered" ? result.parts[0] : undefined;
        if (target && !("taskId" in target) && part?.status === "completed") this.runtime.nameChat(part.turn, part.answer);
      })
      .catch((error) => {
        if (!(error instanceof SocratesBusyError)) this.runtime.log(`message ${id} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        this.broadcast({ type: "error", id, conversation: run.conversation, ...problemOf(error) });
      })
      .finally(() => {
        this.runs.delete(id);
        schedule.bind();
        schedule.finish();
        for (const entry of [...this.drafts.values()]) if (entry.runId === id) this.settleDraft(entry.message.turnId);
        // An approval the run never got an answer for is refused.
        for (const [key, approval] of this.approvals) if (approval.runId === id) {
          this.approvals.delete(key);
          approval.resolve(false);
        }
        this.publishState();
        this.drain();
      });
  }

  /** Where a standard-mode message goes: a chat of a goal, or a new chat named for now by its first words. */
  private chatTarget(chat: ChatChoice, text: string, images: number, at = this.runtime.store.clock.now()): { taskId: string } | { goalId: string; title: string } {
    const store = this.runtime.store;
    const goal = chat.goal === null ? this.runtime.chatsGoal() : store.getGoalByNumber(chat.goal);
    if (!goal || goal.archivedAt || (goal.general && chat.task === null)) throw new LiveError("not_found", "That goal no longer exists.");
    if (chat.task === null) return { goalId: goal.id, title: provisionalTitle(text, images) };
    const task = store.getTaskByNumber(goal.id, chat.task);
    if (!task || task.archivedAt) throw new LiveError("not_found", "That chat no longer exists.");
    return { taskId: task.general ? store.ensureGeneral(this.runtime.timeZone, at).task.id : task.id };
  }

  /** A standard-mode chat's task, without making the Chats goal; null for a new chat or one that is gone. */
  private chatTask(chat: ChatChoice) {
    const store = this.runtime.store;
    const number = chat.goal ?? this.runtime.chatsGoalNumber();
    const goal = number === null || chat.task === null ? null : store.getGoalByNumber(number);
    return goal ? store.getTaskByNumber(goal.id, chat.task!) : null;
  }

  /** Whether a message is working (or waiting) in this chat's task now, in any conversation. */
  private chatWorking(chat: ChatChoice, before = Infinity): boolean {
    const task = this.chatTask(chat);
    return !!task && (!!this.runtime.socrates?.taskBusy(task.id) || [...this.runs.values()].some((r) => r.schedule.order < before && r.tasks.has(task.id)));
  }

  private schedule(): Schedule {
    let bind!: () => void, finish!: () => void, handOff!: () => void;
    return { receivedAt: this.runtime.store.clock.now().toISOString(), order: ++this.nextOrder, tasks: new Set(), bound: new Promise<void>((resolve) => { bind = resolve; }), bind,
      done: new Promise<void>((resolve) => { finish = resolve; }), finish,
      handedOff: new Promise<void>((resolve) => { handOff = resolve; }), handOff };
  }

  /** Do not reserve the task ahead of an older message still in the host's queue or router. */
  private async beforeBind(run: Run, taskIds: string[], signal: AbortSignal): Promise<void> {
    for (const id of taskIds) run.tasks.add(id);
    run.schedule.bind();
    this.scheduleState();
    // Lanes keep their own FIFO and handoff rules in the harness.
    if (run.conversation !== "main") return;
    const earlier = [
      ...[...this.runs.values()].filter((r) => r.conversation === "main").map((r) => r.schedule),
      ...this.queue.map((q) => q.schedule),
    ].filter((s) => s.order < run.schedule.order);
    await abortable(Promise.all(earlier.map(async (s) => {
      await s.bound;
      if (taskIds.some((id) => s.tasks.has(id))) await Promise.race([s.done, s.handedOff]);
    })), signal);
  }

  /** The tasks with a message working in them now, as goal and task numbers, so a page knows which chats are busy. */
  private working(): { goal: number; task: number }[] {
    const store = this.runtime.store;
    const tasks = new Set([...this.runs.values()].flatMap((r) => [...r.tasks]));
    return [...tasks].flatMap((id) => {
      const task = store.getTask(id);
      const goal = task ? store.getGoal(task.goalId) : null;
      return task && goal ? [{ goal: goal.number, task: task.number }] : [];
    });
  }

  /** The task a message is kept in: one of a goal that is still there, and never the general conversation. */
  private keptTask(keep: KeepChoice): { taskId: string } {
    const store = this.runtime.store;
    const goal = store.getGoalByNumber(keep.goal);
    const task = goal && !goal.general && !goal.archivedAt ? store.getTaskByNumber(goal.id, keep.task) : null;
    if (!task || task.archivedAt) throw new LiveError("not_found", "That task no longer exists.");
    return { taskId: task.id };
  }

  /**
   * Start what can start, in order: the main conversation's next message once
   * it is free, and each chat's next message once that chat is free (and
   * fewer than MAX_RUNNING_CHATS chats work). A message waits behind earlier
   * ones for the same place; a new chat has a place of its own.
   */
  private drain(): void {
    const socrates = this.runtime.socrates;
    if (this.closed || !this.runtime.acceptingMessages || !socrates || !this.queue.length) return;
    const seen = new Set<string>();
    let started = false;
    for (const next of [...this.queue]) {
      const place = next.chat ? (next.chat.task === null ? next.id : `${next.chat.goal ?? "chats"}/${next.chat.task}`) : "main";
      if (seen.has(place)) continue;
      seen.add(place);
      const free = next.chat ? socrates.runningChats < MAX_RUNNING_CHATS && !this.chatWorking(next.chat, next.schedule.order) : !socrates.busy;
      if (!free) continue;
      this.queue.splice(this.queue.indexOf(next), 1);
      started = true;
      try {
        this.start(next.id, next.text, next.conversation ?? "main", undefined, true, next.attachments, next.chat, next.keep, undefined, next.schedule, next.replyTo, next.contextFromTask);
      } catch (error) {
        next.schedule.bind();
        next.schedule.finish();
        this.broadcast({ type: "error", id: next.id, conversation: "main", ...problemOf(error) });
      }
    }
    if (started) this.publishState();
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

  private queued(id: string): Queued {
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

const sameChat = (a: ChatChoice, b: ChatChoice) => a.goal === b.goal && a.task === b.task;

/** A message must say something or carry an image; its text is kept exactly as sent. */
function hasWords(text: string, attachments: readonly unknown[] | undefined): void {
  if (!text.trim() && !attachments?.length) throw new LiveError("empty_message", "Write a message or attach an image.");
}

function problemOf(error: unknown): { code: string; message: string } {
  if (error instanceof LiveError || error instanceof TerminalPanelError) return { code: error.code, message: error.message };
  if (error instanceof SocratesBusyError) return { code: error.reason, message: error.message };
  if (error instanceof RedoError) return { code: "redo_refused", message: error.message };
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
