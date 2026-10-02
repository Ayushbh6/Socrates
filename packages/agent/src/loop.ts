import { type FinalAnswer, type ModelClient, ModelError, type ModelMessage, type ModelResponse, type TextPart, type ToolCall, type ToolDefinition, type TurnStop, userText } from "@socrates/contracts";
import type { TokenCalibration } from "@socrates/providers";
import { countTokens } from "@socrates/shared";
import type { CallScope, ToolRunner } from "@socrates/tools";
import { type FinalValidation, validateFinalAnswer } from "./final";
import { repairRequest, wrapUpRequest } from "./prompt";

/** Per-turn safeguards (agent-harness.md, "Safety and long-running work"). All configurable. */
export interface AgentLimits {
  maxSteps: number;
  maxWallMs: number;
  /** Prompt plus output tokens across all of the turn's model calls. */
  maxTokens: number;
  /**
   * The calibrated request size that ends the turn with a wrap-up. Until
   * compaction exists this is the compaction trigger; compaction will
   * replace this stop with the turn continuing after compaction.
   */
  contextTokens: number;
}

export const DEFAULT_LIMITS: AgentLimits = { maxSteps: 200, maxWallMs: 60 * 60_000, maxTokens: 5_000_000, contextTokens: 160_000 };

export interface RunInput {
  model: ModelClient;
  runner: ToolRunner;
  calibration: TokenCalibration;
  system: string;
  tools: ToolDefinition[];
  /** The assembled working context: the first user message. */
  context: TextPart[];
  scope: CallScope;
  limits: AgentLimits;
  maxOutputTokens?: number;
  /** Delays before retrying a transient provider failure; one retry per entry. */
  retryDelaysMs?: number[];
  now?: () => number;
}

export type RunOutcome =
  | { kind: "answer"; answer: FinalAnswer; stop: TurnStop; toolCalls: number; steps: number }
  | { kind: "invalid"; text: string; errors: string[]; stop: TurnStop; toolCalls: number; steps: number }
  | { kind: "interrupted"; reason: "cancelled" | "failed"; detail: string | null; toolCalls: number; steps: number };

const TRANSIENT = new Set<ModelError["kind"]>(["rate_limit", "server", "network"]);

/**
 * The one agent loop (agent-harness.md, "One agent loop"): send the context
 * and tools, execute the returned calls, append their bounded results, and
 * repeat until the model answers without tools. A limit ends the turn with
 * one tool-less wrap-up request; cancellation ends it without another call.
 */
