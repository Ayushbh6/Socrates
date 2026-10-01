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

export type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string; isError?: boolean };

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
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

export type StopReason = "end" | "tool_use" | "max_tokens" | "other";

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: ModelUsage;
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
