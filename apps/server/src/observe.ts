import { RECALL_AT, SAVE_AT, WORK_AT } from "@socrates/agent";
import { isWorkMemoryPath } from "@socrates/tools";
import type { EventPayloads, ModelMessage, TextPart } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import type { CallBreakdown, CallBucket, CallDetail, CallLog, CallRow, CallTotals, LedgerStore, Turn } from "@socrates/store";

/**
 * What the inspect page shows (architecture/observability.md): the call log
 * joined with the ledger, so every number sits beside the question it was
 * spent on and the routing that chose where the question went.
 */

export const RANGES = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: null } as const;
export type Range = keyof typeof RANGES;

export function sinceOf(range: Range, now: Date): string | undefined {
  const span = RANGES[range];
  return span === null ? undefined : new Date(now.getTime() - span).toISOString();
}

export interface Summary {
  range: Range;
  totals: CallTotals;
  /** The working agent alone (its steps, wrap-ups and repairs): where caching matters. */
  work: CallTotals;
  byModel: CallBreakdown[];
  /** Models that made calls with no price known, whose calls are not in the cost. */
  unpriced: string[];
  /** How many successful calls that is (embeddings have no token price and are not counted). */
  unpricedCalls: number;
  storedBytes: number;
  retentionDays: number;
}

export function summary(log: CallLog, range: Range, now: Date, retentionDays: number): Summary {
  const since = sinceOf(range, now);
  const byModel = log.breakdown(since);
  return {
    range,
    totals: log.modelTotals(since),
    work: log.modelTotals(since, ["work", "wrap_up", "repair"]),
    byModel,
    unpriced: [...new Set(byModel.filter((r) => r.role !== "embedding" && r.priced < r.calls - r.failed - r.stopped).map((r) => r.model))],
    unpricedCalls: byModel.filter((r) => r.role !== "embedding").reduce((n, r) => n + Math.max(0, r.calls - r.failed - r.stopped - r.priced), 0),
    storedBytes: log.storedBytes(),
    retentionDays,
  };
}

/**
 * How the memory decider has behaved (architecture/observability.md, "The
 * decider"): how often it asked, how often it said yes, and what followed in
 * the turn, read from the call log and the ledger. Thresholds are set from
 * these rates: recall "likely" at RECALL_AT and above, save "likely" at
 * SAVE_AT and above.
 */
export interface DeciderStats {
  range: Range;
  /** Decisions in the range that were answered (up to the latest 500), and the ones that failed. */
  answered: number;
  failed: number;
  medianMs: number | null;
  costUsd: number;
  recall: { likely: number; likelyOffered: number; unlikely: number; unlikelyOffered: number };
  save: { likely: number; likelySaved: number; unlikely: number; unlikelySaved: number };
  /** Finished turns the decider was asked about, and in how many of the likely ones the agent wrote the project's notes. */
  work: { likely: number; likelyWrote: number; unlikely: number };
}

const STATS_LIMIT = 500;

