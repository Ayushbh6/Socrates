import type { Activity, AttachmentView, CallView, HistoryItem, KeepChoice, LiveState, PendingApproval, Place, ResultView, ServerMessage } from "./types";

/**
 * What the page knows, built from history pages and the live connection
 * (architecture/web.md, "Conversations"). Pure, so every rule is testable.
 */

export type Step =
  | { kind: "step"; text: string }
  /**
   * The model's readable thinking for one request; `truncated` when the server
   * cut it, `seq` names the step to fetch all of it, and `ms` is how long the
   * request took, from the work before it.
   */
  | { kind: "thinking"; text: string; truncated: boolean; seq: number; ms: number | null }
  /** A tool call in plain words, and once it finished, what it returned. */
  | { kind: "tool"; handle: string; task: string; turnId: string; call: CallView; status: "running" | "ok" | "error"; result: ResultView | null; at: string }
  | { kind: "handed_off"; lane: number }
  | { kind: "warning"; detail: string }
  | { kind: "decision"; granted: boolean; detail: string };

/**
 * The reply a turn is writing now, as far as it has arrived: the line before
 * tool calls, the answer, or the model's thinking. Temporary; the saved
 * narration, answer or thinking replaces it (architecture/web.md, "Streaming").
 */
export interface Draft {
  turnId: string;
  /** The model request it came from; a retried or repaired request is a later one. */
  call: number;
  kind: "narration" | "answer" | "thinking" | "output";
  text: string;
  /** The full length when `text` is only the end of a long thought. */
  length?: number;
}

/** One question and everything Socrates did for it. */
export interface Exchange {
  /** "m<seq>" once the server saved the message; "c<id>" while it is being sent. */
  key: string;
  conversation: string;
  seq: number | null;
  at: string;
  message: string;
  /** Images the user attached to the message. */
  attachments: AttachmentView[];
  /** The goal and task of its first part. */
  route: { goal: { number: number; title: string }; task: { number: number; title: string }; chat?: number } | null;
  steps: Step[];
  answers: string[];
  draft: Draft | null;
  /** The model's thinking as it arrives, kept beside the reply's draft. */
  thinking: Draft | null;
  /** When the latest work (thinking, narration or a tool) was saved, for "Worked for". */
  workedAt: string | null;
  /** When anything last happened in this exchange's work (routing included), for how long thinking took. */
  lastAt: string | null;
  /** What each running tool call has printed so far, by "<turn>:<handle>"; its result replaces it. */
  outputs: Record<string, string>;
  /** Keep a request's watermark after its visible draft has been saved (thinking under "<turn>:thinking"). */
  draftCalls: Record<string, { call: number; settled: boolean }>;
  /** Events already included in this exchange's history snapshot. */
  throughSeq: number;
  /** The router's clarifying question, instead of work. */
  question: string | null;
  state: "sending" | "working" | "done" | "stopped" | "failed";
  /** Why it stopped or failed, or the split acknowledgment while it works. */
  note: string | null;
  /** The page's id for a message this page sent. */
  sendId: string | null;
  /** The safeguard that ended its work (steps, time or tokens): the answer says what was done so far, and it can be continued. */
  limit: Limit | null;
  /** Where its question was asked again, once the user redid it in another task; it is then set aside. */
  redoneTo: Place | null;
  /** For a redo: where its question was first asked. */
  redoneFrom: Place | null;
  /** What its answer saved to or forgot from memory, and whether a saved one was undone since. */
  memories: MemoryNote[];
  turns: string[];
  /** Turns still working. */
  open: string[];
}

/** A per-turn safeguard that ends the work early (architecture/agent-harness.md, "Safety and long-running work"). */
export type Limit = "steps" | "time" | "tokens";

/** What Continue sends: an ordinary message, so the turn picks up from the saved work and continuation note. */
export const CONTINUE_MESSAGE = "Please continue from where you stopped.";

/**
 * Where Continue sends in flow mode: in the main conversation, the same task
 * without routing (the server only keeps a message in a task the user can
 * see, not in General, whose day task only the router chooses, so there it
 * is routed as usual); in a lane, the lane itself carries it.
 */
export function continueKeep(exchange: Exchange, conversation: string, goals: { number: number; general: boolean }[]): KeepChoice | undefined {
  const route = exchange.route;
  if (conversation !== "main" || !route || goals.find((g) => g.number === route.goal.number)?.general) return undefined;
  return { goal: route.goal.number, task: route.task.number };
}

