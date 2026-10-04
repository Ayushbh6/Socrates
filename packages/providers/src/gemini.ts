import { ModelError, type ModelClient, type ModelMessage, type ModelRequest, type ModelResponse, userText } from "@socrates/contracts";
import { idleGuard, serverSentEvents } from "./stream";

export interface GeminiInteractionsOptions {
  model: string;
  apiKey?: string;
  /** Stable Interactions API by default; injectable for transport tests. */
  baseURL?: string;
  thinkingLevel?: "low" | "medium" | "high";
  fetch?: typeof globalThis.fetch;
  /** A reply fails after this long: for a streamed reply, without receiving anything. */
  timeoutMs?: number;
}

type Step = Record<string, unknown> & { type: string };
interface Interaction {
  model?: string;
  status: string;
  steps?: Step[];
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_cached_tokens?: number; total_thought_tokens?: number };
}

/** Stateless Interactions keeps the local event log authoritative. All native
 * output steps, including thought signatures, are replayed unchanged. */
export class GeminiInteractionsModel implements ModelClient {
  readonly id: string;
  private readonly fetch: typeof globalThis.fetch;
  constructor(private readonly options: GeminiInteractionsOptions) {
    this.id = `gemini:interactions:${options.model}`;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) throw new ModelError("Request aborted.", "aborted");
    const key = this.options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) throw new ModelError("Gemini API credentials are missing.", "authentication");
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    const streaming = request.onText !== undefined;
    const guard = streaming ? idleGuard(request.signal, timeoutMs) : null;
    const signal = guard?.signal ?? AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])]);
    try {
      return await this.request(request, key, signal, guard);
    } finally {
      guard?.stop();
    }
  }

  private async request(request: ModelRequest, key: string, signal: AbortSignal, guard: ReturnType<typeof idleGuard> | null): Promise<ModelResponse> {
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseURL ?? "https://generativelanguage.googleapis.com/v1"}/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal,
        body: JSON.stringify({
          model: this.options.model,
          system_instruction: request.system,
          input: toGeminiSteps(request.messages, this.id),
          store: false,
          stream: guard !== null,
          // Interactions has no "no new calls" switch; a request that must not call tools sends none.
          ...(request.tools?.length && request.toolChoice !== "none" ? { tools: request.tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })) } : {}),
          generation_config: { max_output_tokens: request.maxOutputTokens ?? 16_000, thinking_level: this.options.thinkingLevel ?? "low" },
        }),
      });
    } catch {
      if (request.signal?.aborted) throw new ModelError("Request aborted.", "aborted");
      throw new ModelError("Could not reach Gemini Interactions.", "network");
    }
    if (!response.ok) {
      const s = response.status;
      throw new ModelError("Gemini Interactions rejected the request.", s === 401 || s === 403 ? "authentication" : s === 429 ? "rate_limit" : s >= 500 ? "server" : "invalid_request", s);
    }
    let interaction: Interaction;
    try { interaction = guard ? await readStream(response, request.onText!, guard.touch) : await response.json() as Interaction; }
    catch (error) {
      if (request.signal?.aborted) throw new ModelError("Request aborted.", "aborted");
      if (error instanceof ModelError) throw error;
      if (signal.aborted) throw new ModelError("Gemini response timed out.", "network");
      if (guard) throw new ModelError("The Gemini stream ended early.", "network");
      throw new ModelError("Gemini returned an invalid response.", "server");
    }
    if (interaction.status === "cancelled") throw new ModelError("Request aborted.", "aborted");
    if (!["completed", "requires_action", "incomplete"].includes(interaction.status)) {
      throw new ModelError("Gemini interaction did not complete.", "server");
    }
    const steps = interaction.steps ?? [];
    if (!Array.isArray(steps) || steps.some(s => !s || typeof s !== "object" || typeof s.type !== "string")) throw new ModelError("Gemini returned invalid output steps.", "server");
    const toolCalls = steps.filter(s => s.type === "function_call").map(s => {
      if (typeof s.id !== "string" || typeof s.name !== "string" || !s.arguments || typeof s.arguments !== "object" || Array.isArray(s.arguments)) {
        throw new ModelError("Gemini returned an invalid function call.", "server");
      }
      return { id: s.id, name: s.name, input: s.arguments };
    });
    const text = steps.filter(s => s.type === "model_output").flatMap(s => Array.isArray(s.content) ? s.content : [])
      .filter((c: { type: string; text?: unknown } | null) => c?.type === "text" && typeof c.text === "string").map((c: { text: string }) => c.text).join("");
    const u = interaction.usage;
    return {
      text, toolCalls,
      stopReason: toolCalls.length ? "tool_use" : interaction.status === "incomplete" ? "max_tokens" : "end",
      usage: { promptTokens: u?.total_input_tokens ?? 0, outputTokens: (u?.total_output_tokens ?? 0) + (u?.total_thought_tokens ?? 0), cacheReadTokens: u?.total_cached_tokens ?? 0, cacheWriteTokens: 0 },
      raw: { provider: this.id, content: structuredClone(steps) },
      ...(interaction.model ? { servedBy: interaction.model } : {}),
    };
  }
}