/** Whether a recorded call changed the work-memory index or one of its topic files, named relative to the project or in full. */
export function writesWorkMemory(tool: string, input: unknown): boolean {
  const i = (input ?? {}) as { path?: unknown; patch?: unknown };
  const notes = (p: string) => isWorkMemoryPath(p.trim().replace(/^\.\//, "")) || /\/\.socrates\/(?:MEMORY\.md|memory\/[A-Za-z0-9][A-Za-z0-9._-]*\.md)$/.test(p.trim());
  if (tool === "edit") return typeof i.path === "string" && notes(i.path);
  if (tool === "apply_patch") return [...String(i.patch ?? "").matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].some((m) => notes(m[1]!));
  return false;
}

export function deciderStats(log: CallLog, store: LedgerStore, range: Range, now: Date): DeciderStats {
  const rows = log.list({ role: "decision", limit: STATS_LIMIT, ...(sinceOf(range, now) ? { since: sinceOf(range, now)! } : {}) });
  const offered = new Set(store.listEvents({ type: "memory_surfaced" }).filter((e) => (e.payload as EventPayloads["memory_surfaced"]).how === "candidates").map((e) => e.turn_id));
  const saved = new Set(store.listEvents({ type: "memory_saved" }).filter((e) => (e.payload as EventPayloads["memory_saved"]).by === "agent").map((e) => e.turn_id));
  const stats: DeciderStats = { range, answered: 0, failed: 0, medianMs: null, costUsd: 0, recall: { likely: 0, likelyOffered: 0, unlikely: 0, unlikelyOffered: 0 }, save: { likely: 0, likelySaved: 0, unlikely: 0, unlikelySaved: 0 }, work: { likely: 0, likelyWrote: 0, unlikely: 0 } };
  const times: number[] = [];
  for (const row of rows) {
    if (!row.ok) { stats.failed++; continue; }
    stats.answered++;
    stats.costUsd += row.costUsd ?? 0;
    times.push(row.ms);
    let p: { recall?: number; save?: number; work?: number } = {};
    try { p = JSON.parse(log.get(row.id)?.response?.text ?? "{}"); } catch {}
    if (typeof p.work === "number") {
      if (p.work < WORK_AT) stats.work.unlikely++;
      else {
        stats.work.likely++;
        if (row.turnId && store.evidenceForTurn(row.turnId).some((e) => writesWorkMemory(e.tool, e.input))) stats.work.likelyWrote++;
      }
      continue;
    }
    if (typeof p.recall === "number") {
      const bucket = p.recall >= RECALL_AT ? "likely" : "unlikely";
      stats.recall[bucket]++;
      const turns = row.userEventId ? store.turnsForUserEvent(row.userEventId).map((t) => t.id) : [];
      if (turns.some((id) => offered.has(id))) stats.recall[bucket === "likely" ? "likelyOffered" : "unlikelyOffered"]++;
    }
    if (typeof p.save === "number") {
      const bucket = p.save >= SAVE_AT ? "likely" : "unlikely";
      stats.save[bucket]++;
      const turns = row.userEventId ? store.turnsForUserEvent(row.userEventId).map((t) => t.id) : [];
      if (turns.some((id) => saved.has(id))) stats.save[bucket === "likely" ? "likelySaved" : "unlikelySaved"]++;
    }
  }
  times.sort((a, b) => a - b);
  stats.medianMs = times.length ? times[Math.floor(times.length / 2)]! : null;
  return stats;
}

/** What a message did to where the work stood. */
export type Move = "first" | "continued" | "switched_task" | "new_task" | "switched_goal" | "new_goal" | "general";

export interface PlaceView {
  goal: { number: number; title: string };
  task: { number: number; title: string };
}

export interface PartView {
  turnId: string;
  projectTurn: number;
  status: Turn["status"];
  /** The router's own words for the choice, such as "continue/continue_task g2/t1". */
  route: string | null;
  to: PlaceView;
  /** Where the conversation stood before this message; null for its first message. */
  from: PlaceView | null;
  move: Move;
  /** Compactions this part's turn went through. */
  compactions: EventPayloads["compaction_recorded"][];
}

export interface QuestionSummary extends CallTotals {
  userEventId: string;
  at: string;
  message: string;
  /** The lane it was asked in, or null for the main conversation. */
  lane: number | null;
  /** What happened to the message: bound to work, answered with a question, or not routed. */
  outcome: "routed" | "clarify" | "unrouted";
  parts: { to: PlaceView; move: Move }[];
}

export interface QuestionDetail {
  question: Omit<QuestionSummary, keyof CallTotals>;
  totals: CallTotals;
  routing: {
    model: string;
    attempts: number;
    escalated: boolean;
    fallback: string | null;
    ledgerQueries: number;
    reason: string;
    decision: unknown;
    validationErrors: string[];
  } | null;
  /** The router's question, when it asked one instead of routing. */
  clarification: string | null;
  parts: PartView[];
  calls: CallRow[];
}

const MESSAGE_CHARS = 240;
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function placeOf(store: LedgerStore, turn: Turn): PlaceView | null {
  const task = turn.taskId ? store.getTask(turn.taskId) : null;
  const goal = task ? store.getGoal(task.goalId) : null;
  return goal && task ? { goal: { number: goal.number, title: goal.title }, task: { number: task.number, title: task.title } } : null;
}

function moveOf(store: LedgerStore, turn: Turn, route: string | null): Move {
  if (route === "general") return "general";
  if (route?.endsWith("create_task new goal")) return "new_goal";
  if (route?.includes("/create_task g")) return "new_task";
  // Standard mode: the user chose the chat; nothing was routed.
  if (route === "standard_new") return "new_task";
  const before = store.previousTurn(turn);
  if (!before) return "first";
  if (before.taskId === turn.taskId) return "continued";
  return before.goalId === turn.goalId ? "switched_task" : "switched_goal";
}

function partsOf(store: LedgerStore, userEventId: string): PartView[] {
  const parts: PartView[] = [];
  for (const turn of store.turnsForUserEvent(userEventId)) {
    const to = placeOf(store, turn);
    if (!to) continue;
    const before = store.previousTurn(turn);
    const route = (store.listEvents({ turnId: turn.id, type: "turn_bound" })[0]?.payload as EventPayloads["turn_bound"] | undefined)?.route ?? null;
    parts.push({
      turnId: turn.id, projectTurn: turn.projectTurn, status: turn.status, route, to,
      from: before ? placeOf(store, before) : null,
      move: moveOf(store, turn, route),
      compactions: store.listEvents({ turnId: turn.id, type: "compaction_recorded" }).map((e) => e.payload as EventPayloads["compaction_recorded"]),
    });
  }
  return parts;
}

function questionOf(store: LedgerStore, userEventId: string): QuestionDetail["question"] | null {
  const event = store.getEvent(userEventId);
  if (!event || event.type !== "user_message") return null;
  const payload = event.payload as EventPayloads["user_message"];
  const lane = payload.lane_id ? store.getLane(payload.lane_id)?.number ?? null : null;
  const turns = store.turnsForUserEvent(userEventId);
  const parts = partsOf(store, userEventId).map((p) => ({ to: p.to, move: p.move }));
  const outcome = turns.some((t) => t.kind === "task") ? "routed" : turns.length ? "clarify" : "unrouted";
  return { userEventId, at: event.at, message: cut(payload.text, MESSAGE_CHARS), lane, outcome, parts };
}

/** User messages with calls, newest first. `next` pages backward. */
export function questions(log: CallLog, store: LedgerStore, options: { range: Range; before?: string; limit: number; now: Date }): { questions: QuestionSummary[]; next: string | null } {
  const since = sinceOf(options.range, options.now);
  const rows = log.questions({ limit: options.limit, ...(since ? { since } : {}), ...(options.before ? { before: options.before } : {}) });
  const out: QuestionSummary[] = [];
  for (const row of rows) {
    const question = questionOf(store, row.userEventId);
    if (question) out.push({ ...row, ...question, at: question.at });
  }
  return { questions: out, next: rows.length === options.limit ? rows.at(-1)!.startedAt : null };
}

/** The questions that cost the most in a range, dearest first. */
export function costly(log: CallLog, store: LedgerStore, range: Range, now: Date): QuestionSummary[] {
  const since = sinceOf(range, now);
  return log.questions({ limit: 8, sort: "cost", ...(since ? { since } : {}) }).flatMap((row) => {
    const base = questionOf(store, row.userEventId);
    return base ? [{ ...row, ...base }] : [];
  });
}

export function question(log: CallLog, store: LedgerStore, userEventId: string): QuestionDetail | null {
  const base = questionOf(store, userEventId);
  if (!base) return null;
  const turns = store.turnsForUserEvent(userEventId);
  const first = turns[0];
  const routed = first ? store.listEvents({ turnId: first.id, type: "routing_completed" })[0]?.payload as EventPayloads["routing_completed"] | undefined : undefined;
  const asked = first ? store.listEvents({ turnId: first.id, type: "clarification_asked" })[0]?.payload as EventPayloads["clarification_asked"] | undefined : undefined;
  return {
    question: base,
    totals: log.totalsFor(userEventId),
    routing: routed ? { model: routed.model, attempts: routed.attempts, escalated: routed.escalated, fallback: routed.fallback, ledgerQueries: routed.ledger_queries, reason: routed.reason, decision: routed.decision, validationErrors: routed.validation_errors ?? [] } : null,
    clarification: asked?.question ?? null,
    parts: partsOf(store, userEventId),
    calls: log.forQuestion(userEventId),
  };
}

/** One piece of what a model was shown: a named block of the context, or plain text. */
export interface ContextBlock {
  /** "USER", "GOAL", "CURRENT_TASK"…; null for text outside any block (history lines, the first lines of a turn). */
  name: string | null;
  tokens: number;
  text: string;
  /** Whether a prompt-cache breakpoint follows the piece this block came from. */
  cacheAfter: boolean;
}

export interface MessageSize {
  index: number;
  role: ModelMessage["role"];
  tokens: number;
}

export interface CallView extends CallDetail {
  /** The first message, which carries the assembled context, cut into its blocks. */
  blocks: ContextBlock[];
  /** Each message's size, the system prompt and the tool definitions first. */
  sizes: { system: number; tools: number; messages: MessageSize[] };
}

/** What a stretch of text between blocks is, by how it starts: a turn of the task's history, or a note. */
function plainName(text: string): string | null {
  const first = text.trim().split("\n", 1)[0] ?? "";
  const turn = /^\[TURN (\d+)/.exec(first);
  return turn ? `HISTORY · TURN ${turn[1]}` : null;
}

const BLOCK = /<([A-Z][A-Z_]+)(?:\s[^>]*)?>\n[\s\S]*?\n<\/\1>/g;

/** A context part cut into its top-level `<NAME>…</NAME>` blocks and the text between them. */
export function blocksOf(parts: TextPart[]): ContextBlock[] {
  const blocks: ContextBlock[] = [];
  for (const part of parts) {
    const found: ContextBlock[] = [];
    let at = 0;
    const plain = (text: string) => { if (text.trim()) found.push({ name: plainName(text), tokens: countTokens(text), text: text.trim(), cacheAfter: false }); };
    for (const match of part.text.matchAll(BLOCK)) {
      plain(part.text.slice(at, match.index));
      found.push({ name: match[1]!, tokens: countTokens(match[0]), text: match[0], cacheAfter: false });
      at = match.index + match[0].length;
    }
    plain(part.text.slice(at));
    if (found.length && part.cache) found[found.length - 1]!.cacheAfter = true;
    blocks.push(...found);
  }
  return blocks;
}

const textOf = (m: ModelMessage): string => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join(""));

export function callView(log: CallLog, id: string): CallView | null {
  const call = log.get(id);
  if (!call) return null;
  const first = call.request.messages[0];
  const parts = first?.role === "user" ? (typeof first.content === "string" ? [{ text: first.content }] : first.content) : [];
  return {
    ...call,
    blocks: blocksOf(parts),
    sizes: {
      system: countTokens(call.request.system),
      tools: countTokens(JSON.stringify(call.request.tools)),
      messages: call.request.messages.map((m, index) => ({ index, role: m.role, tokens: countTokens(m.role === "assistant" ? `${m.content}${JSON.stringify(m.toolCalls ?? [])}` : textOf(m)) })),
    },
  };
}

/** The time series behind the overview charts: model calls per bucket and role, with empty stretches present. */
export interface Series {
  range: Range;
  bucketMs: number;
  /** Bucket starts, oldest first, covering the range. */
  at: string[];
  buckets: CallBucket[];
}

const BUCKETS: Record<Range, number> = { "24h": 3_600_000, "7d": 6 * 3_600_000, "30d": 86_400_000, all: 86_400_000 };

export function series(log: CallLog, range: Range, now: Date): Series {
  const bucketMs = BUCKETS[range];
  const since = sinceOf(range, now);
  const first = since ?? log.oldestModelStart() ?? now.toISOString();
  const start = Math.floor(new Date(first).getTime() / bucketMs) * bucketMs;
  const end = Math.floor(now.getTime() / bucketMs) * bucketMs;
  // A year of days is the most a chart can hold.
  const from = Math.max(start, end - 364 * 86_400_000);
  const at: string[] = [];
  for (let t = from; t <= end; t += bucketMs) at.push(new Date(t).toISOString());
  return { range, bucketMs, at, buckets: log.series(since && new Date(since).getTime() > from ? since : new Date(from).toISOString(), bucketMs) };
}

/** What entered a call's context since the call before it. */
export interface Entered {
  role: ModelMessage["role"];
  /** "tool result · read", "its own reply, sent back", "user"… */
  label: string;
  tokens: number;
  text: string;
}

export interface TraceCall {
  kind: "call";
  at: string;
  call: CallRow;
  /** The router's requests, or a turn's. */
  group: "router" | "turn";
  turnId: string | null;
  reasoning: string | null;
  text: string;
  toolCalls: { id: string; name: string; input: unknown; result: { content: string; isError: boolean; tokens: number } | null }[];
  /** Local text-token estimate; readable thinking can be only a provider summary. */
  reasoningTextTokens: number;
  /** The messages added since the call before it in its group, in the order sent. */
  entered: Entered[];
  /** True when the first context message changed; compaction events are reported separately. */
  rebuilt: boolean;
  /** The first call of a group: the context message cut into its blocks. */
  context: ContextBlock[] | null;
}

export type TraceItem =
  | { kind: "user"; at: string; text: string; attachments: string[]; lane: number | null }
  | TraceCall
  | { kind: "routing"; at: string; routing: NonNullable<QuestionDetail["routing"]>; clarification: string | null }
  | { kind: "turn"; at: string; part: PartView }
  | { kind: "compaction"; at: string; turnId: string; compaction: EventPayloads["compaction_recorded"] }
  | { kind: "answer"; at: string; turnId: string; status: Turn["status"]; text: string | null; stopped: string | null };

const enteredLabel = (m: ModelMessage): string =>
  m.role === "tool" ? `tool result · ${m.toolName}${m.isError ? " (error)" : ""}` : m.role === "assistant" ? "its own reply, sent back" : "the harness asked";

/** A message as a model saw it: its text, and for a reply its tool calls. */
const messageText = (m: ModelMessage): string =>
  m.role === "assistant" && m.toolCalls?.length ? `${m.content}\n${m.toolCalls.map((t) => `→ ${t.name}(${JSON.stringify(t.input)})`).join("\n")}`.trim() : textOf(m);

/**
 * Everything that happened for one message, in order: the message, each router
 * request with its thinking, tool calls and their results, the decision, then
 * per part the working agent's steps (what entered its context, what it
 * thought, said and called, and what the tools answered), any compaction, and
 * the answer. Reads the call log and the ledger; nothing here is inferred
 * beyond joining the two.
 */
export function trace(log: CallLog, store: LedgerStore, userEventId: string): { question: QuestionDetail["question"]; items: TraceItem[] } | null {
  const detail = question(log, store, userEventId);
  const event = store.getEvent(userEventId);
  if (!detail || !event) return null;
  const payload = event.payload as EventPayloads["user_message"];
  const items: TraceItem[] = [{ kind: "user", at: event.at, text: payload.text, attachments: (payload.attachments ?? []).map((a) => a.name), lane: detail.question.lane }];

  // Group the calls: the router's together, then each turn's.
  const groups = new Map<string, CallRow[]>();
  for (const c of detail.calls) {
    const key = c.role === "router" ? "router" : c.role === "decision" ? "decision" : c.turnId ?? "other";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const callsOf = (key: string, group: "router" | "turn"): TraceCall[] => {
    const rows = groups.get(key) ?? [];
    const raw: ModelMessage[][] = [];
    const out: TraceCall[] = rows.map((row, i) => {
      const before = rows[i - 1];
      const rebuilt = before !== undefined && log.firstHash(row.id) !== log.firstHash(before.id);
      const fresh = before === undefined || rebuilt;
      const requestMessages = log.messagesFrom(row.id, 0).messages;
      const hashes = log.messageHashes(row.id);
      const previousHashes = before ? log.messageHashes(before.id) : [];
      let unchanged = 0;
      while (unchanged < hashes.length && hashes[unchanged] === previousHashes[unchanged]) unchanged++;
      const messages = fresh ? requestMessages.slice(1) : requestMessages.slice(unchanged);
      raw.push(requestMessages);
      const response = log.response(row.id);
      const first = fresh ? requestMessages[0] : undefined;
      return {
        kind: "call", at: row.startedAt, call: row, group, turnId: row.turnId, reasoning: response?.reasoning ?? null, reasoningTextTokens: countTokens(response?.reasoning ?? ""), text: response?.text ?? "",
        toolCalls: (response?.toolCalls ?? []).map((t) => ({ id: t.id, name: t.name, input: t.input, result: null })),
        entered: messages.map((m) => ({ role: m.role, label: enteredLabel(m), tokens: countTokens(messageText(m)), text: messageText(m) })),
        rebuilt: rebuilt && before !== undefined,
        context: fresh ? (first?.role === "user" ? blocksOf(typeof first.content === "string" ? [{ text: first.content }] : first.content) : []) : null,
      };
    });
    // A tool call's result is the tool message that entered the next call's context.
    out.forEach((c, i) => {
      const later = raw[i + 1] ?? [];
      for (const t of c.toolCalls) {
        const found = later.find((m) => m.role === "tool" && m.toolCallId === t.id);
        if (found && found.role === "tool") t.result = { content: found.content, isError: found.isError === true, tokens: countTokens(found.content) };
      }
    });
    return out;
  };

  // The memory decider is asked first, before routing.
  items.push(...callsOf("decision", "router"), ...callsOf("router", "router"));
  if (detail.routing || detail.clarification) items.push({ kind: "routing", at: detail.calls.filter((c) => c.role === "router").at(-1)?.startedAt ?? event.at, routing: detail.routing ?? { model: "", attempts: 0, escalated: false, fallback: null, ledgerQueries: 0, reason: "", decision: null, validationErrors: [] }, clarification: detail.clarification });

  for (const part of detail.parts) {
    const turn = store.requireTurn(part.turnId);
    const stamp = store.getEvent(turn.userEventId)?.at ?? event.at;
    const turnItems: TraceItem[] = [...callsOf(part.turnId, "turn"), ...part.compactions.map((c, i): TraceItem => ({ kind: "compaction", at: store.listEvents({ turnId: part.turnId, type: "compaction_recorded" })[i]?.at ?? stamp, turnId: part.turnId, compaction: c }))];
    turnItems.sort((a, b) => a.at.localeCompare(b.at));
    const response = turn.responseEventId ? store.getEvent(turn.responseEventId) : null;
    const interruption = store.interruption(turn.id);
    items.push({ kind: "turn", at: turnItems[0]?.at ?? stamp, part }, ...turnItems, {
      kind: "answer", at: response?.at ?? stamp, turnId: part.turnId, status: turn.status,
      text: response ? (response.payload as EventPayloads["assistant_response"]).text : interruption?.partial_answer ?? null,
      stopped: interruption ? interruption.reason : null,
    });
  }
  return { question: detail.question, items };
}
