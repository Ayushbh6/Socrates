import { ModelError, type ModelClient, type ModelMessage, type ModelRequest, type ModelResponse } from "@socrates/contracts";

export interface GeminiInteractionsOptions {
  model: string;
  apiKey?: string;
  /** Stable Interactions API by default; injectable for transport tests. */
  baseURL?: string;
  thinkingLevel?: "low" | "medium" | "high";
  fetch?: typeof globalThis.fetch;
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
    const signal = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? 60_000), ...(request.signal ? [request.signal] : [])]);
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
          stream: false,
          ...(request.tools?.length ? { tools: request.tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })) } : {}),
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
    try { interaction = await response.json() as Interaction; }
    catch {
      if (request.signal?.aborted) throw new ModelError("Request aborted.", "aborted");
      if (signal.aborted) throw new ModelError("Gemini response timed out.", "network");
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
    if (m.role === "user") return [{ type: "user_input", content: [{ type: "text", text: m.content }] }];
    if (m.role === "tool") return [{ type: "function_result", call_id: m.toolCallId, name: m.toolName, result: [{ type: "text", text: m.content }], ...(m.isError ? { is_error: true } : {}) }];
    if (m.raw?.provider === provider && Array.isArray(m.raw.content)) return structuredClone(m.raw.content) as Step[];
    return [
      ...(m.content ? [{ type: "model_output", content: [{ type: "text", text: m.content }] }] : []),
      ...(m.toolCalls ?? []).map(c => ({ type: "function_call", id: c.id, name: c.name, arguments: c.input })),
    ];
  });
}