/** The limit a turn's stop names, or null for a final answer (or the context ceiling, which continuing would meet again). */
export function limitOf(stop: string | null | undefined): Limit | null {
  return stop === "steps" || stop === "time" || stop === "tokens" ? stop : null;
}

/** One memory change shown under an answer: "Remembered: …" (with Undo), or "Forgot: …". */
export interface MemoryNote {
  number: number;
  text: string;
  /** Saved by this answer. */
  saved: boolean;
  /** Forgotten: by this answer, or undone since. */
  forgotten: boolean;
}

export interface Model {
  live: LiveState | null;
  /** "main" and each lane id, oldest exchange first. */
  conversations: Record<string, Exchange[]>;
  /** Messages sent to a new lane, until the server names it. */
  pending: Exchange[];
  notices: { id: number; text: string }[];
  /** The newest event this page has applied. */
  seq: number;
}

export const emptyModel = (): Model => ({ live: null, conversations: { main: [] }, pending: [], notices: [], seq: 0 });

export type ModelEvent =
  | { type: "history"; conversation: string; items: HistoryItem[]; older?: boolean }
  | { type: "server"; message: ServerMessage }
  | { type: "sent"; id: string; text: string; to: string; at: string; attachments?: AttachmentView[] }
  | { type: "unsent"; id: string }
  | { type: "dismiss"; id: number };

let noticeId = 0;

export function reduce(model: Model, event: ModelEvent): Model {
  switch (event.type) {
    case "history": {
      const loaded = event.items.map((item) => fromHistory(item, event.conversation)).reverse();
      const current = model.conversations[event.conversation] ?? [];
      const known = new Set(current.map((e) => e.seq));
      const fresh = loaded.filter((e) => !known.has(e.seq));
      return withConversation(model, event.conversation, event.older ? [...fresh, ...current] : [...current, ...fresh].sort(bySeq));
    }
    case "sent": {
      const exchange = blank({ key: `c${event.id}`, conversation: event.to, at: event.at, message: event.text, attachments: event.attachments ?? [], state: "sending", sendId: event.id });
      if (event.to === "new_lane") return { ...model, pending: [...model.pending, exchange] };
      return withConversation(model, event.to, [...(model.conversations[event.to] ?? []), exchange]);
    }
    case "unsent":
      return mapSent(model, event.id, () => null);
    case "dismiss":
      return { ...model, notices: model.notices.filter((n) => n.id !== event.id) };
    case "server":
      return serverMessage(model, event.message);
  }
}

function serverMessage(model: Model, message: ServerMessage): Model {
  switch (message.type) {
    case "state": {
      const { type: _type, ...live } = message;
      // State may precede replay; only applied activities advance the resume cursor.
      return { ...model, live };
    }
    case "activity":
      return { ...activity(model, message), seq: Math.max(model.seq, message.seq) };
    case "accepted": {
      const index = model.pending.findIndex((e) => e.sendId === message.id);
      if (index < 0) {
        // A message this page queued, started later: its saved question becomes this page's.
        const list = model.conversations[message.conversation] ?? [];
        return message.seq !== undefined && list.some((e) => e.seq === message.seq && !e.sendId)
          ? withConversation(model, message.conversation, list.map((e) => (e.seq === message.seq && !e.sendId ? { ...e, sendId: message.id } : e)))
          : model;
      }
      const exchange = { ...model.pending[index]!, conversation: message.conversation };
      const pending = model.pending.filter((_, i) => i !== index);
      return withConversation({ ...model, pending }, message.conversation, [...(model.conversations[message.conversation] ?? []), exchange]);
    }
    case "draft":
      // A draft is not an event: it never moves the page's place in the log.
      return activity(model, { kind: "draft", seq: model.seq, at: new Date().toISOString(), conversation: message.conversation, turnId: message.turnId, call: message.call, draftKind: message.kind, text: message.text, ...(message.length ? { length: message.length } : {}), ...(message.handle ? { handle: message.handle } : {}) });
    case "status":
      return mapSent(model, message.id, (e) => ({ ...e, note: message.text }));
    case "error":
      return message.id ? mapSent(model, message.id, (e) => (e.state === "sending" ? { ...e, state: "failed", note: message.message } : e)) : model;
    case "result":
      return message.result.notices.length ? { ...model, notices: [...model.notices, ...message.result.notices.map((text) => ({ id: ++noticeId, text }))] } : model;
    default:
      return model;
  }
}

