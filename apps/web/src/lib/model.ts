import type { Activity, HistoryItem, LiveState, PendingApproval, ServerMessage } from "./types";

/**
 * What the page knows, built from history pages and the live connection
 * (architecture/web.md, "Conversations"). Pure, so every rule is testable.
 */

export type Step =
  | { kind: "step"; text: string }
  | { kind: "tool"; handle: string; task: string; line: string; status: "running" | "ok" | "error"; preview: string | null; truncated: boolean }
  | { kind: "handed_off"; lane: number }
  | { kind: "warning"; detail: string }
  | { kind: "decision"; granted: boolean; detail: string };

/**
 * The reply a turn is writing now, as far as it has arrived: the line before
 * tool calls, or the answer. Temporary; the saved narration or answer
 * replaces it (architecture/web.md, "Streaming").
 */
export interface Draft {
  turnId: string;
  /** The model request it came from; a retried or repaired request is a later one. */
  call: number;
  kind: "narration" | "answer";
  text: string;
}

/** One question and everything Socrates did for it. */
export interface Exchange {
  /** "m<seq>" once the server saved the message; "c<id>" while it is being sent. */
  key: string;
  conversation: string;
  seq: number | null;
  at: string;
  message: string;
  /** The goal and task of its first part. */
  route: { goal: { number: number; title: string }; task: { number: number; title: string } } | null;
  steps: Step[];
  answers: string[];
  draft: Draft | null;
  /** Keep a request's watermark after its visible draft has been saved. */
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
  turns: string[];
  /** Turns still working. */
  open: string[];
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
  | { type: "sent"; id: string; text: string; to: string; at: string }
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
      const exchange = blank({ key: `c${event.id}`, conversation: event.to, at: event.at, message: event.text, state: "sending", sendId: event.id });
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
      if (index < 0) return model;
      const exchange = { ...model.pending[index]!, conversation: message.conversation };
      const pending = model.pending.filter((_, i) => i !== index);
      return withConversation({ ...model, pending }, message.conversation, [...(model.conversations[message.conversation] ?? []), exchange]);
    }
    case "draft":
      // A draft is not an event: it never moves the page's place in the log.
      return activity(model, { kind: "draft", seq: model.seq, at: new Date().toISOString(), conversation: message.conversation, turnId: message.turnId, call: message.call, draftKind: message.kind, text: message.text });
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
type DraftArrived = { kind: "draft"; seq: number; at: string; conversation: string; turnId: string; call: number; draftKind: Draft["kind"]; text: string };

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
    if (existing >= 0) return withConversation(model, a.conversation, list.map((e, i) => (i === existing ? blank({ ...e, steps: [], answers: [], draft: null, draftCalls: {}, question: null, state: "working", note: null, turns: [], open: [] }) : e)));
    const sending = list.findIndex((e) => e.state === "sending" && e.message === a.text);
    const saved = { key: `m${a.seq}`, seq: a.seq, at: a.at, state: "working" as const };
    if (sending >= 0) return withConversation(model, a.conversation, list.map((e, i) => (i === sending ? { ...e, ...saved } : e)));
    // A new lane's first message can be saved before the server says which lane it went to.
    const waiting = model.pending.findIndex((e) => e.message === a.text);
    if (waiting >= 0) {
      const adopted = { ...model.pending[waiting]!, ...saved, conversation: a.conversation };
      return withConversation({ ...model, pending: model.pending.filter((_, i) => i !== waiting) }, a.conversation, [...list, adopted]);
    }
    return withConversation(model, a.conversation, [...list, blank({ ...saved, conversation: a.conversation, message: a.text })]);
  }
  const turnId = a.turnId;
  let index = turnId ? list.findLastIndex((e) => e.turns.includes(turnId)) : -1;
  let next = list;
  if (a.kind === "draft" && index < 0) return model;
  if (index < 0) {
    index = list.findLastIndex((e) => e.state !== "sending");
    const last = list[index];
    // A turn handed over from the main conversation starts its own exchange in the lane.
    if (turnId && (!last || (last.state !== "working" && last.open.length === 0))) {
      const origin = (model.conversations.main ?? []).find((e) => e.turns.includes(turnId));
      next = [...list, blank({ key: `t${turnId}`, conversation: a.conversation, at: a.at, message: origin?.message ?? "Handed over from the main conversation.", state: "working" })];
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
        result = withConversation(result, laneId, [...lane, blank({key: `t${a.turnId}`, conversation: laneId, at: a.at, message: updated.message,
          route: a.goal && a.task ? {goal:a.goal,task:a.task} : updated.route, turns:[a.turnId], open:[a.turnId] })]);
      }
    }
  }
  return result;
}

/** The saved narration, answer or question, or the end of the turn, replaces its draft. */
const SETTLES_DRAFT = new Set(["step", "answer", "question", "finished", "handed_off"]);

