import type { ModelClient, ModelRequest, ModelResponse, ToolCall } from "@socrates/contracts";

const STREAM_PIECE = 8;

/** A scripted reply; `reasoning` is readable thinking, streamed before the text. */
type Scripted = { text: string; reasoning?: string } | { toolCalls: Omit<ToolCall, "id">[]; text?: string; reasoning?: string };

export type ScriptedStep = Scripted | ((request: ModelRequest) => ModelResponse | Scripted);

/**
 * A deterministic model for tests and fixtures. It replays scripted steps in
 * order and records every request it received.
 */
export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private index = 0;
  private callCounter = 0;

  constructor(
    readonly id: string,
    private readonly steps: ScriptedStep[],
  ) {}

  get remaining(): number {
    return this.steps.length - this.index;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone({ ...request, signal: undefined, onText: undefined, onReasoning: undefined }));
    const step = this.steps[this.index++];
    if (step === undefined) throw new Error(`ScriptedModel ${this.id} has no step ${this.index}.`);
    const out = typeof step === "function" ? step(request) : step;
    const response = this.respond(out);
    // Streams its thinking, then its text, in small pieces, as a provider does.
    if (request.onText && request.onReasoning && response.reasoning) for (let at = 0; at < response.reasoning.length; at += STREAM_PIECE) request.onReasoning(response.reasoning.slice(at, at + STREAM_PIECE));
    if (request.onText) for (let at = 0; at < response.text.length; at += STREAM_PIECE) request.onText(response.text.slice(at, at + STREAM_PIECE));
    return response;
  }

  private respond(out: ModelResponse | Scripted): ModelResponse {
    if ("usage" in out) return out;
    const toolCalls = "toolCalls" in out ? out.toolCalls.map((c) => ({ ...c, id: `call_${++this.callCounter}` })) : [];
    return {
      text: out.text ?? "",
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "end",
      usage: { promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...(out.reasoning ? { reasoning: out.reasoning } : {}),
    };
  }
}
