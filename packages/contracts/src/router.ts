import { z } from "zod";

/**
 * Goal Router contracts (Goal-router.md, "Router output").
 *
 * These schemas are structural. The semantic rules—which labels were
 * actually supplied, which decision/task-decision combinations are legal,
 * which gN selectors were returned by ledger_query in this run—are enforced
 * by the router's validator, because they depend on the routing context.
 */

export const GoalDecision = z.enum(["continue_current", "resume_existing", "create_new", "compound"]);
export type GoalDecision = z.infer<typeof GoalDecision>;

export const PartDecision = z.enum(["continue_current", "resume_existing", "create_new"]);
export type PartDecision = z.infer<typeof PartDecision>;

export const TaskDecision = z.enum(["continue_task", "resume_task", "create_task"]);
export type TaskDecision = z.infer<typeof TaskDecision>;

export const WorkspaceConfidence = z.enum(["high", "low"]);
export type WorkspaceConfidence = z.infer<typeof WorkspaceConfidence>;

const Title = z.string().trim().min(1).max(120);
const Reason = z.string().trim().min(1).max(400);
/** One line; the harness bounds it further in tokens before storing it. */
const Definition = z.string().trim().min(1).max(400);

export const RoutePart = z.object({
  order: z.number().int().min(1),
  request: z.string().trim().min(1),
  decision: PartDecision,
  goal_label: z.string().nullable(),
  new_goal_title: Title.nullable(),
  task_decision: TaskDecision.nullable(),
  task_label: z.string().nullable(),
  new_task_title: Title.nullable(),
  /** Required with create_new: the durable outcome the new goal works toward. */
  new_goal_objective: Definition.nullable().optional(),
  /** Required with create_task: the new task's one-line bounded outcome. */
  new_task_objective: Definition.nullable().optional(),
  /** Required with create_task: how the new task's outcome is known to be done. */
  new_task_completion_criteria: Definition.nullable().optional(),
  workspace_confidence: WorkspaceConfidence.nullable(),
  /** Explicit status change when resuming a completed task; questions leave it completed. */
  reopen_task: z.boolean().nullable().optional(),
  reason: Reason,
  depends_on: z.array(z.number().int().min(1)),
});
export type RoutePart = z.infer<typeof RoutePart>;

export const RouterDecision = z.object({
  decision: GoalDecision,
  goal_label: z.string().nullable(),
  new_goal_title: Title.nullable(),
  task_decision: TaskDecision.nullable(),
  task_label: z.string().nullable(),
  new_task_title: Title.nullable(),
  new_goal_objective: Definition.nullable().optional(),
  new_task_objective: Definition.nullable().optional(),
  new_task_completion_criteria: Definition.nullable().optional(),
  workspace_confidence: WorkspaceConfidence.nullable(),
  /** Explicit status change when resuming a completed task; questions leave it completed. */
  reopen_task: z.boolean().nullable().optional(),
  parts: z.array(RoutePart).nullable(),
  reason: Reason,
});
export type RouterDecision = z.infer<typeof RouterDecision>;

export const AskUserCandidate = z.object({
  label: z.string().trim().min(1).max(80),
  detail: z.string().trim().min(1).max(200),
  suggested: z.boolean().optional(),
  /** Machine binding; the renderer shows only label/detail. */
  goal_label: z.string().nullable().optional(),
  task_label: z.string().nullable().optional(),
});
export type AskUserCandidate = z.infer<typeof AskUserCandidate>;

export const AskUserInput = z.object({
  question: z.string().trim().min(1).max(400),
  candidates: z.array(AskUserCandidate).max(6),
  allow_new: z.boolean(),
  zero_history: z.boolean().optional(),
});
export type AskUserInput = z.infer<typeof AskUserInput>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export const LedgerQueryInput = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  match: z.string().trim().min(1).max(200).optional(),
  workspace: z.string().trim().min(1).max(120).optional(),
  goal: z.string().trim().min(1).max(120).optional(),
  task: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["open", "completed", "superseded", "any"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export type LedgerQueryInput = z.infer<typeof LedgerQueryInput>;

export const LEDGER_QUERY_DEFAULT_LIMIT = 10;
export const LEDGER_QUERY_MAX_CALLS = 3;
