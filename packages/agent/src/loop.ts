import { type FinalAnswer, type ModelClient, ModelError, type ModelMessage, type ModelResponse, type TextPart, type ToolCall, type ToolDefinition, type TurnStop } from "@socrates/contracts";
import type { TokenCalibration } from "@socrates/providers";
import { abortable } from "@socrates/shared";
import type { ActiveCapabilities, CallScope, ToolRunner } from "@socrates/tools";
import { refreshCapabilityContext } from "./context";
import { type Draft, streamDrafts } from "./draft";
import { type ContextBudgets, DEFAULT_BUDGETS } from "./budgets";
import type { Compact, Measure } from "./compaction";
import { mechanicalNote, validateFinalAnswer } from "./final";
import { messageTokens, requestTokens } from "./model-budget";
import { repairRequest, wrapUpRequest } from "./prompt";
export { messageTokens, requestTokens } from "./model-budget";

/** Per-turn safeguards (agent-harness.md, "Safety and long-running work"). All configurable. */
export interface AgentLimits {
  maxSteps: number;
  maxWallMs: number;
  /** Separate bounded allowance for the tool-free wrap-up and its repair. */
  finalizationMs?: number;
  /** Prompt plus output tokens across all of the turn's model calls. */
  maxTokens: number;
}

export const DEFAULT_LIMITS: AgentLimits = { maxSteps: 200, maxWallMs: 60 * 60_000, maxTokens: 5_000_000 };

export interface RunInput {
  model: ModelClient;
  runner: ToolRunner;
  calibration: TokenCalibration;
  system: string;
  tools: ToolDefinition[];
  /**
   * The current tool list, read again after every step so an MCP tool
   * activated mid-turn is callable on the next step.
   */
  refreshTools?: (signal: AbortSignal) => Promise<ToolDefinition[]>;
  capabilities?: () => ActiveCapabilities;
  /** Include capability restoration and other part setup in the wall-time allowance. */
  startedAt?: number;
  /** The assembled working context: the first user message. */
  context: TextPart[];
  scope: CallScope;
  limits: AgentLimits;
  /** The compaction trigger and the hard ceiling. */
  budgets?: Pick<ContextBudgets, "trigger" | "target" | "ceiling">;
  /**
   * Compaction at the trigger. Without it, reaching the trigger ends the turn
   * with a wrap-up, as before compaction existed.
   */
  compact?: Compact;
  maxOutputTokens?: number;
  /** Delays before retrying a transient provider failure; one retry per entry. */
  retryDelaysMs?: number[];
  now?: () => number;
  /** Persist every received response before executing or interpreting it. */
  onResponse?: (response: ModelResponse, phase: "work" | "wrap_up" | "repair") => void;
  /**
   * The readable part of each reply while it arrives. Drafts are temporary
   * and never saved; when given, the turn's requests are streamed.
   */
  onDraft?: (draft: Draft) => void;
}

export type RunOutcome =
  | { kind: "answer"; answer: FinalAnswer; stop: TurnStop; toolCalls: number; steps: number }
  | { kind: "limited"; text: string; note: string; stop: TurnStop; toolCalls: number; steps: number }
  | { kind: "invalid"; text: string; errors: string[]; stop: TurnStop; toolCalls: number; steps: number }
  /** `partial`: on a stop, the answer as far as it had streamed, or null. */
  | { kind: "interrupted"; reason: "cancelled" | "failed"; detail: string | null; toolCalls: number; steps: number; partial: string | null };

const TRANSIENT = new Set<ModelError["kind"]>(["rate_limit", "server", "network"]);

type Phase = "work" | "wrap_up" | "repair";
type CallResult = { kind: "response"; response: ModelResponse } | { kind: "failed"; detail: string } | { kind: "cancelled" | "deadline" | "context" };