/** A draft, shaped like the activities it is placed with. */
type DraftArrived = { kind: "draft"; seq: number; at: string; conversation: string; turnId: string; call: number; draftKind: Draft["kind"]; text: string; length?: number; handle?: string };

function activity(model: Model, a: Activity | DraftArrived): Model {
  if (a.kind === "ledger") return model;
  if (a.kind === "lane") {
    if (a.state === "opened" && !model.conversations[a.laneId]) return withConversation(model, a.laneId, []);
    return model;
  }
  const list = model.conversations[a.conversation] ?? [];
  if (a.kind === "message") {
    const existing = list.findIndex((e) => e.seq === a.seq);
    if (existing >= 0 && a.seq <= list[existing]!.throughSeq) return model;
    // A replayed message is rebuilt from its events.
    if (existing >= 0) return withConversation(model, a.conversation, list.map((e, i) => (i === existing ? blank({ ...e, steps: [], answers: [], draft: null, thinking: null, workedAt: null, lastAt: null, outputs: {}, draftCalls: {}, question: null, state: "working", note: null, turns: [], open: [] }) : e)));
    const sending = list.findIndex((e) => e.state === "sending" && e.message === a.text);
    const saved = { key: `m${a.seq}`, seq: a.seq, at: a.at, state: "working" as const };
    if (sending >= 0) return withConversation(model, a.conversation, list.map((e, i) => (i === sending ? { ...e, ...saved } : e)));
    // A new lane's first message can be saved before the server says which lane it went to.
    const waiting = model.pending.findIndex((e) => e.message === a.text);
    if (waiting >= 0) {
      const adopted = { ...model.pending[waiting]!, ...saved, conversation: a.conversation };
      return withConversation({ ...model, pending: model.pending.filter((_, i) => i !== waiting) }, a.conversation, [...list, adopted]);
    }
    return withConversation(model, a.conversation, [...list, blank({ ...saved, conversation: a.conversation, message: a.text, attachments: a.attachments ?? [] })]);
  }
  const turnId = a.turnId;
  let index = turnId ? list.findLastIndex((e) => e.turns.includes(turnId)) : -1;
  // Chats working at once: a new turn belongs to the message it answers, not merely the newest one.
  if (index < 0 && a.kind === "routed" && a.messageSeq != null) index = list.findIndex((e) => e.seq === a.messageSeq);
  let next = list;
  // A draft, or a redo of a question not loaded here, has nothing to join.
  if ((a.kind === "draft" || a.kind === "redone" || a.kind === "memory") && index < 0) return model;
  if (index < 0) {
    index = list.findLastIndex((e) => e.state !== "sending");
    const last = list[index];
    // A turn handed over from the main conversation starts its own exchange in the lane.
    if (turnId && (!last || (last.state !== "working" && last.open.length === 0))) {
      const origin = (model.conversations.main ?? []).find((e) => e.turns.includes(turnId));
      next = [...list, blank({ key: `t${turnId}`, conversation: a.conversation, at: a.at, message: origin?.message ?? "Handed over from the main conversation.", attachments: origin?.attachments ?? [], state: "working" })];
      index = next.length - 1;
    }
  }
  if (index < 0) return model;
  if (a.kind !== "draft" && a.seq <= next[index]!.throughSeq) return model;
  const updated = apply(next[index]!, a);
  let result = withConversation(model, a.conversation, next.map((e, i) => (i === index ? updated : e)));
  if (a.kind === "handed_off") {
    const laneId = a.laneId ?? model.live?.lanes.find((lane) => lane.number === a.lane)?.id;
    if (laneId) {
      const lane = result.conversations[laneId] ?? [];
      if (!lane.some((e) => e.turns.includes(a.turnId))) {
        result = withConversation(result, laneId, [...lane, blank({key: `t${a.turnId}`, conversation: laneId, at: a.at, message: updated.message, attachments: updated.attachments,
          route: a.goal && a.task ? {goal:a.goal,task:a.task} : updated.route, turns:[a.turnId], open:[a.turnId] })]);
      }
    }
  }
  return result;
}

/** The saved narration, answer or question, or the end of the turn, replaces its draft. */
const SETTLES_DRAFT = new Set(["step", "answer", "question", "finished", "handed_off"]);

