import type { CallTrace, ModelMessage, ModelUsage, StopReason, ToolCall, ToolDefinition } from "./model";

/**
 * One model call as it is recorded (architecture/observability.md): the exact
 * request, what came back, and how long it took. Written once the call ends.
 */
export interface CallRecord {
  id: string;
  /** When the request was sent, ISO. */
  startedAt: string;
  /** The client's identity, such as "deepseek:deepseek-flash". */
  model: string;
  /** The model that served it, when the provider says. */
  servedBy: string | null;
  trace: CallTrace;
  /** Whether the reply was streamed, which is when the time to the first token is known. */
  streamed: boolean;
  request: {
    system: string;
    messages: ModelMessage[];
    tools: ToolDefinition[];
    toolChoice: "auto" | "none";
    maxOutputTokens: number | null;
    temperature: number | null;
    effort: string | null;
  };
  /** Null when the call failed before the provider answered. */
  response: {
    text: string;
    toolCalls: ToolCall[];
    reasoning: string | null;
    stopReason: StopReason;
    usage: ModelUsage;
    meta: Record<string, unknown> | null;
  } | null;
  error: { kind: string; status: number | null; message: string } | null;
  /** The whole call, from sending to the complete reply. */
  ms: number;
  /** From sending to the first piece of text or thinking; null when not streamed. */
  firstTokenMs: number | null;
  /** Provider output tokens over the whole measured call in seconds, including hidden thinking. */
  tokensPerSecond: number | null;
  /** The call's price in US dollars, where it could be worked out. */
  cost: { usd: number; source: "reported" | "price" } | null;
}

/** Receives each finished call. Never throws into the caller. */
export type CallSink = (record: CallRecord) => void;
