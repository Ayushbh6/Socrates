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
import { idleGuard } from "./stream";

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
  /** A streamed reply fails after this long without receiving anything. */
  idleMs?: number;
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

    let completion: Completion;
    try {
      completion = request.onText ? await this.stream(params, request.onText, request.onReasoning, request.signal) : await this.client.chat.completions.create(params, request.signal ? { signal: request.signal } : undefined);
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
      ...(reasoningOf(message) ? { reasoning: reasoningOf(message) } : {}),
    };
  }

  /** The same request, streamed: text reaches `onText` as it arrives and the complete completion is rebuilt from the chunks. */
  private async stream(params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, onText: (delta: string) => void, onReasoning: ((delta: string) => void) | undefined, signal?: AbortSignal): Promise<Completion> {
    const guard = idleGuard(signal, this.options.idleMs ?? 60_000);
    try {
      const chunks = await this.client.chat.completions.create({ ...params, stream: true, stream_options: { include_usage: true } }, { signal: guard.signal });
      const reply = new ChatReply();
      for await (const chunk of chunks) {
        guard.touch();
        const { text, reasoning } = reply.add(chunk);
        if (reasoning) onReasoning?.(reasoning);
        if (text) onText(text);
      }
      // The SDK ends a stream that was aborted quietly, so the ending is checked here.
      if (guard.idled()) throw new ModelError("The model endpoint stream went quiet.", "network");
      if (signal?.aborted) throw new ModelError("Request aborted.", "aborted");
      if (!reply.finished) throw new ModelError("The model endpoint stream ended early.", "network");
      return reply.completion();
    } catch (error) {
      if (guard.idled()) throw new ModelError("The model endpoint stream went quiet.", "network");
      throw error;
    } finally {
      guard.stop();
    }
  }
}

type Completion = Pick<OpenAI.Chat.ChatCompletion, "model" | "usage"> & {
  choices: { finish_reason: string | null; message: OpenAI.Chat.ChatCompletionMessage }[];
};

/** The readable reasoning of a completion message: DeepSeek's reasoning_content or OpenRouter's reasoning. */
function reasoningOf(message: OpenAI.Chat.ChatCompletionMessage | undefined): string | undefined {
  const fields = message as { reasoning_content?: unknown; reasoning?: unknown } | undefined;
  const text = typeof fields?.reasoning_content === "string" ? fields.reasoning_content : typeof fields?.reasoning === "string" ? fields.reasoning : "";
  return text.trim() ? text : undefined;
}

const MERGED_DETAIL_FIELDS = new Set(["text", "summary", "data"]);

/**
 * The completion rebuilt from streamed chunks. The SDK's own accumulator
 * overwrites provider fields it does not know, but the replay depends on them
 * whole (DeepSeek's reasoning_content, OpenRouter's signed reasoning_details),
 * so every field is joined here: strings are appended, reasoning details are
 * merged by index, and tool calls are joined by index.
 */
export class ChatReply {
  private text = "";
  private finish: string | null = null;
  private model = "";
  private usage: OpenAI.CompletionUsage | undefined;
  private readonly extra: Record<string, unknown> = {};
  private readonly calls: { id: string; name: string; args: string }[] = [];

  /** Whether a choice has finished: a stream that ended without one was cut off. */
  get finished(): boolean {
    return this.finish !== null;
  }

  /** Take one chunk; returns the text and the readable reasoning it carried. */
  add(chunk: OpenAI.Chat.ChatCompletionChunk): { text: string; reasoning: string } {
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return { text: "", reasoning: "" };
    if (choice.finish_reason) this.finish = choice.finish_reason;
    const { role: _role, content, tool_calls, ...rest } = choice.delta as Record<string, unknown> & { content?: string | null; tool_calls?: OpenAI.Chat.ChatCompletionChunk.Choice.Delta.ToolCall[] };
    for (const [key, value] of Object.entries(rest)) {
      if (value === null || value === undefined) continue;
      if (key === "reasoning_details" && Array.isArray(value)) this.mergeDetails(value);
      else if (typeof value === "string") this.extra[key] = `${(this.extra[key] as string | undefined) ?? ""}${value}`;
      else this.extra[key] = value;
    }
    for (const call of tool_calls ?? []) {
      const own = (this.calls[call.index] ??= { id: "", name: "", args: "" });
      if (call.id) own.id = call.id;
      if (call.function?.name) own.name += call.function.name;
      if (call.function?.arguments) own.args += call.function.arguments;
    }
    // DeepSeek streams its reasoning as reasoning_content, OpenRouter as reasoning.
    const reasoning = typeof rest.reasoning_content === "string" ? rest.reasoning_content : typeof rest.reasoning === "string" ? rest.reasoning : "";
    if (content) this.text += content;
    return { text: content ?? "", reasoning };
  }

  completion(): Completion {
    const tool_calls = this.calls.filter(Boolean).map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } }));
    const message = { role: "assistant", content: this.text || null, ...this.extra, ...(tool_calls.length ? { tool_calls } : {}) } as OpenAI.Chat.ChatCompletionMessage;
    return { model: this.model, ...(this.usage ? { usage: this.usage } : {}), choices: [{ finish_reason: this.finish, message }] };
  }

  private mergeDetails(chunk: unknown[]): void {
    const details = ((this.extra.reasoning_details as Record<string, unknown>[] | undefined) ??= []);
    for (const item of chunk as Record<string, unknown>[]) {
      const own = typeof item.index === "number" ? details.find((d) => d.index === item.index && d.type === item.type) : undefined;
      if (!own) {
        details.push({ ...item });
        continue;
      }
      for (const [key, value] of Object.entries(item)) {
        if (value === null || value === undefined) continue;
        own[key] = MERGED_DETAIL_FIELDS.has(key) && typeof value === "string" ? `${(own[key] as string | undefined) ?? ""}${value}` : value;
      }
    }
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
  if (error instanceof ModelError) return error;
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
