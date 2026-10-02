import OpenAI from "openai";
import {
  type ModelClient,
  ModelError,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type ToolCall,
  userText,
} from "@socrates/contracts";

export interface OpenAICompatibleModelOptions {
  model: string;
  /** Name used in the model id, e.g. "openai" or "deepseek". */
  provider?: string;
  apiKey?: string;
  /** Any OpenAI-compatible Chat Completions endpoint, e.g. DeepSeek's. */
  baseURL?: string;
  /** OpenAI uses `max_completion_tokens`; many compatible servers still expect `max_tokens`. */
  maxTokensParam?: "max_completion_tokens" | "max_tokens";
  /** Send `temperature` when set. Some reasoning models reject it. */
  sampling?: boolean;
  client?: OpenAI;
  /** Provider extensions, for example DeepSeek's thinking or reasoning_effort. */
  extraBody?: Record<string, unknown>;
}

/** Adapter from the normalized model contract to OpenAI-compatible Chat Completions. */
export class OpenAICompatibleModel implements ModelClient {
  readonly id: string;
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAICompatibleModelOptions) {
    this.id = `${options.provider ?? "openai"}:${options.model}`;
    this.client =
      options.client ??
      new OpenAI({
        timeout: 60_000,
        maxRetries: 0,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const maxTokens = request.maxOutputTokens ?? 16_000;
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      ...this.options.extraBody,
      model: this.options.model,
      messages: [{ role: "system", content: request.system }, ...toOpenAIMessages(request.messages, this.id)],
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            ...(request.toolChoice === "none" ? { tool_choice: "none" as const } : {}),
          }
        : {}),
      ...((this.options.maxTokensParam ?? "max_completion_tokens") === "max_tokens"
        ? { max_tokens: maxTokens }
        : { max_completion_tokens: maxTokens }),
      ...((this.options.sampling ?? true) && request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(params, request.signal ? { signal: request.signal } : undefined);
    } catch (error) {
      throw toModelError(error);
    }

    const choice = completion.choices[0];
    const message = choice?.message;
    const toolCalls: ToolCall[] = [];
    for (const call of message?.tool_calls ?? []) {
      if (call.type !== "function") continue;
      let input: unknown;
      try {
        input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        input = call.function.arguments;
      }
      toolCalls.push({ id: call.id, name: call.function.name, input });
    }
    const usage = completion.usage;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? (usage as (typeof usage & { prompt_cache_hit_tokens?: number }))?.prompt_cache_hit_tokens ?? 0;
    return {
      text: message?.content ?? "",
      toolCalls,
      stopReason: toStopReason(choice?.finish_reason ?? null),
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      servedBy: completion.model,
      ...(message ? { raw: { provider: this.id, content: structuredClone(message) } } : {}),
    };
  }
}

export function toOpenAIMessages(messages: ModelMessage[], provider?: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
    if (m.role === "user") return { role: "user", content: userText(m.content) };
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    // Replay the complete native message on the same endpoint/model. DeepSeek
    // reasoning_content and OpenRouter signed reasoning_details are mandatory
    // on subsequent tool rounds. Never transfer those signatures to another model.
    if (provider && m.raw?.provider === provider) {
      return structuredClone(m.raw.content) as OpenAI.Chat.ChatCompletionMessageParam;
    }
    return {
      role: "assistant",
      content: m.content || null,
      ...(m.toolCalls?.length
        ? {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: typeof c.input === "string" ? c.input : JSON.stringify(c.input) },
            })),
          }
        : {}),
    };
  });
}

function toStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

function toModelError(error: unknown): ModelError {
  if (error instanceof OpenAI.APIUserAbortError) return new ModelError("Request aborted.", "aborted");
  if (error instanceof OpenAI.APIConnectionError) return new ModelError("Could not reach the model endpoint.", "network");
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new ModelError("The model endpoint rejected the credentials.", "authentication", error.status);
  }
  if (error instanceof OpenAI.RateLimitError) return new ModelError("Rate limit reached.", "rate_limit", error.status);
  if (error instanceof OpenAI.InternalServerError) return new ModelError("Model endpoint server error.", "server", error.status);
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    return new ModelError("Model endpoint rejected the request.", status >= 500 ? "server" : "invalid_request", status || undefined);
  }
  return new ModelError("Unexpected model endpoint failure.", "server");
}