export function toGeminiSteps(messages: ModelMessage[], provider: string): Step[] {
  return messages.flatMap((m): Step[] => {
    if (m.role === "user") return [{ type: "user_input", content: [{ type: "text", text: userText(m.content) }] }];
    if (m.role === "tool") return [{ type: "function_result", call_id: m.toolCallId, name: m.toolName, result: [{ type: "text", text: m.content }], ...(m.isError ? { is_error: true } : {}) }];
    if (m.raw?.provider === provider && Array.isArray(m.raw.content)) return structuredClone(m.raw.content) as Step[];
    return [
      ...(m.content ? [{ type: "model_output", content: [{ type: "text", text: m.content }] }] : []),
      ...(m.toolCalls ?? []).map(c => ({ type: "function_call", id: c.id, name: c.name, arguments: c.input })),
    ];
  });
}

/**
 * The interaction rebuilt from a streamed reply. Its completion event carries
 * the status and usage but not the steps, so the steps are assembled from the
 * step events in the shape the plain reply has them: a thought keeps its
 * signature, a model output its text, a function call its parsed arguments.
 * Text reaches `onText` as it arrives.
 */
async function readStream(response: Response, onText: (delta: string) => void, touch: () => void): Promise<Interaction> {
  if (!response.body) throw new ModelError("Gemini returned an invalid response.", "server");
  const steps: Step[] = [];
  const arguments_: string[] = [];
  for await (const { data } of serverSentEvents(response.body)) {
    touch();
    if (data === "[DONE]") break;
    let event: { event_type?: string; index?: number; step?: Step; delta?: Record<string, unknown> & { type?: string }; interaction?: Interaction; message?: string };
    try { event = JSON.parse(data); } catch { throw new ModelError("Gemini returned an invalid response.", "server"); }
    const index = event.index ?? -1;
    switch (event.event_type) {
      case "step.start":
        steps[index] = structuredClone(event.step ?? { type: "unknown" });
        break;
      case "step.delta": {
        const step = steps[index];
        const delta = event.delta;
        if (!step || !delta) break;
        if (delta.type === "text" && typeof delta.text === "string") {
          const content = ((step.content as { type: string; text: string }[] | undefined) ??= [{ type: "text", text: "" }]);
          content[0]!.text += delta.text;
          if (delta.text) onText(delta.text);
        } else if (delta.type === "thought_signature" && typeof delta.signature === "string") {
          step.signature = delta.signature;
        } else if (delta.type === "arguments_delta" && typeof delta.arguments === "string") {
          arguments_[index] = (arguments_[index] ?? "") + delta.arguments;
        }
        break;
      }
      case "step.stop": {
        const step = steps[index];
        if (step?.type === "function_call" && arguments_[index]) {
          try { step.arguments = JSON.parse(arguments_[index]!); } catch { throw new ModelError("Gemini returned an invalid function call.", "server"); }
        }
        break;
      }
      case "interaction.completed":
        return { ...(event.interaction ?? { status: "completed" }), steps: steps.filter(Boolean) } as Interaction;
      case "error":
        throw new ModelError("Gemini reported an error while streaming.", "server");
    }
  }
  throw new ModelError("The Gemini stream ended early.", "network");
}
