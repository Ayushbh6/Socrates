import { type HistoryCheckpoint, type ModelClient, ModelError, type ModelMessage, type TaskHandover, type TextPart, userText } from "@socrates/contracts";
import { abortable, countTokens, truncateToTokens } from "@socrates/shared";
import { headTail } from "@socrates/tools";
import type { HistoryRecord, LedgerStore, TaskRefs, Turn } from "@socrates/store";
import type { ContextBudgets } from "./budgets";
import { messageTokens } from "./loop";
import { collapsedLine, renderExchangeTurn, renderFullTurn, taskHistory } from "./history";
import { CHECKPOINT_SYSTEM_PROMPT, HANDOVER_SYSTEM_PROMPT } from "./prompt";
import { rangeText, renderRecord, renderSpan, type SummaryValidation, validateSummary } from "./summaries";

/** Output allowance of one compactor request. */
const SUMMARY_OUTPUT_TOKENS = 16_000;
/** The previous turn's budget in the failsafe, after every other reduction. */
const FAILSAFE_PREVIOUS_TURN = 4_000;
/** The failsafe never truncates one result of the newest step below this. */
const FAILSAFE_RESULT_FLOOR = 1_000;

/** Calibrated size of a full request with these messages. */
export type Measure = (messages: ModelMessage[]) => number;
/** Compact the request in place of the next model call; null when cancelled. */
export type Compact = (messages: ModelMessage[], measure: Measure, signal: AbortSignal) => Promise<ModelMessage[] | null>;

export interface CompactorOptions {
  store: LedgerStore;
  /** The model that writes checkpoints and capsules. */
  model: ModelClient;
  turn: Turn;
  budgets: ContextBudgets;
  /** Assemble this turn's working context from the store, optionally with a smaller N−1 budget. */
  assemble: (previousTurn?: number) => TextPart[];
  retryDelaysMs?: number[];
  /** Shown to the user while a long task's context is refreshed by rollover. */
  onStatus?: (text: string) => void;
  log?: (message: string) => void;
}

/**
 * Compaction of one turn (agent-harness.md, "Context and compaction"). Each
 * trigger is one compaction of the current chat: a history checkpoint of the
 * turns older than the verbatim window (one model call), then linearization
 * of the turn's older tool calls, then the failsafe. The trigger after a
 * chat's last allowed compaction rolls the chat over instead.
 */
