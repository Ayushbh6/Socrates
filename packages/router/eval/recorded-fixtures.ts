/**
 * Frozen first-decision probes from the real-model image/context eval on
 * 2026-10-16 (explicit-2 Q6 and ambiguous-2 Q11). All conversation content
 * is synthetic. Only the machine-local fixture root was replaced.
 *
 * Keep these separate from the stateful scenario scores: they exercise the
 * current production prompt/tools against recorded context, without repair,
 * ledger queries or worker execution. A pass never clears unresolved status.
 */
import { readFileSync } from "node:fs";
import { RouterDecision, type Effort, type ModelClient, type ModelRequest, type ModelResponse } from "@socrates/contracts";
import { ROUTER_NATIVE_SYSTEM_PROMPT } from "../src/prompt";
import { ASK_USER_TOOL, LEDGER_QUERY_TOOL, ROUTING_RESULT_TOOL } from "../src/tools";

export interface RecordedFixture {
  id: string;
  name: string;
  status: "unresolved" | "regression";
  expectedGoal: string;
  expectedTask: string;
  goalRef: string;
  taskRef: string;
  completed: boolean;
  input: string;
}

export const RECORDED_CASES: readonly RecordedFixture[] = JSON.parse(
  readFileSync(new URL("./recorded-inputs.json", import.meta.url), "utf8"),
);

export function recordedRequest(fixture: RecordedFixture, modelId: string, effort?: Effort): ModelRequest {
  return {
    system: ROUTER_NATIVE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: fixture.input }],
    tools: [LEDGER_QUERY_TOOL, ASK_USER_TOOL, ROUTING_RESULT_TOOL],
    ...(/^(openrouter|openai):/.test(modelId) ? { toolChoice: "required" as const } : {}),
    maxOutputTokens: 8_000,
    temperature: 0,
    onReasoning: () => {},
    ...(effort ? { effort } : {}),
  };
}

export function gradeRecorded(fixture: RecordedFixture, response: ModelResponse): { passed: boolean; detail: string } {
  const call = response.toolCalls[0];
  if (response.toolCalls.length !== 1 || call?.name !== "routing_result") {
    return { passed: false, detail: "Expected one routing_result on the first call (no repair or retrieval)." };
  }
  const parsed = RouterDecision.safeParse(call.input);
  if (!parsed.success) return { passed: false, detail: "Invalid routing_result schema." };
  const d = parsed.data;
  const existing = d.decision === "continue_current" || d.decision === "resume_existing";
  const existingTask = d.task_decision === "continue_task" || d.task_decision === "resume_task";
  const noCreation = !d.parts && !d.new_goal_title && !d.new_task_title && !d.new_goal_objective &&
    !d.new_task_objective && !d.new_task_completion_criteria;
  const noReopen = fixture.completed ? d.reopen_task === false : d.reopen_task !== true;
  return {
    passed: existing && existingTask && noCreation && noReopen &&
      d.goal_label === fixture.expectedGoal && d.task_label === fixture.expectedTask,
    detail: `${d.decision} ${d.goal_label}/${d.task_label}, reopen=${String(d.reopen_task)}`,
  };
}

export async function runRecordedCase(model: ModelClient, fixture: RecordedFixture, effort?: Effort) {
  const response = await model.complete({ ...recordedRequest(fixture, model.id, effort), signal: AbortSignal.timeout(60_000) });
  return gradeRecorded(fixture, response);
}