const thinkingKey = (turnId: string) => `${turnId}:thinking`;

function apply(e: Exchange, a: Activity | DraftArrived): Exchange {
  const next = applyOne(e, a);
  if (SETTLES_DRAFT.has(a.kind) && "turnId" in a && a.turnId) {
    // A step that only thought replaces the thinking draft and leaves the reply's, such as an answer still being written.
    const onlyThinking = a.kind === "step" && !a.text;
    const keys = onlyThinking ? [thinkingKey(a.turnId)] : [a.turnId, thinkingKey(a.turnId)];
    const draftCalls = { ...next.draftCalls };
    for (const key of keys) if (draftCalls[key]) draftCalls[key] = { ...draftCalls[key]!, settled: true };
    return { ...next,
      draft: !onlyThinking && next.draft?.turnId === a.turnId ? null : next.draft,
      thinking: next.thinking?.turnId === a.turnId ? null : next.thinking,
      draftCalls,
    };
  }
  return next;
}

function applyOne(e: Exchange, a: Activity | DraftArrived): Exchange {
  if (a.kind === "draft" && a.draftKind === "output") {
    // Only while its call runs: the result replaces it.
    const running = e.steps.some((s) => s.kind === "tool" && s.turnId === a.turnId && s.handle === a.handle && s.status === "running");
    return running && e.state === "working" ? { ...e, outputs: { ...e.outputs, [`${a.turnId}:${a.handle}`]: a.text } } : e;
  }
  if (a.kind === "draft") {
    if (e.turns.includes(a.turnId) && !e.open.includes(a.turnId)) return e;
    if (e.state !== "working" && e.state !== "sending") return e;
    const thinking = a.draftKind === "thinking";
    const previous = e.draftCalls[thinking ? thinkingKey(a.turnId) : a.turnId];
    if (previous && (a.call < previous.call || (a.call === previous.call && previous.settled))) return e;
    const shown = thinking ? e.thinking : e.draft;
    if (shown?.turnId === a.turnId && shown.call === a.call && shown.kind === a.draftKind && (shown.length ?? shown.text.length) > (a.length ?? a.text.length)) return e;
  }
  const turnId = "turnId" in a ? a.turnId : null;
  const seen = turnId && !e.turns.includes(turnId) ? { turns: [...e.turns, turnId], open: [...e.open, turnId] } : {};
  const x = { ...e, ...seen };
  switch (a.kind) {
    case "draft": {
      // A later request's draft replaces the earlier one; a stale one is ignored. Thinking has its own place.
      const thinking = a.draftKind === "thinking";
      const shown = thinking ? x.thinking : x.draft;
      if (shown?.turnId === a.turnId && shown.call > a.call) return x;
      const draft = { turnId: a.turnId, call: a.call, kind: a.draftKind, text: a.text, ...(a.length ? { length: a.length } : {}) };
      return { ...x, draftCalls: { ...x.draftCalls, [thinking ? thinkingKey(a.turnId) : a.turnId]: { call: a.call, settled: false } }, ...(thinking ? { thinking: draft } : { draft }) };
    }
    case "routed":
      return { ...x, route: x.route ?? { goal: a.goal, task: a.task, chat: a.chat }, redoneFrom: x.redoneFrom ?? a.redoneFrom ?? null, lastAt: a.at };
    case "redone":
      return { ...e, redoneTo: a.to };
    case "memory": {
      // Changes made later on the Memory page arrive on the turn the memory was said in.
      const known = e.memories.find((m) => m.number === a.memory.number);
      const note = { number: a.memory.number, text: a.memory.text, saved: (known?.saved ?? false) || a.change === "saved", forgotten: (known?.forgotten ?? false) || a.change === "forgotten" };
      if (!known && a.change === "edited") return e;
      return { ...e, memories: known ? e.memories.map((m) => (m === known ? note : m)) : [...e.memories, note] };
    }
    case "question":
      return { ...x, question: a.text, state: "done", open: x.open.filter((t) => t !== a.turnId) };
    case "step": {
      // The request's thinking comes before what it said.
      const ms = Date.parse(a.at) - Date.parse(x.lastAt ?? x.at);
      const steps: Step[] = [
        ...(a.thinking ? [{ kind: "thinking" as const, text: a.thinking, truncated: a.thinkingTruncated ?? false, seq: a.seq, ms: Number.isFinite(ms) && ms >= 0 ? ms : null }] : []),
        ...(a.text ? [{ kind: "step" as const, text: a.text }] : []),
      ];
      return { ...x, steps: [...x.steps, ...steps], workedAt: a.at, lastAt: a.at };
    }
    case "tool_started":
      return { ...x, steps: [...x.steps, { kind: "tool", handle: a.handle, task: a.task, turnId: a.turnId, call: a.call, status: "running", result: null, at: a.at }], workedAt: a.at, lastAt: a.at };
    case "tool_finished": {
      const { [`${a.turnId}:${a.handle}`]: _printed, ...outputs } = x.outputs;
      return { ...x, steps: x.steps.map((s) => (s.kind === "tool" && s.handle === a.handle && s.task === a.task ? { ...s, status: a.status, result: a.result } : s)), outputs, workedAt: a.at, lastAt: a.at };
    }
    case "answer":
      return { ...x, answers: [...x.answers, a.text] };
    case "handed_off": {
      // The lane works on it now; the main conversation's part of it is over.
      const open = x.open.filter((t) => t !== a.turnId);
      return { ...x, steps: [...x.steps, { kind: "handed_off", lane: a.lane }], open, state: open.length ? x.state : "done" };
    }
    case "warning":
      return { ...x, steps: [...x.steps, { kind: "warning", detail: a.detail }] };
    case "approval_decided":
      return { ...x, steps: [...x.steps, { kind: "decision", granted: a.granted, detail: a.detail }] };
    case "finished": {
      const open = x.open.filter((t) => t !== a.turnId);
      const outputs = Object.fromEntries(Object.entries(x.outputs).filter(([key]) => !key.startsWith(`${a.turnId}:`)));
      // A stopped answer keeps what had been written, in the place its draft had.
      const answers = a.status === "interrupted" && a.partial ? [...x.answers, a.partial] : x.answers;
      if (a.status === "interrupted") return { ...x, answers, open, outputs, state: open.length ? x.state : "stopped", note: stopReason(a.reason) };
      return { ...x, open, outputs, limit: limitOf(a.stop), state: open.length || x.state === "stopped" ? x.state : "done" };
    }
    default:
      return x;
  }
}