export function createCompactor(options: CompactorOptions): Compact {
  const { store, turn, budgets } = options;
  const taskId = turn.taskId!;
  /** Tool calls of this turn already replaced by one-line entries. */
  const linearized = new Set<string>();

  const linearizedPart = (): TextPart[] => {
    if (!linearized.size) return [];
    const lines = store.evidenceForTurn(turn.id).filter((e) => linearized.has(e.callId)).map((e) => `- ${collapsedLine({ ev: e, state: { kind: "collapsed", reason: null } })}`);
    return [{ text: `\n\n[TURN ${turn.projectTurn} — earlier tool activity of this turn, linearized; context_retrieve inspect recovers each handle]\n${lines.join("\n")}` }];
  };

  return async (messages, measure, signal) => {
    const before = measure(messages);
    const chat = store.currentChat(taskId);
    const refs = { goal_id: turn.goalId!, task_id: taskId, chat_id: chat.id, turn_id: turn.id };
    let steps = groupSteps(messages.slice(1));
    let previousTurn: number | undefined;
    const build = () => [{ role: "user" as const, content: [...options.assemble(previousTurn), ...linearizedPart()] }, ...steps.flat()];

    const layers: ("checkpoint" | "linearize" | "failsafe")[] = [];
    let checkpoint: string | null = null;
    const rollover = chat.compactionCount >= budgets.maxCompactionsPerChat;
    if (rollover) {
      options.onStatus?.("Refreshing this long task's context…");
      const capsule = await writeHandover(options, refs, signal);
      if (!capsule) return null;
      store.rolloverChat(chat.id, capsule);
    } else {
      const span = planSpan(store, turn, budgets);
      if (span) {
        layers.push("checkpoint");
        const result = await writeCheckpoint(options, refs, span, signal);
        if (result === "cancelled") return null;
        if (result) checkpoint = result.handle;
        else store.recordOmission(refs, { from: span.turns[0]!.projectTurn, to: span.turns.at(-1)!.projectTurn });
      }
    }

    // Layer 2: newest steps stay intact within the window; older steps become one-line entries.
    // The newest step always stays, so the agent never loses the results it is about to use.
    const linearize = (window: number) => {
      let used = 0;
      let keep = steps.length;
      for (let i = steps.length - 1; i >= 0; i--) {
        const size = steps[i]!.reduce((n, m) => n + messageTokens(m), 0);
        if (used + size > window && i !== steps.length - 1) break;
        used += size;
        keep = i;
      }
      for (const step of steps.slice(0, keep)) for (const m of step) if (m.role === "tool") linearized.add(m.toolCallId);
      steps = steps.slice(keep);
    };
    let current = build();
    if (measure(current) > budgets.target && steps.length) {
      layers.push("linearize");
      linearize(budgets.intactWindow);
      current = build();
    }
    // Failsafe: shrink the intact window down to the newest step, then the previous turn, then
    // hard-truncate the newest step's results, each keeping its evidence handle; and say so.
    if (measure(current) > budgets.target) {
      for (const window of [budgets.intactWindow / 2, budgets.intactWindow / 4, 0]) {
        if (steps.length <= 1 || measure(current) <= budgets.target) break;
        linearize(window);
        current = build();
      }
      if (measure(current) > budgets.target) {
        previousTurn = Math.min(FAILSAFE_PREVIOUS_TURN, budgets.previousTurn);
        current = build();
      }
      if (measure(current) > budgets.target && steps.length) {
        const newest = steps.at(-1)!;
        const results = newest.filter((m) => m.role === "tool");
        const others = measure(current) - results.reduce((n, m) => n + messageTokens(m), 0);
        const room = Math.max(FAILSAFE_RESULT_FLOOR, Math.floor((budgets.target - others) / Math.max(1, results.length)));
        const handles = new Map(store.evidenceForTurn(turn.id).map((e) => [e.callId, e.handle]));
        steps[steps.length - 1] = newest.map((m) => {
          if (m.role !== "tool" || countTokens(m.content) <= room) return m;
          const handle = handles.get(m.toolCallId) ?? "its evidence handle";
          return { ...m, content: headTail(m.content, room, `context_retrieve inspect ${handle} returns the complete result`).text };
        });
        current = build();
      }
      layers.push("failsafe");
      if (measure(current) > budgets.target) {
        store.recordWarning(refs, { kind: "compaction_failsafe", detail: `The request is ${measure(current)} tokens after every reduction; the target is ${budgets.target}.` });
      }
    }
    const after = measure(current);
    // A rollover is not a compaction: the continuation chat's count starts at zero.
    if (!rollover) store.recordCompaction(refs, { layers, checkpoint, before_tokens: before, after_tokens: after });
    options.log?.(`compaction of turn ${turn.projectTurn}: ${before} → ${after} tokens (${rollover ? "rollover" : layers.join(", ") || "no reduction"})`);
    return current;
  };
}

/** One model step of the in-flight turn: an assistant message with its tool results. Cuts never fall inside one. */
function groupSteps(messages: ModelMessage[]): ModelMessage[][] {
  const steps: ModelMessage[][] = [];
  for (const m of messages) {
    if (m.role === "assistant" || !steps.length) steps.push([m]);
    else steps.at(-1)!.push(m);
  }
  return steps;
}

interface Span {
  turns: Turn[];
  prior: HistoryRecord | null;
  range: { from: number; to: number };
}

/**
 * Layer 1's input (agent-harness.md, "Layer 1"): walking back from N−1, the
 * newest whole turns that fit the verbatim window stay; every older turn
 * after the active summary — including turns a failed compaction omitted —
 * plus that summary form the span. Null when no turn is older than the window.
 */
