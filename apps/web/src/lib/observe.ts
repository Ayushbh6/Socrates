/** The inspect page's data and how its numbers read (architecture/observability.md). */

export type Range = "24h" | "7d" | "30d" | "all";
export const RANGES: { id: Range; label: string }[] = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All" },
];

export interface Totals {
  calls: number;
  failed: number;
  stopped: number;
  promptTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number | null;
  costUsd: number;
  priced: number;
  ms: number;
  tokensPerSecond: number | null;
  firstTokenMs: number | null;
  speedSamples?: number;
  firstTokenSamples?: number;
}

export type Role = "router" | "work" | "wrap_up" | "repair" | "compaction" | "embedding" | "decision" | "other";

export interface Breakdown extends Totals {
  role: Role;
  model: string;
}

export interface Summary {
  range: Range;
  totals: Totals;
  work: Totals;
  byModel: Breakdown[];
  unpriced: string[];
  unpricedCalls: number;
  storedBytes: number;
  retentionDays: number;
}

/** How the memory decider has behaved: how often it said a recall or a save was likely, and what followed in the turn. */
export interface DeciderStats {
  range: Range;
  answered: number;
  failed: number;
  medianMs: number | null;
  costUsd: number;
  recall: { likely: number; likelyOffered: number; unlikely: number; unlikelyOffered: number };
  save: { likely: number; likelySaved: number; unlikely: number; unlikelySaved: number };
  work: { likely: number; likelyWrote: number; unlikely: number };
}

export interface Place {
  goal: { number: number; title: string };
  task: { number: number; title: string };
}

export type Move = "first" | "continued" | "switched_task" | "new_task" | "switched_goal" | "new_goal" | "general";

export interface QuestionRow extends Totals {
  userEventId: string;
  startedAt: string;
  at: string;
  message: string;
  lane: number | null;
  outcome: "routed" | "clarify" | "unrouted";
  parts: { to: Place; move: Move }[];
}

export interface CallRow {
  id: string;
  startedAt: string;
  role: Role;
  model: string;
  servedBy: string | null;
  userEventId: string | null;
  turnId: string | null;
  step: number | null;
  streamed: boolean;
  ok: boolean;
  error: { kind: string; status: number | null; message: string } | null;
  stopReason: string | null;
  promptTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number | null;
  ms: number;
  firstTokenMs: number | null;
  tokensPerSecond: number | null;
  costUsd: number | null;
  costSource: "reported" | "price" | null;
  messageCount: number;
  requestBytes: number;
}

export interface PartView {
  turnId: string;
  projectTurn: number;
  status: string;
  route: string | null;
  to: Place;
  from: Place | null;
  move: Move;
  compactions: { count: number; layers: string[]; checkpoint: string | null; before_tokens: number; after_tokens: number }[];
}

export interface QuestionDetail {
  question: Omit<QuestionRow, keyof Totals>;
  totals: Totals;
  routing: { model: string; attempts: number; escalated: boolean; fallback: string | null; ledgerQueries: number; reason: string; decision: unknown; validationErrors: string[] } | null;
  clarification: string | null;
  parts: PartView[];
  calls: CallRow[];
}

