import { type CallRecord, type CallSink, type DecisionRequest, type DecisionResponse, type DeciderClient, ModelError } from "@socrates/contracts";
import { abortable, newId } from "@socrates/shared";
import { decisionOverflow, decisionTokens, DECIDER_INPUT_TOKENS } from "./decision-budget";
import { postJson } from "./embeddings";

/** The decider Socrates uses (architecture/agent-harness.md, "Memory"): a classifier that returns probabilities, not text. */
export const DECIDER_MODEL = "perplexity/pplx-decider-v1.2";
export const DECIDER_BACKUP_MODEL = "typesafe/jev-1.14";

/** OpenRouter's decisions endpoint (alpha: the shape may change). */
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

function validateInput(request: DecisionRequest): void {
  const overflow = decisionOverflow(request);
  if (overflow) throw new ModelError(overflow, "invalid_request");
  if (request.images?.some(image => image.mediaType === "image/gif")) throw new ModelError("Decider images must be normalized to PNG, JPEG or WebP", "invalid_request");
}

/**
 * The decider through OpenRouter. Each question is a yes/no ("noul") question;
 * the reply holds P(yes) for each, and the usage and price of the call.
 */
export class OpenRouterDecider implements DeciderClient {
  readonly id: string;
  constructor(private readonly options: { apiKey: string; url?: string; model?: typeof DECIDER_MODEL | typeof DECIDER_BACKUP_MODEL }) {
    this.id = `openrouter:${options.model ?? DECIDER_MODEL}`;
  }

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    validateInput(request);
    const state = request.images?.length ? [request.state, ...request.images.map(image => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } }))] : request.state;
    const questions = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, { type: "noul", instructions: q.instructions, criteria: { true: q.yes, false: q.no } }]));
    const model = this.options.model ?? DECIDER_MODEL;
    const body = (await postJson(this.options.url ?? DECISIONS_URL, { model, state, questions }, { authorization: `Bearer ${this.options.apiKey}` }, signal, "The decider")) as {
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
      model: typeof body.model === "string" ? body.model : model,
      probabilities,
      usage: { inputTokens: count(body.usage?.input_tokens), outputTokens: count(body.usage?.output_tokens), costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null },
      id: typeof body.id === "string" ? body.id : null,
    };
  }
}

/** Reserve half the caller's budget (up to 5 seconds) for the backup. A failed primary rests for
 * 30 seconds; successful backup calls do not extend that cooldown. */
export class FailoverDecider implements DeciderClient {
  readonly id: string;
  private primaryUnavailableUntil = 0;

  constructor(private readonly options: { primary: DeciderClient; backup: DeciderClient; now?: () => number }) {
    this.id = options.primary.id;
  }

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    signal?.throwIfAborted();
    validateInput(request);
    const now = this.options.now ?? Date.now;
    const timeoutMs = request.timeoutMs ?? 2_000;
    const controller = new AbortController();
    const limit = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => controller.abort(new ModelError("The decider deadline was reached.", "aborted")), timeoutMs);
    try {
      if (now() >= this.primaryUnavailableUntil) {
        const primaryController = new AbortController();
        const primaryLimit = AbortSignal.any([limit, primaryController.signal]);
        const primaryTimer = setTimeout(() => primaryController.abort(new ModelError("The primary decider timed out; trying the backup.", "aborted")), timeoutMs - Math.min(timeoutMs / 2, 5_000));
        try {
          return await abortable(this.options.primary.decide(request, primaryLimit), primaryLimit);
        } catch (error) {
          // The two models share credentials/billing. Retrying cannot fix those,
          // invalid local input, or a user stop / exhausted overall deadline.
          if (limit.aborted || (error instanceof ModelError && (error.kind === "authentication" || error.status === 402))) throw error;
          this.primaryUnavailableUntil = now() + 30_000;
        } finally {
          clearTimeout(primaryTimer);
        }
      }
      limit.throwIfAborted();
      return await abortable(this.options.backup.decide(request, limit), limit);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Record individual attempts, so a recovered primary error and backup cost
 * remain visible under their actual models rather than one combined call. */
export function makeDecider(env: Record<string, string | undefined> = process.env, sink?: CallSink): DeciderClient | null {
  const key = env.OPENROUTER_API_KEY;
  if (!key) return null;
  const client = (model: typeof DECIDER_MODEL | typeof DECIDER_BACKUP_MODEL) => {
    const decider = new OpenRouterDecider({ apiKey: key, model });
    return sink ? withDecisionRecording(decider, sink) : decider;
  };
  return new FailoverDecider({ primary: client(DECIDER_MODEL), backup: client(DECIDER_BACKUP_MODEL) });
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
            messages: [{ role: "user", content: request.state, ...(request.images?.length ? { images: request.images } : {}) }],
            tools: [], toolChoice: "auto", maxOutputTokens: null, temperature: null, effort: null,
          },
          response: response && {
            text: JSON.stringify(response.probabilities),
            toolCalls: [], reasoning: null, stopReason: "end",
            usage: { promptTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
            meta: { inputBudget: DECIDER_INPUT_TOKENS, estimatedInputTokens: decisionTokens(request), imageCount: request.images?.length ?? 0, probabilities: response.probabilities, id: response.id, ...(response.usage.costUsd !== null ? { usage: { cost: response.usage.costUsd } } : {}) },
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
        const pending = decider.decide(request, signal);
        const response = await (signal ? abortable(pending, signal) : pending);
        finish(response, null);
        return response;
      } catch (error) {
        finish(null, error);
        throw error;
      }
    },
  };
}