/** Run the model and tools until a final answer, interruption or bounded wrap-up. */
export async function runAgent(input: RunInput): Promise<RunOutcome> {
  const now = input.now ?? Date.now;
  const started = input.startedAt ?? now();
  const { model, limits, scope } = input;
  const messages: ModelMessage[] = [{ role: "user", content: input.context }];
  let tools = input.tools;
  let baseTokens = requestTokens(input.system, [], tools);
  const sizes: number[] = [messageTokens(messages[0]!)];
  const budgets = input.budgets ?? DEFAULT_BUDGETS;
  const measure: Measure = (list) => input.calibration.measure(model.id, baseTokens + list.reduce((n, m) => n + messageTokens(m), 0));
  /**
   * Hysteresis (agent-harness.md, "Token budget and trigger points"): after a
   * compaction, the next one waits until the request has grown by the gap
   * between trigger and target, even when the target could not be reached.
   */
  let compactedAt: number | null = null;
  let steps = 0, spent = 0, toolCalls = 0, requests = 0;
  /** The newest answer draft of the turn, kept for a stop that lands while it is being written. */
  let partial: string | null = null;
  const deadline = new AbortController();
  const workSignal = AbortSignal.any([scope.signal, deadline.signal]);
  const workTimer = setTimeout(() => deadline.abort(), Math.max(0, limits.maxWallMs - (now() - started)));
  let finalTimer: ReturnType<typeof setTimeout> | undefined;
  let finalSignal: AbortSignal | undefined;
  const finalization = () => {
    if (!finalSignal) {
      const controller = new AbortController();
      finalTimer = setTimeout(() => controller.abort(), limits.finalizationMs ?? 60_000);
      finalSignal = AbortSignal.any([scope.signal, controller.signal]);
    }
    return finalSignal;
  };
  const timeExpired = () => {
    if (now() - started >= limits.maxWallMs) deadline.abort();
    return deadline.signal.aborted;
  };
  const interrupted = (reason: "cancelled" | "failed", detail: string | null = null): RunOutcome => ({ kind: "interrupted", reason, detail, toolCalls, steps, partial: reason === "cancelled" ? partial : null });
  const push = (message: ModelMessage) => { messages.push(message); sizes.push(messageTokens(message)); };
  const contextFallback = (stop: TurnStop): RunOutcome => ({
    kind: "limited", stop, toolCalls, steps,
    text: "Stopped because the working context is too large to request a safe final answer. The work and tool results are saved. This task is not being marked complete; ask me to continue from the saved evidence.",
    note: mechanicalNote("Stopped at the context ceiling; work and evidence saved", toolCalls),
  });
  const invalid = (text: string, errors: string[], stop: TurnStop): RunOutcome => ({ kind: "invalid", text, errors, stop, toolCalls, steps });

  const syncCapabilities = () => {
    if (!input.capabilities) return;
    const next = refreshCapabilityContext(messages, input.capabilities());
    if (next === messages) return;
    // Ordinary steps keep their cached counts; only changed capability content is retokenized.
    for (let i = 0; i < next.length; i++) if (next[i] !== messages[i]) sizes[i] = messageTokens(next[i]!);
    messages.splice(0, messages.length, ...next);
  };
  const call = async (phase: Phase, signal: AbortSignal): Promise<CallResult> => {
    syncCapabilities();
    const harnessCount = baseTokens + sizes.reduce((a, b) => a + b, 0);
    for (let attempt = 0; ; attempt++) {
      if (scope.signal.aborted) return { kind: "cancelled" };
      if ((phase === "work" && timeExpired()) || signal.aborted) return { kind: "deadline" };
      // The same gate covers ordinary requests, retries, wrap-up and repair.
      if (input.calibration.measure(model.id, harnessCount) >= budgets.ceiling) return { kind: "context" };
      let streaming = true;
      const request = ++requests;
      const onDraft = input.onDraft;
      const onText = onDraft ? streamDrafts((draft) => {
        if (draft.kind === "answer") partial = draft.text;
        onDraft(draft);
      }, request) : undefined;
      try {
        const response = await abortable(model.complete({
          system: input.system, messages: withRollingBreakpoint(messages), tools,
          toolChoice: phase === "work" ? "auto" : "none", maxOutputTokens: input.maxOutputTokens ?? 16_000, signal,
          // Every request, a retry included, is its own draft.
          ...(onText ? { onText: (text: string) => {
            if (streaming && request === requests && !signal.aborted && !scope.signal.aborted) onText(text);
          } } : {}),
        }), signal);
        input.onResponse?.(response, phase);
        steps++;
        spent += response.usage.promptTokens + response.usage.outputTokens;
        input.calibration.observe(model.id, harnessCount, response.usage);
        return { kind: "response", response };
      } catch (error) {
        streaming = false;
        if (scope.signal.aborted) return { kind: "cancelled" };
        if (signal.aborted) return { kind: "deadline" };
        if (error instanceof ModelError && error.kind === "aborted") return { kind: "cancelled" };
        const delays = input.retryDelaysMs ?? [1_000, 4_000];
        const delay = delays[attempt];
        if (!(error instanceof ModelError) || !TRANSIENT.has(error.kind) || delay === undefined) {
          return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
        }
        await sleep(delay, signal);
      } finally {
        streaming = false;
      }
    }
  };

  const appendResponse = async (response: ModelResponse, signal: AbortSignal) => {
    push({ role: "assistant", content: response.text, toolCalls: response.toolCalls, ...(response.raw ? { raw: response.raw } : {}) });
    if (signal === workSignal) timeExpired();
    const results = await execute(input.runner, response.toolCalls, { ...scope, signal });
    toolCalls += results.length;
    for (const r of results) push({ role: "tool", toolCallId: r.callId, toolName: r.name, content: r.content, ...(r.isError ? { isError: true } : {}) });
  };
  // Unexpected tool calls during finalization are recorded as refused. Never
  // execute them or accept their accompanying state proposals as a final answer.
  const refused = AbortSignal.abort();
  const validate = (response: ModelResponse) => response.toolCalls.length
    ? { ok: false as const, errors: ["A final answer must not contain tool calls; these calls were refused."] }
    : validateFinalAnswer(response.text);
  const failedCall = (result: Exclude<CallResult, { kind: "response" }>, stop: TurnStop): RunOutcome => {
    if (result.kind === "cancelled" || scope.signal.aborted) return interrupted("cancelled");
    if (result.kind === "context") return contextFallback(stop === "final" ? "context" : stop);
    return interrupted("failed", result.kind === "failed" ? result.detail : "The final-answer deadline expired.");
  };
  const finish = async (response: ModelResponse, stop: TurnStop): Promise<RunOutcome> => {
    if (scope.signal.aborted) {
      if (response.toolCalls.length) await appendResponse(response, refused);
      return interrupted("cancelled");
    }
    const first = validate(response);
    if (first.ok) return { kind: "answer", answer: first.value, stop, toolCalls, steps };
    await appendResponse(response, refused);
    push({ role: "user", content: repairRequest(first.errors) });
    const repaired = await call("repair", finalization());
    if (repaired.kind !== "response") return failedCall(repaired, stop);
    if (repaired.response.toolCalls.length) await appendResponse(repaired.response, refused);
    if (scope.signal.aborted) return interrupted("cancelled");
    if (finalSignal!.aborted) return interrupted("failed", "The final-answer deadline expired.");
    const second = validate(repaired.response);
    if (second.ok) return { kind: "answer", answer: second.value, stop, toolCalls, steps };
    return invalid(repaired.response.text.trim() ? repaired.response.text : response.text, second.errors, stop);
  };
  const wrapUp = async (stop: Exclude<TurnStop, "final">): Promise<RunOutcome> => {
    push({ role: "user", content: wrapUpRequest(LIMIT_TEXT[stop](limits)) });
    const result = await call("wrap_up", finalization());
    if (result.kind !== "response") return failedCall(result, stop);
    if (scope.signal.aborted) return finish(result.response, stop);
    if (finalSignal!.aborted) {
      if (result.response.toolCalls.length) await appendResponse(result.response, refused);
      return interrupted("failed", "The final-answer deadline expired.");
    }
    return finish(result.response, stop);
  };

  try {
    while (true) {
      if (scope.signal.aborted) return interrupted("cancelled");
      syncCapabilities();
      const size = input.calibration.measure(model.id, baseTokens + sizes.reduce((a, b) => a + b, 0));
      const limit = steps >= limits.maxSteps ? "steps" : timeExpired() ? "time" : spent >= limits.maxTokens ? "tokens" : size >= budgets.trigger && !input.compact ? "context" : null;
      if (limit) return await wrapUp(limit);
      if (size >= budgets.trigger && input.compact && (compactedAt === null || size >= compactedAt + budgets.trigger - budgets.target)) {
        // Compaction is synchronous and mid-turn; the turn continues after it.
        const compacted = await input.compact(messages, measure, workSignal, {
          calibration: input.calibration,
          recordUsage: (usage) => { spent += usage.promptTokens + usage.outputTokens; },
          tokensExhausted: () => spent >= limits.maxTokens,
        });
        if (scope.signal.aborted) return interrupted("cancelled");
        if (compacted === null) return await wrapUp("time");
        messages.splice(0, messages.length, ...compacted);
        sizes.splice(0, sizes.length, ...compacted.map(messageTokens));
        compactedAt = measure(messages);
        continue;
      }
      const result = await call("work", workSignal);
      if (result.kind === "deadline") return await wrapUp("time");
      if (result.kind !== "response") return failedCall(result, "context");
      const response = result.response;
      if (scope.signal.aborted || timeExpired()) {
        await appendResponse(response, refused);
        if (scope.signal.aborted) return interrupted("cancelled");
        return await wrapUp("time");
      }
      if (response.toolCalls.length === 0) return await finish(response, "final");
      await appendResponse(response, workSignal);
      if (input.refreshTools && !workSignal.aborted) {
        // A failed refresh keeps the previous list; dispatch still revalidates every MCP call.
        const next = await abortable(input.refreshTools(workSignal), workSignal).catch(() => tools);
        if (JSON.stringify(next) !== JSON.stringify(tools)) {
          tools = next;
          baseTokens = requestTokens(input.system, [], tools);
        }
      }
    }
  } finally {
    clearTimeout(workTimer);
    clearTimeout(finalTimer);
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