export interface ContextBlock {
  name: string | null;
  tokens: number;
  text: string;
  cacheAfter: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface Message {
  role: "user" | "assistant" | "tool";
  content: string | { text: string; cache?: boolean }[];
  toolCalls?: ToolCall[];
  toolName?: string;
  isError?: boolean;
  images?: unknown[];
}

export interface CallDetail extends CallRow {
  request: {
    system: string;
    messages: Message[];
    tools: { name: string; description: string; inputSchema: unknown }[];
    toolChoice: string;
    maxOutputTokens: number | null;
    temperature: number | null;
    effort: string | null;
  };
  response: { text: string; toolCalls: ToolCall[]; reasoning: string | null; meta: Record<string, unknown> | null } | null;
  blocks: ContextBlock[];
  sizes: { system: number; tools: number; messages: { index: number; role: string; tokens: number }[] };
}

export interface PriceRow {
  model: string;
  source: "settings" | "list" | null;
  price: { input: number; cachedInput: number | null; cacheWrite: number | null; output: number } | null;
}

/** Compact display identity; the full id remains available on the call. */
export function shortModel(id: string): string {
  return id.replace(/^gemini:interactions:/, "gemini:").replace(/:[0-9a-f]{16,}$/, "");
}

/** 950, 1.2k, 12k, 340k, 1.23M. */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** US dollars with enough digits to say something about a fraction of a cent. */
export function usd(n: number | null): string {
  if (n === null) return "–";
  if (n === 0) return "$0";
  if (n < 0.001) return `$${n.toFixed(5)}`;
  if (n < 0.1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function percent(rate: number | null): string {
  return rate === null ? "–" : `${Math.round(rate * 100)}%`;
}

/** 420 ms, 12.3 s, 2m 05s. */
export function duration(ms: number | null): string {
  if (ms === null) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

export function speed(tps: number | null): string {
  return tps === null ? "–" : `${tps < 100 ? tps.toFixed(1) : Math.round(tps)} tok/s`;
}

export function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const MOVES: Record<Move, string> = {
  first: "First message",
  continued: "Continued the task",
  switched_task: "Switched task",
  new_task: "New task",
  switched_goal: "Switched goal",
  new_goal: "New goal",
  general: "General chat",
};

/** Whether a message moved the work somewhere else (the automatic context switch the page exists to show). */
export const switched = (move: Move): boolean => move === "switched_task" || move === "switched_goal" || move === "new_task" || move === "new_goal";

export function roleLabel(call: Pick<CallRow, "role" | "step">): string {
  switch (call.role) {
    case "router": return `Router${call.step && call.step > 1 ? ` ${call.step}` : ""}`;
    case "work": return `Agent step ${call.step ?? 1}`;
    case "wrap_up": return "Wrap-up";
    case "repair": return "Answer repair";
    case "compaction": return `Compaction${call.step && call.step > 1 ? ` retry` : ""}`;
    case "embedding": return "Embedding";
    case "decision": return "Memory decider";
    default: return "Call";
  }
}

/** How a call's prompt splits: served from the cache, written to it, and sent fresh. */
export function promptSplit(call: Pick<CallRow, "promptTokens" | "cacheReadTokens" | "cacheWriteTokens">): { cached: number; written: number; fresh: number } {
  const cached = Math.min(call.cacheReadTokens, call.promptTokens);
  const written = Math.min(call.cacheWriteTokens, call.promptTokens - cached);
  return { cached, written, fresh: call.promptTokens - cached - written };
}

/** The text of a message as a model saw it. */
export function messageText(m: Message): string {
  const body = typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("");
  if (m.role !== "assistant" || !m.toolCalls?.length) return body;
  return `${body}${body ? "\n" : ""}${m.toolCalls.map((c) => `→ ${c.name}(${JSON.stringify(c.input)})`).join("\n")}`;
}

export type Tab = "overview" | "traces" | "data";

export interface Target {
  tab: Tab;
  /** A message's id, in the traces. */
  question: string | null;
  /** A database and table, in the data view. */
  db: string | null;
  table: string | null;
}

/**
 * The view the address names: `#/inspect` (the overview), `#/inspect/traces`
 * and `#/inspect/traces/<message id>`, `#/inspect/data` and
 * `#/inspect/data/<database>/<table>`. `#/inspect/<message id>`, from before
 * there were tabs, opens that message's trace.
 */
export function inspectTarget(hash: string): Target | null {
  const m = /^#\/inspect(?:\/(.*))?$/.exec(hash);
  if (!m) return null;
  const parts = (m[1] ?? "").split("/").filter(Boolean);
  const none = { question: null, db: null, table: null };
  const id = /^[A-Za-z0-9_-]+$/;
  if (!parts.length || parts[0] === "overview") return parts.length <= 1 ? { tab: "overview", ...none } : null;
  if (parts[0] === "traces") return parts.length <= 2 && (parts[1] === undefined || id.test(parts[1])) ? { tab: "traces", ...none, question: parts[1] ?? null } : null;
  if (parts[0] === "data") return parts.length <= 3 && parts.slice(1).every((p) => id.test(p)) ? { tab: "data", ...none, db: parts[1] ?? null, table: parts[2] ?? null } : null;
  return parts.length === 1 && id.test(parts[0]!) ? { tab: "traces", ...none, question: parts[0]! } : null;
}

/** Where a tab lives. */
export const inspectHref = (tab: Tab, ...rest: (string | null | undefined)[]): string => `#/inspect${tab === "overview" ? "" : `/${tab}`}${rest.filter(Boolean).map((p) => `/${p}`).join("")}`;

/** The chart series a call's role belongs to (embeddings are not charted). */
export const GROUPS = ["Agent", "Router", "Compaction", "Wrap-up and repair", "Decider", "Other"] as const;
export type Group = (typeof GROUPS)[number];
export function groupOf(role: Role): Group | null {
  switch (role) {
    case "work": return "Agent";
    case "router": return "Router";
    case "compaction": return "Compaction";
    case "wrap_up": case "repair": return "Wrap-up and repair";
    case "decision": return "Decider";
    case "other": return "Other";
    default: return null;
  }
}

export interface Bucket extends Totals {
  at: string;
  role: Role;
}

export interface SeriesData {
  range: Range;
  bucketMs: number;
  at: string[];
  buckets: Bucket[];
}

/** One value per bucket and group, aligned to the series' time axis, zero where nothing happened. */
export function stacked(series: SeriesData, value: (b: Bucket) => number): { groups: Group[]; rows: number[][] } {
  const index = new Map(series.at.map((t, i) => [t, i]));
  const groups = GROUPS.filter((g) => series.buckets.some((b) => groupOf(b.role) === g));
  const rows = series.at.map(() => groups.map(() => 0));
  for (const b of series.buckets) {
    const g = groupOf(b.role);
    const i = index.get(b.at);
    if (g && i !== undefined) rows[i]![groups.indexOf(g)]! += value(b);
  }
  return { groups, rows };
}

/** Prompt tokens served from the cache, prompt tokens sent fresh, and output tokens, per bucket. */
export function tokenRows(series: SeriesData): number[][] {
  const index = new Map(series.at.map((t, i) => [t, i]));
  const rows = series.at.map(() => [0, 0, 0]);
  for (const b of series.buckets) {
    const i = index.get(b.at);
    if (i === undefined) continue;
    const cached = Math.min(b.cacheReadTokens, b.promptTokens);
    rows[i]![0]! += cached;
    rows[i]![1]! += b.promptTokens - cached;
    rows[i]![2]! += b.outputTokens;
  }
  return rows;
}

/** A value per bucket summed over every role. */
export function totalPerBucket(series: SeriesData, value: (b: Bucket) => number): number[] {
  const index = new Map(series.at.map((t, i) => [t, i]));
  const out = series.at.map(() => 0);
  for (const b of series.buckets) {
    const i = index.get(b.at);
    if (i !== undefined) out[i]! += value(b);
  }
  return out;
}

/** A ratio per bucket over some of the roles; null where the denominator is zero. */
export function ratio(series: SeriesData, roles: Role[], top: (b: Bucket) => number, bottom: (b: Bucket) => number): (number | null)[] {
  const index = new Map(series.at.map((t, i) => [t, i]));
  const t = series.at.map(() => 0), d = series.at.map(() => 0);
  for (const b of series.buckets) {
    const i = index.get(b.at);
    if (i !== undefined && roles.includes(b.role)) { t[i]! += top(b); d[i]! += bottom(b); }
  }
  return t.map((n, i) => (d[i]! > 0 ? n / d[i]! : null));
}

/** An average per bucket weighted by calls over some of the roles, from the buckets that have one. */
export function average(series: SeriesData, roles: Role[], pick: (b: Bucket) => number | null, samples: (b: Bucket) => number = (b) => b.calls): (number | null)[] {
  const index = new Map(series.at.map((t, i) => [t, i]));
  const sum = series.at.map(() => 0), n = series.at.map(() => 0);
  for (const b of series.buckets) {
    const i = index.get(b.at);
    const v = pick(b);
    if (i !== undefined && roles.includes(b.role) && v !== null) { const count = samples(b); sum[i]! += v * count; n[i]! += count; }
  }
  return sum.map((v, i) => (n[i]! > 0 ? v / n[i]! : null));
}

/** Round axis ticks from zero: 0, 50, 100 for a maximum of 87. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

/** A bucket's start for an axis label: the hour for short buckets, the day for long ones. */
export function axisLabel(at: string, bucketMs: number, locale?: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return bucketMs < 86_400_000 ? d.toLocaleTimeString(locale, { hour: "numeric", minute: bucketMs < 3_600_000 ? "2-digit" : undefined }) : d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

export interface TraceCall {
  kind: "call";
  at: string;
  call: CallRow;
  group: "router" | "turn";
  turnId: string | null;
  reasoning: string | null;
  reasoningTextTokens: number;
  text: string;
  toolCalls: { id: string; name: string; input: unknown; result: { content: string; isError: boolean; tokens: number } | null }[];
  entered: { role: string; label: string; tokens: number; text: string }[];
  rebuilt: boolean;
  context: ContextBlock[] | null;
}

export type TraceItem =
  | { kind: "user"; at: string; text: string; attachments: string[]; lane: number | null }
  | TraceCall
  | { kind: "routing"; at: string; routing: NonNullable<QuestionDetail["routing"]>; clarification: string | null }
  | { kind: "turn"; at: string; part: PartView }
  | { kind: "compaction"; at: string; turnId: string; compaction: PartView["compactions"][number] }
  | { kind: "answer"; at: string; turnId: string; status: string; text: string | null; stopped: string | null };

export interface Trace {
  question: QuestionDetail["question"];
  items: TraceItem[];
}

export interface DbTable { name: string; kind: "table" | "virtual" | "internal"; rows: number; columns: number }
export interface DbOverview { id: string; label: string; about: string; bytes: number; tables: DbTable[]; records: number }
export interface DataOverview {
  databases: DbOverview[];
  totals: { databases: number; tables: number; records: number; bytes: number };
  files: { name: string; about: string; bytes: number; files: number | null }[];
  index: { documents: number } | null;
}
export interface DbColumn { name: string; type: string; primaryKey: boolean }
export type Cell = string | number | null;
export interface DbPage { columns: DbColumn[]; ids: (number | null)[]; rows: Cell[][]; total: number; matched: number }
export interface DbRow { columns: DbColumn[]; values: Cell[] }