function planSpan(store: LedgerStore, turn: Turn, budgets: ContextBudgets): Span | null {
  const history = taskHistory(store, turn.id);
  let used = 0;
  let windowStart = history.turns.length;
  for (let i = history.turns.length - 1; i >= 0; i--) {
    const t = history.turns[i]!;
    const size = countTokens(i === history.turns.length - 1 ? renderFullTurn(store, t, budgets.previousTurn) : renderExchangeTurn(store, t));
    if (used + size > budgets.verbatimWindow) break;
    used += size;
    windowStart = i;
  }
  const kept = new Set(history.turns.slice(windowStart).map((t) => t.id));
  const prior = history.summary;
  const turns = store
    .turnsForTask(turn.taskId!)
    .filter((t) => t.id !== turn.id && t.projectTurn < turn.projectTurn && t.projectTurn > (prior?.to ?? 0) && t.status !== "in_progress" && !kept.has(t.id));
  if (!turns.length) return null;
  return { turns, prior, range: { from: prior && prior.from > 0 ? prior.from : turns[0]!.projectTurn, to: turns.at(-1)!.projectTurn } };
}

/** One checkpoint: a model call, one retry with the errors, then null for the mechanical fallback. */
async function writeCheckpoint(options: CompactorOptions, refs: TaskRefs & { chat_id: string }, span: Span, signal: AbortSignal): Promise<HistoryRecord | null | "cancelled"> {
  const { store } = options;
  const input = `${renderSpan(store, span.turns, span.prior, span.range)}\n\nWrite the checkpoint for turns ${rangeText(span.range.from, span.range.to)}.`;
  const draft = (content: HistoryCheckpoint): HistoryRecord => ({ ...placeholder(refs), kind: "checkpoint", from: span.range.from, to: span.range.to, content });
  const result = await summarize(options, CHECKPOINT_SYSTEM_PROMPT, input, signal, (text) =>
    validateSummary("checkpoint", text, { store, taskId: refs.task_id, range: span.range, latestTurn: options.turn.projectTurn, maxTokens: options.budgets.summaryMax, render: (c) => renderRecord(draft(c)) }),
  );
  if (result === "cancelled") return result;
  if (!result.ok) {
    store.recordWarning(refs, { kind: "compactor_failed", detail: `Checkpoint for turns ${rangeText(span.range.from, span.range.to)} failed: ${result.errors.join("; ")}` });
    return null;
  }
  return store.recordHistoryRecord(refs, { kind: "checkpoint", from: span.range.from, to: span.range.to, content: result.value });
}

/**
 * The handover capsule for rollover (Goal-router.md, "The handover
 * capsule"). It covers what a checkpoint would, and is forward-looking. When
 * the writer fails, the harness builds a mechanical capsule from the prior
 * summary and the ledger so rollover never blocks the turn.
 */
async function writeHandover(options: CompactorOptions, refs: TaskRefs & { chat_id: string }, signal: AbortSignal): Promise<HistoryRecord | null> {
  const { store, turn, budgets } = options;
  const task = store.requireTask(turn.taskId!);
  const span = planSpan(store, turn, budgets);
  const prior = span?.prior ?? store.latestHistoryRecord(task.id);
  const range = span?.range ?? (prior ? { from: prior.from, to: prior.to } : { from: 0, to: 0 });
  const activity = store.evidenceForTurn(turn.id).map((e) => `- ${collapsedLine({ ev: e, state: { kind: "collapsed", reason: null } })}`);
  const request = store.requestForTurn(turn.id).request;
  const input = [
    `<TASK>\ntitle: ${task.title}\nobjective: ${task.objective}\ncompletion_criteria: ${task.completionCriteria ?? "none"}\nnote: ${task.continuationNote ?? "none"}\n</TASK>`,
    span ? renderSpan(store, span.turns, prior, range) : prior ? renderRecord(prior) : "(No older turns are handed over.)",
    `<CURRENT_REQUEST turn="${turn.projectTurn}">\n${request}\n${activity.length ? `TOOL ACTIVITY SO FAR:\n${activity.slice(-40).join("\n")}` : ""}\n</CURRENT_REQUEST>`,
    "Write the handover capsule.",
  ].join("\n\n");
  const draft = (content: TaskHandover): HistoryRecord => ({ ...placeholder(refs), kind: "handover", from: range.from, to: range.to, content });
  const result = await summarize(options, HANDOVER_SYSTEM_PROMPT, input, signal, (text) =>
    validateSummary("handover", text, { store, taskId: task.id, range, latestTurn: turn.projectTurn, maxTokens: budgets.summaryMax, render: (c) => renderRecord(draft(c)) }),
  );
  if (result === "cancelled") return null;
  if (result.ok) return store.recordHistoryRecord(refs, { kind: "handover", from: range.from, to: range.to, content: result.value });
  store.recordWarning(refs, { kind: "compactor_failed", detail: `Handover capsule failed; a mechanical capsule was written: ${result.errors.join("; ")}` });
  return store.recordHistoryRecord(refs, { kind: "handover", from: range.from, to: range.to, content: mechanicalCapsule(store, task.id, prior, request, budgets.summaryMax), mechanical: true });
}

