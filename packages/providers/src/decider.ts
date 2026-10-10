import { type CallRecord, type CallSink, type DecisionRequest, type DecisionResponse, type DeciderClient, ModelError } from "@socrates/contracts";
import { newId } from "@socrates/shared";
import { postJson } from "./embeddings";

/** The decider Socrates uses (architecture/agent-harness.md, "Memory"): a classifier that returns probabilities, not text. */
export const DECIDER_MODEL = "perplexity/pplx-decider-v1.1-27b";

/** OpenRouter's decisions endpoint (alpha: the shape may change). */
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/**
 * The decider through OpenRouter. Each question is a yes/no ("noul") question;
 * the reply holds P(yes) for each, and the usage and price of the call.
 */
export class OpenRouterDecider implements DeciderClient {
  readonly id = `openrouter:${DECIDER_MODEL}`;
  constructor(private readonly options: { apiKey: string; url?: string }) {}

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    const questions = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, { type: "noul", instructions: q.instructions, criteria: { true: q.yes, false: q.no } }]));
    const body = (await postJson(this.options.url ?? DECISIONS_URL, { model: DECIDER_MODEL, state: request.state, questions }, { authorization: `Bearer ${this.options.apiKey}` }, signal, "The decider")) as {
      model?: unknown; id?: unknown; answers?: Record<string, { noul?: unknown } | undefined>; usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown };
    };
    const probabilities: Record<string, number> = {};
    for (const name of Object.keys(request.questions)) {
      const p = body.answers?.[name]?.noul;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new ModelError(`The decider gave no usable answer to "${name}".`, "server");
      probabilities[name] = p;
    }
    const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
    const cost = body.usage?.cost;
    return {
      model: typeof body.model === "string" ? body.model : DECIDER_MODEL,
      probabilities,
      usage: { inputTokens: count(body.usage?.input_tokens), outputTokens: count(body.usage?.output_tokens), costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null },
      id: typeof body.id === "string" ? body.id : null,
    };
  }
}

/** The decider, when an OpenRouter key is present; otherwise none. */
export function makeDecider(env: Record<string, string | undefined> = process.env): DeciderClient | null {
  const key = env.OPENROUTER_API_KEY;
  return key ? new OpenRouterDecider({ apiKey: key }) : null;
}

/**
 * A decider that hands every call it makes, finished or failed, to `sink` as a
 * call of role "decision" (architecture/observability.md): the questions and
 * the text as sent, the probabilities as the reply, the price the provider
 * reported. It changes nothing about the call, and the sink never throws into
 * the caller.
 */
export function withDecisionRecording(decider: DeciderClient, sink: CallSink): DeciderClient {
  return {
    id: decider.id,
    decide: async (request, signal) => {
      const startedAt = new Date().toISOString();
      const t0 = performance.now();
      const finish = (response: DecisionResponse | null, error: unknown) => {
        const ms = Math.round(performance.now() - t0);
        const record: CallRecord = {
          id: newId("call"),
          startedAt,
          model: decider.id,
          servedBy: response?.model ?? null,
          trace: structuredClone(request.trace ?? { role: "decision" as const }),
          streamed: false,
          request: {
            system: Object.entries(request.questions).map(([name, q]) => `${name}: ${q.instructions}\n  yes: ${q.yes}\n  no: ${q.no}`).join("\n"),
            messages: [{ role: "user", content: request.state }],
            tools: [], toolChoice: "auto", maxOutputTokens: null, temperature: null, effort: null,
          },
          response: response && {
            text: JSON.stringify(response.probabilities),
            toolCalls: [], reasoning: null, stopReason: "end",
            usage: { promptTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
            meta: { probabilities: response.probabilities, id: response.id, ...(response.usage.costUsd !== null ? { usage: { cost: response.usage.costUsd } } : {}) },
          },
          error: error === null ? null : {
            kind: error instanceof ModelError ? error.kind : "unexpected",
            status: error instanceof ModelError ? error.status ?? null : null,
            message: error instanceof Error ? error.message : String(error),
          },
          ms, firstTokenMs: null, tokensPerSecond: null, cost: null,
        };
        try { sink(record); } catch {}
      };
      try {
        const response = await decider.decide(request, signal);
        finish(response, null);
        return response;
      } catch (error) {
        finish(null, error);
        throw error;
      }
    },
  };
}
