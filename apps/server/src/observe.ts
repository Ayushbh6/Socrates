import type { EventPayloads, ModelMessage, TextPart } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import type { CallBreakdown, CallDetail, CallLog, CallRow, CallTotals, LedgerStore, Turn } from "@socrates/store";

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
  const add = (rows: CallBreakdown[]): CallTotals => {
    const sum = (f: (r: CallBreakdown) => number) => rows.reduce((n, r) => n + f(r), 0);
    const prompt = sum((r) => r.promptTokens);
    const timed = rows.filter((r) => r.tokensPerSecond !== null);
    const streamed = rows.filter((r) => r.firstTokenMs !== null);
    const weighted = (set: CallBreakdown[], f: (r: CallBreakdown) => number) => set.reduce((n, r) => n + f(r) * r.calls, 0) / Math.max(1, set.reduce((n, r) => n + r.calls, 0));
    return {
      calls: sum((r) => r.calls), failed: sum((r) => r.failed), promptTokens: prompt, outputTokens: sum((r) => r.outputTokens),
      cacheReadTokens: sum((r) => r.cacheReadTokens), cacheWriteTokens: sum((r) => r.cacheWriteTokens),
      cacheHitRate: prompt > 0 ? sum((r) => r.cacheReadTokens) / prompt : null,
      costUsd: sum((r) => r.costUsd), priced: sum((r) => r.priced), ms: sum((r) => r.ms),
      tokensPerSecond: timed.length ? Math.round(weighted(timed, (r) => r.tokensPerSecond!) * 10) / 10 : null,
      firstTokenMs: streamed.length ? Math.round(weighted(streamed, (r) => r.firstTokenMs!)) : null,
    };
  };
  return {
    range,
    totals: log.totals(since),
    work: add(byModel.filter((r) => r.role === "work" || r.role === "wrap_up" || r.role === "repair")),
    byModel,
    unpriced: [...new Set(byModel.filter((r) => r.role !== "embedding" && r.priced < r.calls - r.failed).map((r) => r.model))],
    unpricedCalls: byModel.filter((r) => r.role !== "embedding").reduce((n, r) => n + Math.max(0, r.calls - r.failed - r.priced), 0),
    storedBytes: log.storedBytes(),
    retentionDays,
  };
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

const BLOCK = /<([A-Z][A-Z_]+)(?:\s[^>]*)?>\n[\s\S]*?\n<\/\1>/g;

/** A context part cut into its top-level `<NAME>…</NAME>` blocks and the text between them. */
export function blocksOf(parts: TextPart[]): ContextBlock[] {
  const blocks: ContextBlock[] = [];
  for (const part of parts) {
    const found: ContextBlock[] = [];
    let at = 0;
    const plain = (text: string) => { if (text.trim()) found.push({ name: null, tokens: countTokens(text), text: text.trim(), cacheAfter: false }); };
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