function stopReason(reason: string | null): string {
  if (reason === "restarted") return "Stopped when Socrates restarted.";
  if (reason === "cancelled") return "Stopped.";
  return "Stopped before it finished.";
}

export function fromHistory(item: HistoryItem, conversation: string): Exchange {
  const first = item.parts[0];
  const working = item.unrouted || item.parts.some((p) => p.status === "in_progress" && !p.handedOff);
  const interrupted = item.parts.find((p) => p.interrupted);
  let exchange = blank({
    key: `m${item.seq}`,
    conversation,
    seq: item.seq,
    at: item.at,
    message: item.message,
    attachments: item.attachments ?? [],
    route: first ? { goal: first.goal, task: first.task, chat: first.chat } : null,
    steps: item.parts.flatMap((p): Step[] => (p.handedOff && p.lane !== null ? [{ kind: "handed_off" as const, lane: p.lane }] : [])),
    answers: item.parts.flatMap((p) => (p.answer ? [p.answer] : [])),
    question: item.question,
    state: working ? "working" : interrupted ? "stopped" : "done",
    note: interrupted ? stopReason(interrupted.interrupted) : null,
    limit: limitOf(item.parts.at(-1)?.stop),
    turns: item.parts.flatMap((p) => p.turnId ? [p.turnId] : []),
    open: item.parts.flatMap((p) => p.turnId && p.status === "in_progress" && !p.handedOff ? [p.turnId] : []),
    throughSeq: item.throughSeq ?? 0,
  });
  // Its narration, thinking and tool calls, as they happened.
  for (const a of item.activities ?? []) exchange = apply(exchange, a);
  return exchange;
}

function blank(e: Partial<Exchange> & Pick<Exchange, "key" | "conversation" | "at" | "message">): Exchange {
  return { seq: null, attachments: [], route: null, steps: [], answers: [], draft: null, thinking: null, workedAt: null, lastAt: null, outputs: {}, draftCalls: {}, throughSeq: 0, question: null, state: "working", note: null, limit: null, sendId: null, redoneTo: null, redoneFrom: null, memories: [], turns: [], open: [], ...e };
}

