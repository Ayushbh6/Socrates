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
}

export type Role = "router" | "work" | "wrap_up" | "repair" | "compaction" | "embedding" | "other";

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

/** A model's id without the long fingerprint an embedding model's id carries. */
export function shortModel(id: string): string {
  return id.replace(/:[0-9a-f]{16,}$/, "");
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

/** The view the address names: `#/inspect` or `#/inspect/<message id>`. */
export function inspectTarget(hash: string): { question: string | null } | null {
  const match = /^#\/inspect(?:\/([A-Za-z0-9_-]+))?$/.exec(hash);
  return match ? { question: match[1] ?? null } : null;
}