function mechanicalCapsule(store: LedgerStore, taskId: string, prior: HistoryRecord | null, request: string, maxTokens: number): TaskHandover {
  const task = store.requireTask(taskId);
  const carried = prior?.content as Partial<HistoryCheckpoint & TaskHandover> | undefined;
  const decisions = (carried?.decisions ?? []).map((d) => (typeof d === "string" ? d : d.decision));
  return {
    task_objective: task.objective,
    completion_criteria: task.completionCriteria ?? "",
    verified_progress: task.continuationNote ?? "",
    outstanding_requests: carried?.outstanding_requests ?? [],
    ...(carried?.more_outstanding_turns?.length ? { more_outstanding_turns: carried.more_outstanding_turns } : {}),
    decisions,
    constraints: carried?.constraints ?? [],
    files_and_tests: store.distinctFacts(taskId, 20),
    blockers: [],
    next_action: `Continue the current request: ${truncateToTokens(request, 200).text}`,
    key_evidence: (carried?.key_evidence ?? []).slice(0, Math.max(0, Math.floor(maxTokens / 400))),
  };
}

/** A record shape for size validation before the harness assigns the real handle. */
function placeholder(refs: TaskRefs & { chat_id: string }): Omit<HistoryRecord, "kind" | "from" | "to" | "content"> {
  return { taskId: refs.task_id, number: 0, handle: "hc-0", chatId: refs.chat_id, turnId: refs.turn_id ?? null, mechanical: false, createdAt: "" };
}

/**
 * One summarizer exchange: a request, and at most one retry that carries the
 * validation errors or follows a provider failure. Transient provider errors
 * wait for the configured delay first.
 */
async function summarize<T>(
  options: CompactorOptions,
  system: string,
  input: string,
  signal: AbortSignal,
  validate: (text: string) => SummaryValidation<T>,
): Promise<SummaryValidation<T> | "cancelled"> {
  const messages: ModelMessage[] = [{ role: "user", content: input }];
  let last: SummaryValidation<T> = { ok: false, errors: ["The summarizer was not called."] };
  if (countTokens(system) + countTokens(userText(input)) >= options.budgets.ceiling) {
    return { ok: false, errors: ["The span is too large for one summarizer request."] };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) return "cancelled";
    try {
      const response = await abortable(options.model.complete({ system, messages, maxOutputTokens: SUMMARY_OUTPUT_TOKENS, signal }), signal);
      last = validate(response.text);
      if (last.ok) return last;
      messages.push({ role: "assistant", content: response.text, ...(response.raw ? { raw: response.raw } : {}) });
      messages.push({ role: "user", content: `That reply was not valid:\n${last.errors.map((e) => `- ${e}`).join("\n")}\nReply again with only the corrected JSON object.` });
    } catch (error) {
      if (signal.aborted || (error instanceof ModelError && error.kind === "aborted")) return "cancelled";
      last = { ok: false, errors: [`The summarizer request failed: ${error instanceof Error ? error.message : String(error)}`] };
      const delay = options.retryDelaysMs?.[attempt] ?? 1_000;
      if (error instanceof ModelError && ["rate_limit", "server", "network"].includes(error.kind)) {
        await abortable(new Promise((r) => setTimeout(r, delay)), signal).catch(() => {});
      }
    }
  }
  return last;
}