function bySeq(a: Exchange, b: Exchange): number {
  return (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER);
}

function withConversation(model: Model, conversation: string, list: Exchange[]): Model {
  return { ...model, conversations: { ...model.conversations, [conversation]: list } };
}

/** Change (or with null, remove) the exchange of a message this page sent, wherever it is. */
function mapSent(model: Model, id: string, change: (e: Exchange) => Exchange | null): Model {
  const edit = (list: Exchange[]) => list.flatMap((e) => (e.sendId === id ? [change(e)].filter((x): x is Exchange => x !== null) : [e]));
  return { ...model, pending: edit(model.pending), conversations: Object.fromEntries(Object.entries(model.conversations).map(([k, list]) => [k, edit(list)])) };
}

/**
 * Where to resume the live connection after loading history: from just
 * before the oldest unfinished message, which the replay rebuilds with its
 * steps; otherwise from the status the history was read at.
 */
export function replayFrom(histories: HistoryItem[][], statusSeq: number): number {
  const working = histories.flatMap((items) => items.filter((i) => i.unrouted || i.parts.some((p) => p.status === "in_progress" && !p.handedOff)));
  return working.length ? Math.min(...working.map((i) => i.seq)) - 1 : statusSeq;
}

/** How the orb shows an exchange (architecture/web.md, "The orb"). */
export type OrbState = "idle" | "thinking" | "working" | "waiting" | "done" | "stopped";

export function orbState(exchange: Exchange | null, approvals: PendingApproval[]): OrbState {
  if (!exchange) return "idle";
  if (exchange.state === "failed" || exchange.state === "stopped") return "stopped";
  if (exchange.state === "done") return "done";
  // Its own turn's approval; one without a turn belongs to the conversation.
  if (approvals.some((a) => (a.turnId ? exchange.turns.includes(a.turnId) : a.conversation === exchange.conversation))) return "waiting";
  return exchange.steps.length || exchange.answers.length || exchange.draft || exchange.thinking ? "working" : "thinking";
}

/** The orb sits in the middle until the answer starts, then docks where the answer begins. */
export const orbDocked = (state: OrbState) => state !== "idle" && state !== "thinking";

/** The goal and task of the newest routed question of a conversation, for its notes and panels. */
export function currentRoute(list: Exchange[]): Exchange["route"] {
  return [...list].reverse().find((e) => e.route)?.route ?? null;
}

/** One line below a thread for what the work itself does not show: an approval to give, a message being sent. */
export function workLine(state: OrbState, exchange: Exchange | null): string | null {
  if (state === "waiting") return "Waiting for your approval";
  return exchange?.state === "sending" ? "Sending…" : null;
}

/** Whether a standard-mode chat has a message working in it now. */
export function chatBusy(live: LiveState | null, chat: { goal: number | null; task: number | null } | undefined): boolean {
  if (!live || !chat || chat.goal === null || chat.task === null) return false;
  return (live.working ?? []).some((w) => w.goal === chat.goal && w.task === chat.task);
}

/** Whether a conversation is working now. */
export function conversationBusy(live: LiveState | null, conversation: string): boolean {
  if (!live) return false;
  return conversation === "main" ? live.busy : live.lanes.some((l) => l.id === conversation && l.running);
}

/**
 * What Enter does: a message to main waits in the queue while main works;
 * a lane queues its own messages, so they are sent.
 */
export function sendTarget(conversation: string, mainBusy: boolean): "send" | "queue" {
  return conversation === "main" && mainBusy ? "queue" : "send";
}

/**
 * The question the Flow canvas shows: the one chosen in the sidebar while it
 * exists, else a message just sent to a new lane, else the newest. Sending
 * clears the choice, so a message written while an earlier question is shown
 * is appended after the last one, and the canvas follows it.
 */
export function viewedExchange(list: Exchange[], selected: string | null, pendingLane: Exchange | null = null): Exchange | null {
  return pendingLane ?? (selected ? list.find((e) => e.key === selected) : null) ?? list.at(-1) ?? null;
}

/** The time of day a question was asked, for its row in the sidebar: "7:35 PM". */
export function asked(at: string, locale?: string, timeZone?: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

/** The sidebar's heading for the day a question was asked: Today, Yesterday, then "4 October" (with the year when it is not this one). */
export function dayLabel(at: string, now: Date = new Date(), locale?: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(locale, { day: "numeric", month: "long", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
