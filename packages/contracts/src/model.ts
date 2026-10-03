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

export type ModelMessage =
  | { role: "user"; content: string | TextPart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: ProviderContent }
  | { role: "tool"; toolCallId: string; toolName: string; content: string; isError?: boolean; cache?: boolean };

/** The plain text of a user message, whichever form it has. */
export function userText(content: string | TextPart[]): string {
  return typeof content === "string" ? content : content.map((p) => p.text).join("");
}

/** Whether a request marks any prompt-cache breakpoint. */
export function hasCacheBreakpoints(messages: ModelMessage[]): boolean {
  return messages.some((m) => (m.role === "tool" && m.cache) || (m.role === "user" && typeof m.content !== "string" && m.content.some((p) => p.cache)));
}

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
}

export interface ModelClient {
  /** Human-readable identity, e.g. "anthropic:claude-sonnet-5-5". */
  readonly id: string;
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