export async function runAgent(input: RunInput): Promise<RunOutcome> {
  const now = input.now ?? Date.now;
  const started = now();
  const { model, limits, scope } = input;
  const messages: ModelMessage[] = [{ role: "user", content: input.context }];
  const baseTokens = countTokens(input.system) + countTokens(JSON.stringify(input.tools));
  const sizes: number[] = [countTokens(userText(input.context))];
  let steps = 0;
  let spent = 0;
  let toolCalls = 0;

  const interrupted = (reason: "cancelled" | "failed", detail: string | null = null): RunOutcome => ({ kind: "interrupted", reason, detail, toolCalls, steps });
  const push = (message: ModelMessage) => {
    messages.push(message);
    sizes.push(messageTokens(message));
  };

  /** One model request; null when cancelled, a string when it failed. */
  const call = async (toolChoice: "auto" | "none"): Promise<ModelResponse | string | null> => {
    const harnessCount = baseTokens + sizes.reduce((a, b) => a + b, 0);
    const request = {
      system: input.system,
      messages: withRollingBreakpoint(messages),
      tools: input.tools,
      toolChoice,
      maxOutputTokens: input.maxOutputTokens ?? 16_000,
      signal: scope.signal,
    };
    for (let attempt = 0; ; attempt++) {
      if (scope.signal.aborted) return null;
      try {
        const response = await model.complete(request);
        steps++;
        spent += response.usage.promptTokens + response.usage.outputTokens;
        input.calibration.observe(model.id, harnessCount, response.usage);
        return response;
      } catch (error) {
        if (scope.signal.aborted || (error instanceof ModelError && error.kind === "aborted")) return null;
        const delay = input.retryDelaysMs?.[attempt] ?? (attempt < 2 ? [1_000, 4_000][attempt]! : undefined);
        if (!(error instanceof ModelError) || !TRANSIENT.has(error.kind) || delay === undefined) {
          return error instanceof Error ? error.message : String(error);
        }
        await sleep(delay, scope.signal);
      }
    }
  };

  /** Validate a final message, with one repair request when it is invalid. */
  const finish = async (response: ModelResponse, stop: TurnStop): Promise<RunOutcome> => {
    const first = validateFinalAnswer(response.text);
    if (first.ok) return { kind: "answer", answer: first.value, stop, toolCalls, steps };
    push({ role: "assistant", content: response.text, ...(response.raw ? { raw: response.raw } : {}) });
    push({ role: "user", content: repairRequest(first.errors) });
    const repaired = await call("none");
    if (repaired === null) return interrupted("cancelled");
    if (typeof repaired === "string") return invalid(response.text, first, stop);
    const second = validateFinalAnswer(repaired.text);
    if (second.ok) return { kind: "answer", answer: second.value, stop, toolCalls, steps };
    // Keep whichever visible text the model wrote most recently.
    return invalid(repaired.text.trim() ? repaired.text : response.text, second, stop);
  };
  const invalid = (text: string, v: FinalValidation, stop: TurnStop): RunOutcome => ({ kind: "invalid", text, errors: v.ok ? [] : v.errors, stop, toolCalls, steps });

  /** The single tool-less request after a limit. */
  const wrapUp = async (stop: Exclude<TurnStop, "final">): Promise<RunOutcome> => {
    push({ role: "user", content: wrapUpRequest(LIMIT_TEXT[stop](limits)) });
    const response = await call("none");
    if (response === null) return interrupted("cancelled");
    if (typeof response === "string") return interrupted("failed", response);
    // Calls a provider emitted anyway are ignored, and its raw content is not replayed with them.
    return finish(response.toolCalls.length ? { ...response, toolCalls: [], raw: undefined } : response, stop);
  };

  while (true) {
    if (scope.signal.aborted) return interrupted("cancelled");
    const size = input.calibration.measure(model.id, baseTokens + sizes.reduce((a, b) => a + b, 0));
    const limit: Exclude<TurnStop, "final"> | null =
      steps >= limits.maxSteps ? "steps" : now() - started >= limits.maxWallMs ? "time" : spent >= limits.maxTokens ? "tokens" : size >= limits.contextTokens ? "context" : null;
    if (limit) return wrapUp(limit);

    const response = await call("auto");
    if (response === null) return interrupted("cancelled");
    if (typeof response === "string") return interrupted("failed", response);
    if (response.toolCalls.length === 0) return finish(response, "final");

    push({ role: "assistant", content: response.text, toolCalls: response.toolCalls, ...(response.raw ? { raw: response.raw } : {}) });
    const results = await execute(input.runner, response.toolCalls, scope);
    toolCalls += results.length;
    for (const r of results) push({ role: "tool", toolCallId: r.callId, toolName: r.name, content: r.content, ...(r.isError ? { isError: true } : {}) });
  }
}

const LIMIT_TEXT: Record<Exclude<TurnStop, "final">, (l: AgentLimits) => string> = {
  steps: (l) => `it reached the limit of ${l.maxSteps} model steps`,
  time: (l) => `it reached the limit of ${Math.round(l.maxWallMs / 60_000)} minutes`,
  tokens: (l) => `it reached the limit of ${l.maxTokens.toLocaleString("en-US")} tokens`,
  context: () => "the working context is full",
};

/**
 * Execute one step's calls (agent-harness.md, "One agent loop"): adjacent
 * parallel-safe calls run together, every other call runs alone in emitted
 * order, and results come back in emitted order. Every call is executed, so
 * after a cancellation the remaining calls are still recorded, as refused.
 */
async function execute(runner: ToolRunner, calls: ToolCall[], scope: CallScope) {
  const results = [];
  for (let i = 0; i < calls.length; ) {
    let j = i + 1;
    if (runner.concurrency(calls[i]!.name) === "parallel") while (j < calls.length && runner.concurrency(calls[j]!.name) === "parallel") j++;
    results.push(...(await Promise.all(calls.slice(i, j).map((c) => runner.run(c, scope)))));
    i = j;
  }
  return results;
}

/** The newest message carries the rolling cache breakpoint, so each step reuses everything before it. */
function withRollingBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.at(-1)!;
  const out = messages.slice(0, -1);
  if (last.role === "tool") out.push({ ...last, cache: true });
  else if (last.role === "user") {
    const parts = typeof last.content === "string" ? [{ text: last.content }] : last.content;
    out.push({ role: "user", content: parts.map((p, i) => (i === parts.length - 1 ? { ...p, cache: true } : p)) });
  } else out.push(last);
  return out;
}

function messageTokens(m: ModelMessage): number {
  if (m.role === "user") return countTokens(userText(m.content));
  if (m.role === "tool") return countTokens(m.content) + 8;
  return countTokens(m.content) + (m.toolCalls?.length ? countTokens(JSON.stringify(m.toolCalls)) : 0);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