function apply(e: Exchange, a: Activity | DraftArrived): Exchange {
  const next = applyOne(e, a);
  if (SETTLES_DRAFT.has(a.kind) && "turnId" in a && a.turnId) {
    const previous = next.draftCalls[a.turnId];
    return { ...next,
      draft: next.draft?.turnId === a.turnId ? null : next.draft,
      draftCalls: previous ? { ...next.draftCalls, [a.turnId]: { ...previous, settled: true } } : next.draftCalls,
    };
  }
  return next;
}

function applyOne(e: Exchange, a: Activity | DraftArrived): Exchange {
  if (a.kind === "draft") {
    if (e.turns.includes(a.turnId) && !e.open.includes(a.turnId)) return e;
    if (e.state !== "working" && e.state !== "sending") return e;
    const previous = e.draftCalls[a.turnId];
    if (previous && (a.call < previous.call || (a.call === previous.call && previous.settled))) return e;
    if (e.draft?.turnId === a.turnId && e.draft.call === a.call && e.draft.kind === a.draftKind && e.draft.text.length > a.text.length) return e;
  }
  const turnId = "turnId" in a ? a.turnId : null;
  const seen = turnId && !e.turns.includes(turnId) ? { turns: [...e.turns, turnId], open: [...e.open, turnId] } : {};
  const x = { ...e, ...seen };
  switch (a.kind) {
    case "draft":
      // A later request's draft replaces the earlier one; a stale one is ignored.
      if (x.draft?.turnId === a.turnId && x.draft.call > a.call) return x;
      return { ...x, draftCalls: { ...x.draftCalls, [a.turnId]: { call: a.call, settled: false } }, draft: { turnId: a.turnId, call: a.call, kind: a.draftKind, text: a.text } };
    case "routed":
      return { ...x, route: x.route ?? { goal: a.goal, task: a.task } };
    case "question":
      return { ...x, question: a.text, state: "done", open: x.open.filter((t) => t !== a.turnId) };
    case "step":
      return { ...x, steps: [...x.steps, { kind: "step", text: a.text }] };
    case "tool_started":
      return { ...x, steps: [...x.steps, { kind: "tool", handle: a.handle, task: a.task, line: a.line, status: "running", preview: null, truncated: false }] };
    case "tool_finished":
      return { ...x, steps: x.steps.map((s) => (s.kind === "tool" && s.handle === a.handle && s.task === a.task ? { ...s, status: a.status, preview: a.preview, truncated: a.truncated } : s)) };
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
      if (a.status === "interrupted") return { ...x, open, state: open.length ? x.state : "stopped", note: stopReason(a.reason) };
      return { ...x, open, state: open.length || x.state === "stopped" ? x.state : "done" };
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
    route: first ? { goal: first.goal, task: first.task } : null,
    steps: item.parts.flatMap((p): Step[] => [
      ...(p.handedOff && p.lane !== null ? [{ kind: "handed_off" as const, lane: p.lane }] : []),
      ...p.toolCalls.map((t) => ({ kind: "tool" as const, handle: t.handle, task: `g${p.goal.number}/t${p.task.number}`, line: t.line, status: t.status ?? ("running" as const), preview: null, truncated: false })),
    ]),
    answers: item.parts.flatMap((p) => (p.answer ? [p.answer] : [])),
    question: item.question,
    state: working ? "working" : interrupted ? "stopped" : "done",
    note: interrupted ? stopReason(interrupted.interrupted) : null,
    turns: item.parts.flatMap((p) => p.turnId ? [p.turnId] : []),
    open: item.parts.flatMap((p) => p.turnId && p.status === "in_progress" && !p.handedOff ? [p.turnId] : []),
    throughSeq: item.throughSeq ?? 0,
  });
  if (item.activities) {
    exchange = { ...exchange, steps: exchange.steps.filter((s) => s.kind === "handed_off") };
    for (const a of item.activities) exchange = apply(exchange, a);
  }
  return exchange;
}

function blank(e: Partial<Exchange> & Pick<Exchange, "key" | "conversation" | "at" | "message">): Exchange {
  return { seq: null, route: null, steps: [], answers: [], draft: null, draftCalls: {}, throughSeq: 0, question: null, state: "working", note: null, sendId: null, turns: [], open: [], ...e };
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
  if (approvals.some((a) => a.conversation === exchange.conversation)) return "waiting";
  return exchange.steps.length || exchange.answers.length || exchange.draft ? "working" : "thinking";
}

/** The orb sits in the middle until the answer starts, then docks where the answer begins. */
export const orbDocked = (state: OrbState) => state !== "idle" && state !== "thinking";

/** The goal and task of the newest routed question of a conversation, for its notes and panels. */
export function currentRoute(list: Exchange[]): Exchange["route"] {
  return [...list].reverse().find((e) => e.route)?.route ?? null;
}

/** One line for work in progress, where there is no orb to show it. */
export function workLine(state: OrbState, exchange: Exchange | null): string | null {
  if (state === "thinking") return "Thinking…";
  if (state === "working") return "Working…";
  if (state === "waiting") return "Waiting for your approval";
  return exchange?.state === "sending" ? "Sending…" : null;
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
