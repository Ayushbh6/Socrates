import Anthropic from "@anthropic-ai/sdk";
import {
  type ModelClient,
  hasCacheBreakpoints,
  ModelError,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type ToolCall,
} from "@socrates/contracts";
import { idleGuard } from "./stream";

const PROVIDER = "anthropic";

/** Models that accept the server-side refusal fallback in its `"default"` form. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicModelOptions {
  model: string;
  /** Defaults to the SDK's environment resolution (ANTHROPIC_API_KEY, auth token, or `ant auth login` profile). */
  apiKey?: string;
  baseURL?: string;
  /** Reasoning effort (`output_config.effort`). Omit for the model default; Haiku 4.5 does not accept it. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Send `temperature` when the request sets one. Current Opus and Sonnet
   * models reject sampling parameters, so this is off by default.
   */
  sampling?: boolean;
  /** Re-run a refused request on a fallback model inside the same call. On by default where supported. */
  refusalFallback?: boolean;
  /** A streamed reply fails after this long without receiving anything. */
  idleMs?: number;
  client?: Anthropic;
}

/**
 * Adapter from the normalized model contract to the Anthropic Messages API.
 * Assistant turns carry their raw content blocks so thinking and fallback
 * blocks are replayed unchanged; history is only ever appended.
 */
export class AnthropicModel implements ModelClient {
  readonly id: string;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicModelOptions) {
    this.id = `${PROVIDER}:${options.model}`;
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const fallback = (this.options.refusalFallback ?? true) && FALLBACK_MODELS.has(this.options.model);
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: this.options.model,
      max_tokens: request.maxOutputTokens ?? 16_000,
      // A request with breakpoints also caches the tools and system prompt that precede them.
      system: hasCacheBreakpoints(request.messages) ? [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }] : request.system,
      messages: toAnthropicMessages(request.messages),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
            })),
            ...(request.toolChoice === "none" ? { tool_choice: { type: "none" as const } } : {}),
          }
        : {}),
      ...(this.options.sampling && request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(this.options.effort ? { output_config: { effort: this.options.effort } } : {}),
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = request.onText ? await this.stream(params, request.onText, request.onReasoning, request.signal) : await this.client.beta.messages.create(params, request.signal ? { signal: request.signal } : undefined);
    } catch (error) {
      throw toModelError(error);
    }

    const toolCalls: ToolCall[] = [];
    const text: string[] = [];
    const thinking: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") text.push(block.text);
      else if (block.type === "thinking" && block.thinking) thinking.push(block.thinking);
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    const u = message.usage;
    return {
      text: text.join(""),
      toolCalls,
      stopReason: toStopReason(message.stop_reason),
      usage: {
        promptTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
      raw: { provider: PROVIDER, content: message.content },
      servedBy: message.model,
      ...(thinking.length ? { reasoning: thinking.join("\n\n") } : {}),
    };
  }

  /** The same request, streamed: text reaches `onText` as it arrives and the complete message comes back. */
  private async stream(params: Anthropic.Beta.MessageCreateParamsNonStreaming, onText: (delta: string) => void, onReasoning: ((delta: string) => void) | undefined, signal?: AbortSignal): Promise<Anthropic.Beta.BetaMessage> {
    const guard = idleGuard(signal, this.options.idleMs ?? 60_000);
    try {
      const stream = this.client.beta.messages.stream(params, { signal: guard.signal });
      stream.on("streamEvent", guard.touch);
      stream.on("text", onText);
      if (onReasoning) stream.on("thinking", (delta) => { if (delta) onReasoning(delta); });
      return await stream.finalMessage();
    } catch (error) {
      if (guard.idled()) throw new ModelError("The Anthropic stream went quiet.", "network");
      throw error;
    } finally {
      guard.stop();
    }
  }
}

/** Convert normalized messages. Consecutive tool results become one user message, as the API expects. */
export function toAnthropicMessages(messages: ModelMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const content = typeof m.content === "string" ? m.content : m.content.map((p) => ({ type: "text" as const, text: p.text, ...(p.cache ? { cache_control: { type: "ephemeral" as const } } : {}) }));
      const last = out.at(-1);
      // A user message right after tool results (such as a harness request) joins their user turn.
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push(...(typeof content === "string" ? [{ type: "text" as const, text: content }] : content));
      } else {
        out.push({ role: "user", content });
      }
    } else if (m.role === "assistant") {
      if (m.raw?.provider === PROVIDER) {
        out.push({ role: "assistant", content: m.raw.content as Anthropic.Beta.BetaContentBlockParam[] });
        continue;
      }
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      out.push({ role: "assistant", content });
    } else {
      const block: Anthropic.Beta.BetaToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
        ...(m.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

function toStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new ModelError("Request aborted.", "aborted");
  if (error instanceof Anthropic.APIConnectionError) return new ModelError("Could not reach the Anthropic API.", "network");
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ModelError("Anthropic rejected the credentials.", "authentication", error.status);
  }
  if (error instanceof Anthropic.RateLimitError) return new ModelError("Anthropic rate limit reached.", "rate_limit", error.status);
  if (error instanceof Anthropic.InternalServerError) return new ModelError("Anthropic server error.", "server", error.status);
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return new ModelError(`Anthropic request failed: ${error.message}`, status >= 500 ? "server" : "invalid_request", status || undefined);
  }
  return new ModelError(error instanceof Error ? error.message : String(error), "server");
}
