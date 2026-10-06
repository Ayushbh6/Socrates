import type { CallRecord, CallSink, ModelClient, ModelRequest, ModelResponse } from "@socrates/contracts";
import { ModelError } from "@socrates/contracts";
import { newId } from "@socrates/shared";

/** Very short intervals do not give a meaningful output rate. */
const MIN_CALL_MS = 50;

/**
 * A client that hands every call it makes, finished or failed, to `sink`
 * (architecture/observability.md): the request as it was sent, the reply, the
 * time to the first token and the speed. It changes nothing about the call.
 * The sink never throws into the caller, and a request is recorded as it was
 * when it was sent, whatever the caller does with its messages afterwards.
 */
export function withRecording(model: ModelClient, sink: CallSink): ModelClient {
  return {
    id: model.id,
    ...(model.vision !== undefined ? { vision: model.vision } : {}),
    complete: async (request) => {
      const startedAt = new Date().toISOString();
      const t0 = performance.now();
      let firstTokenMs: number | null = null;
      const first = () => { firstTokenMs ??= Math.round(performance.now() - t0); };
      const snapshot = structuredClone({
        system: request.system,
        messages: [...request.messages],
        tools: [...(request.tools ?? [])],
        toolChoice: request.toolChoice ?? "auto",
        maxOutputTokens: request.maxOutputTokens ?? null,
        temperature: request.temperature ?? null,
        effort: request.effort ?? null,
      } satisfies CallRecord["request"]);
      const trace = structuredClone(request.trace ?? { role: "other" as const });
      const streamed = request.onText !== undefined;
      const sent: ModelRequest = {
        ...request,
        ...(request.onText ? { onText: (text: string) => { first(); request.onText!(text); } } : {}),
        ...(request.onReasoning ? { onReasoning: (text: string) => { first(); request.onReasoning!(text); } } : {}),
      };
      const finish = (response: ModelResponse | null, error: unknown) => {
        const ms = Math.round(performance.now() - t0);
        const output = response?.usage.outputTokens ?? 0;
        const record: CallRecord = {
          id: newId("call"),
          startedAt,
          model: model.id,
          servedBy: response?.servedBy ?? null,
          trace,
          streamed,
          request: snapshot,
          response: response && {
            text: response.text,
            toolCalls: response.toolCalls,
            reasoning: response.reasoning ?? null,
            stopReason: response.stopReason,
            usage: response.usage,
            meta: response.meta ?? null,
          },
          error: error === null ? null : {
            kind: error instanceof ModelError ? error.kind : "unexpected",
            status: error instanceof ModelError ? error.status ?? null : null,
            message: error instanceof Error ? error.message : String(error),
          },
          ms,
          firstTokenMs: streamed ? firstTokenMs : null,
          // Usage may include hidden thinking generated before the first
          // visible chunk. Use the whole measured request interval.
          tokensPerSecond: output > 0 && ms >= MIN_CALL_MS ? Math.round((output / (ms / 1000)) * 10) / 10 : null,
          cost: null,
        };
        try { sink(record); } catch {}
      };
      try {
        const response = await model.complete(sent);
        finish(response, null);
        return response;
      } catch (error) {
        finish(null, error);
        throw error;
      }
    },
  };
}
