/**
 * The normalized model contract (agent-harness.md, "Provider independence").
 * Routing, compaction, tools, and persistence depend only on these types;
 * each provider adapter translates them to and from its own API.
 */

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * The provider's own representation of an assistant turn. Adapters replay it
 * byte-for-byte when the conversation continues on the same provider, so
 * provider-specific blocks (for example thinking blocks that must be passed
 * back unchanged) survive the normalized contract. Other providers ignore it.
 */
export interface ProviderContent {
  provider: string;
  content: unknown;
}

/**
 * One piece of a user message. `cache` marks a prompt-cache breakpoint after
 * this piece (agent-harness.md, "Prompt caching"): adapters whose provider
 * needs explicit breakpoints set one there; providers that cache prefixes
 * automatically ignore it. A request carrying any breakpoint also caches its
 * system prompt and tool definitions.
 */
export interface TextPart {
  text: string;
  cache?: boolean;
}

/**
 * One image a model is shown (agent-harness.md, "Images"): base64 bytes of a
 * format every vision provider accepts. Only a model that can see receives
 * images; the harness never sends them to one that cannot.
 */
export interface ImageData {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** The image's bytes, base64-encoded. */
  data: string;
}

/** `images`: shown to the model with the user's message or the tool's result. */
export type ModelMessage =
  | { role: "user"; content: string | TextPart[]; images?: ImageData[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: ProviderContent }
  | { role: "tool"; toolCallId: string; toolName: string; content: string; isError?: boolean; cache?: boolean; images?: ImageData[] };

/** The plain text of a user message, whichever form it has. */
export function userText(content: string | TextPart[]): string {
  return typeof content === "string" ? content : content.map((p) => p.text).join("");
}

/** Whether a request marks any prompt-cache breakpoint. */
export function hasCacheBreakpoints(messages: ModelMessage[]): boolean {
  return messages.some((m) => (m.role === "tool" && m.cache) || (m.role === "user" && typeof m.content !== "string" && m.content.some((p) => p.cache)));
}

/**
 * How hard a model thinks before it answers, in one vocabulary for every
 * provider. A model accepts only some levels (`detectEfforts`); "off" turns
 * thinking off where the model allows it.
 */
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  /**
   * "none" keeps the tool definitions (a conversation that already holds tool
   * calls may need them) but forbids new calls, as in the working agent's
   * wrap-up after a limit. Default "auto".
   */
  toolChoice?: "auto" | "none";
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Called with each piece of the reply's text as it arrives. A client that
   * receives it streams the request and still returns the complete response;
   * without it the request is not streamed. A failed attempt may have emitted
   * text already, so a retry starts the text again from its beginning.
   */
  onText?: (delta: string) => void;
  /**
   * Called with each piece of the model's readable thinking (its reasoning,
   * or the provider's summary of it) while a streamed reply arrives. For
   * display only: replay uses the raw content.
   */
  onReasoning?: (delta: string) => void;
  /** The thinking level for this request; without it the client's own default applies. Only levels the model accepts. */
  effort?: Effort;
  /** Who is asking and for which message, so the call can be recorded and found again. Providers ignore it. */
  trace?: CallTrace;
}

/** Which part of Socrates makes a model call. */
export const CALL_ROLES = ["router", "work", "wrap_up", "repair", "compaction", "embedding", "decision", "other"] as const;
export type CallRole = (typeof CALL_ROLES)[number];

/**
 * What a model call is for (architecture/observability.md). Only the ids
 * known at the call site are set: the router has the message but no turn yet.
 */
export interface CallTrace {
  role: CallRole;
  /** The user message this call works on. */
  userEventId?: string | null;
  turnId?: string | null;
  laneId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  chatId?: string | null;
  /** The nth request of this role for this message or turn, from 1. */
  step?: number;
}

/**
 * Provider-reported usage normalized to one prompt-size number: total prompt
 * tokens including cache reads and cache writes. This feeds the per-model
 * calibration ratio used by the compaction trigger.
 */
export interface ModelUsage {
  promptTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The part of `outputTokens` spent thinking, when the provider says. */
  reasoningTokens?: number;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: ModelUsage;
  /** The provider's raw assistant content, to attach to the assistant message when continuing. */
  raw?: ProviderContent;
  /** The model that actually served the request, when the provider reports it (for example after a fallback). */
  servedBy?: string;
  /**
   * The model's readable thinking, when the provider shows it: its reasoning
   * text or a summary of it. For display only; it is never sent back to a
   * model (the raw content carries what the provider needs).
   */
  reasoning?: string;
  /**
   * What the provider said about the request beyond the normalized fields: its
   * response id, served model, finish reason and its own usage object whole.
   * For inspection only; nothing depends on its shape.
   */
  meta?: Record<string, unknown>;
}

export interface ModelClient {
  /** Human-readable identity, e.g. "anthropic:claude-sonnet-5-5". */
  readonly id: string;
  /** Whether the model can see images. Absent means it cannot, and it is never sent one. */
  readonly vision?: boolean;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Normalized provider failure. Never carries secrets or raw stack traces. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: "authentication" | "rate_limit" | "invalid_request" | "server" | "network" | "aborted",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/**
 * One embedding model (agent-harness.md, "Embeddings"). Queries and stored
 * documents are embedded separately because some models expect a different
 * instruction prefix for each. Vectors are compared by cosine similarity.
 */
export interface EmbeddingClient {
  /** Stable identity of the vector space, including model and endpoint; vectors of different ids never mix. */
  readonly id: string;
  embed(texts: string[], purpose: "query" | "document", signal?: AbortSignal): Promise<number[][]>;
}

/** One yes/no question for the decider: what to judge, and what a yes and a no mean. */
export interface DecisionQuestion {
  instructions: string;
  yes: string;
  no: string;
}

export interface DecisionRequest {
  /** The text the questions are about. */
  state: string;
  /** Questions by name; the answers come back under the same names. */
  questions: Record<string, DecisionQuestion>;
  /** Who is asking, so the call can be recorded and found again. Providers ignore it. */
  trace?: CallTrace;
}

export interface DecisionResponse {
  /** The model that answered, as the provider names it. */
  model: string;
  /** The probability of yes for each question, from 0 to 1. */
  probabilities: Record<string, number>;
  /** `costUsd` is what the provider charged, in dollars, when it says. */
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  id: string | null;
}

/**
 * A model that answers yes/no questions with probabilities instead of text
 * (agent-harness.md, "Memory"): a cheap, fast gate that decides whether a
 * slower step is worth taking. It is not a chat model.
 */
export interface DeciderClient {
  /** The model's identity, such as "openrouter:perplexity/pplx-decider-v1.1-27b". */
  readonly id: string;
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse>;
}
