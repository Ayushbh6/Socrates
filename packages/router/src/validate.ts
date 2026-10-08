import { AskUserInput, RouterDecision, type RoutePart, type WorkspaceConfidence } from "@socrates/contracts";
import { type Goal, type LedgerStore, type Task, parseGoalSelector, parseTaskSelector } from "@socrates/store";
import type { RoutingContext } from "./context";

/**
 * Semantic validation of the router's answer ("models propose, the harness
 * disposes"). Every label must be one the router was actually shown: a
 * KNOWN_GOALS label, `general`, or a gN / gN/tN selector returned by
 * ledger_query during this routing run. Errors are corrective so the single
 * repair attempt can succeed.
 */

export type RouteTarget =
  | { kind: "existing_task"; goal: Goal; task: Task }
  /** Definitions are always present for model routes; harness fallbacks have none to offer. */
  | { kind: "new_task"; goal: Goal; taskTitle: string; objective?: string | null; completionCriteria?: string | null }
  | {
      kind: "new_goal";
      goalTitle: string;
      goalObjective?: string | null;
      taskTitle: string;
      objective?: string | null;
      completionCriteria?: string | null;
    }
  | { kind: "general" };

export interface ResolvedPart {
  order: number;
  request: string;
  decision: string;
  taskDecision: string | null;
  target: RouteTarget;
  workspaceConfidence: WorkspaceConfidence;
  reopenTask: boolean;
  dependsOn: number[];
  reason: string;
}

export interface ResolvedRoute {
  decision: RouterDecision;
  compound: boolean;
  parts: ResolvedPart[];
  reason: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Selectors returned by ledger_query in the current routing run. */
export interface SeenSelectors {
  goals: Set<number>;
  tasks: Set<string>;
}

export function emptySeen(): SeenSelectors {
  return { goals: new Set(), tasks: new Set() };
}

/** Extract the router's JSON answer from free text (tolerates code fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object found.");
  return JSON.parse(candidate.slice(start, end + 1));
}

export function validateDecisionText(text: string, ctx: RoutingContext, store: LedgerStore, seen: SeenSelectors): Validation<ResolvedRoute> {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return { ok: false, errors: ["Return exactly one JSON object matching the routing schema, with no other text."] };
  }
  const parsed = RouterDecision.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return resolveDecision(parsed.data, ctx, store, seen);
}

export function resolveDecision(
  decision: RouterDecision,
  ctx: RoutingContext,
  store: LedgerStore,
  seen: SeenSelectors,
): Validation<ResolvedRoute> {
  const errors: string[] = [];

  if (decision.decision === "compound") {
    for (const key of [
      "goal_label",
      "new_goal_title",
      "task_decision",
      "task_label",
      "new_task_title",
      "new_goal_objective",
      "new_task_objective",
      "new_task_completion_criteria",
      "workspace_confidence",
      "reopen_task",
    ] as const) {
      if (decision[key] !== null && decision[key] !== undefined) errors.push(`compound requires top-level ${key} null.`);
    }
    const parts = decision.parts ?? [];
    if (parts.length < 2) {
      return { ok: false, errors: ["compound requires `parts` with at least two ordered parts; otherwise return a single decision."] };
    }
    const sorted = [...parts].sort((a, b) => a.order - b.order);
    const original = ctx.pending?.request ?? ctx.message;
    let requestEnd = 0;
    sorted.forEach((p, i) => {
      const requestStart = original.indexOf(p.request, requestEnd);
      if (requestStart < 0) errors.push(`part ${p.order}: request must be an exact, ordered sub-request from the original user message (copy its case and punctuation). Invalid request: ${JSON.stringify(p.request)}`);
      else requestEnd = requestStart + p.request.length;
      const deps = p.depends_on ?? [];
      // Part 1 cannot depend on anything; a later part must say whether it needs earlier evidence.
      if (p.depends_on === undefined && p.order > 1) errors.push(`part ${p.order}: depends_on is required: list the earlier part orders it needs, or [] when it is independent.`);
      if (new Set(deps).size !== deps.length) errors.push(`part ${p.order}: dependencies must be unique.`);
      if (p.order !== i + 1) errors.push(`parts must be numbered 1..${parts.length} without gaps; found order ${p.order}.`);
      for (const dep of deps) {
        if (dep >= p.order) errors.push(`part ${p.order} may depend only on earlier parts; found depends_on ${dep}.`);
      }
    });
    const resolved: ResolvedPart[] = [];
    for (const part of sorted) {
      const r = resolvePart(part, ctx, store, seen, `part ${part.order}: `);
      if (r.ok) resolved.push(r.value);
      else errors.push(...r.errors);
    }
    const taskIds = resolved.flatMap((p) =>
      p.target.kind === "existing_task" ? [p.target.task.id] : p.target.kind === "general" ? ["general"] : [],
    );
    if (new Set(taskIds).size !== taskIds.length) {
      errors.push("Two parts select the same task. A message that fits one task is not compound; return a single decision.");
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, value: { decision, compound: true, parts: resolved, reason: decision.reason } };
  }

  if (decision.parts !== null) errors.push("`parts` must be null unless decision is compound.");
  const single = resolvePart(
    {
      order: 1,
      request: ctx.pending?.request ?? ctx.message,
      decision: decision.decision,
      goal_label: decision.goal_label,
      new_goal_title: decision.new_goal_title,
      task_decision: decision.task_decision,
      task_label: decision.task_label,
      new_task_title: decision.new_task_title,
      new_goal_objective: decision.new_goal_objective ?? null,
      new_task_objective: decision.new_task_objective ?? null,
      new_task_completion_criteria: decision.new_task_completion_criteria ?? null,
      workspace_confidence: decision.workspace_confidence,
      ...(decision.reopen_task !== undefined ? {reopen_task: decision.reopen_task} : {}),
      reason: decision.reason,
      depends_on: [],
    },
    ctx,
    store,
    seen,
    "",
  );
  if (!single.ok) errors.push(...single.errors);
  if (errors.length || !single.ok) return { ok: false, errors };
  return { ok: true, value: { decision, compound: false, parts: [single.value], reason: decision.reason } };
}

function norm(value: string | null): string | null {
  return value === null ? null : value.trim().toLowerCase();
}

/** Resolve a goal label to a goal the router was shown. */
function resolveGoal(
  label: string,
  ctx: RoutingContext,
  store: LedgerStore,
  seen: SeenSelectors,
): { goal: Goal; source: "current" | "older" | "ledger" } | { error: string } {
  const entry = ctx.goals.get(label);
  if (entry) return { goal: entry.goal, source: entry.kind };
  const n = parseGoalSelector(label);
  if (n !== null) {
    if (!seen.goals.has(n)) {
      return { error: `goal_label "${label}" was not returned by ledger_query in this routing run. Use a KNOWN_GOALS label, or query the ledger first.` };
    }
    const goal = store.getGoalByNumber(n);
    if (!goal) return { error: `goal ${label} does not exist.` };
    return { goal, source: goal.id === ctx.current?.goal.id ? "current" : "ledger" };
  }
  const labels = [...ctx.goals.keys(), "general"].join(", ");
  return { error: `goal_label "${label}" is unknown. Valid labels: ${labels}, or a gN selector returned by ledger_query.` };
}

/** Resolve a task label within a resolved goal. */
function resolveTask(goal: Goal, label: string, ctx: RoutingContext, store: LedgerStore, seen: SeenSelectors): Task | { error: string } {
  const entry = [...ctx.goals.values()].find((g) => g.goal.id === goal.id);
  const listed = entry?.tasks.find((t) => t.label === label);
  if (listed) return listed.task;
  const sel = parseTaskSelector(label);
  if (sel) {
    if (!seen.tasks.has(`g${sel.goal}/t${sel.task}`)) {
      return { error: `task_label "${label}" was not returned by ledger_query in this routing run.` };
    }
    if (sel.goal !== goal.number) return { error: `task_label "${label}" belongs to goal g${sel.goal}, not the selected goal g${goal.number}.` };
    const task = store.getTaskByNumber(goal.id, sel.task);
    if (!task) return { error: `task ${label} does not exist.` };
    return task;
  }
  const valid = entry?.tasks.map((t) => t.label).join(", ") || "none listed";
  return { error: `task_label "${label}" is not a task of the selected goal. Valid labels for it: ${valid}, or a gN/tN selector returned by ledger_query.` };
}

function resolvePart(part: RoutePart, ctx: RoutingContext, store: LedgerStore, seen: SeenSelectors, prefix: string): Validation<ResolvedPart> {
  const fail = (...errors: string[]): Validation<ResolvedPart> => ({ ok: false, errors: errors.map((e) => prefix + e) });
  const done = (target: RouteTarget): Validation<ResolvedPart> => {
    // A task that is completed or superseded is closed; renewed work reopens it.
    if (target.kind === "existing_task" && target.task.status !== "open" && part.reopen_task == null) {
      return fail(`The selected task is ${target.task.status}: set reopen_task true for renewed work, or false for a question about past work.`);
    }
    if (part.reopen_task && (target.kind !== "existing_task" || target.task.status === "open")) return fail("reopen_task true requires an existing completed or superseded task.");
    return ({
    ok: true,
    value: {
      order: part.order,
      request: part.request,
      decision: part.decision,
      taskDecision: part.task_decision,
      target,
      // General conversation has no workspace, so a confidence the model supplied there cannot arm the mutation gate.
      workspaceConfidence: target.kind === "general" ? "high" : part.workspace_confidence ?? "high",
      reopenTask: part.reopen_task === true,
      dependsOn: part.depends_on ?? [],
      reason: part.reason,
    },
  });
  };

  const goalLabel = norm(part.goal_label);
  const taskLabel = norm(part.task_label);

  // The general route: greetings, small talk, and unrelated asides. continue_current and resume_existing
  // reach the same single general task, and general conversation has no workspace, so neither the goal
  // decision nor workspace_confidence is checked here; any field that would select or create a task is.
  if (goalLabel === "general" || (goalLabel === "current" && ctx.current?.goal.general)) {
    if (part.decision === "create_new") return fail("create_new cannot target the general goal; use goal_label general with continue_current or resume_existing.");
    if (
      part.task_decision !== null ||
      part.task_label !== null ||
      part.new_task_title !== null ||
      part.new_goal_title != null ||
      part.new_goal_objective != null ||
      part.new_task_objective != null ||
      part.new_task_completion_criteria != null ||
      part.reopen_task != null
    ) {
      return fail("general requires all task fields and new-goal and new-task definitions null.");
    }
    return done({ kind: "general" });
  }

  if (part.workspace_confidence === null) return fail("A work route requires workspace_confidence high or low.");
  if (part.decision !== "create_new" && part.new_goal_title != null) return fail("new_goal_title must be null unless creating a new goal.");
  if (part.task_decision === "create_task" && part.task_label !== null) return fail("create_task requires task_label null.");
  if (part.task_decision !== "create_task" && part.new_task_title !== null) return fail("new_task_title must be null unless creating a new task.");
  if (part.decision !== "create_new" && part.new_goal_objective != null) return fail("new_goal_objective must be null unless creating a new goal.");
  if (part.task_decision !== "create_task" && (part.new_task_objective != null || part.new_task_completion_criteria != null)) {
    return fail("new_task_objective and new_task_completion_criteria must be null unless creating a new task.");
  }
  /** A model-created task must arrive with its bounded definition (Goal-router.md, "Router output"). */
  const definition = (): { objective: string; completionCriteria: string } | null =>
    part.new_task_objective && part.new_task_completion_criteria
      ? { objective: part.new_task_objective, completionCriteria: part.new_task_completion_criteria }
      : null;
  const missingDefinition = "create_task requires new_task_objective (one line: the bounded outcome) and new_task_completion_criteria (one line: how it is known to be done).";

  switch (part.decision) {
    case "create_new": {
      if (part.goal_label !== null) return fail("create_new requires goal_label null.");
      if (!part.new_goal_title) return fail("create_new requires new_goal_title.");
      if (!part.new_goal_objective) return fail("create_new requires new_goal_objective: one line naming the durable outcome the goal works toward.");
      if (part.task_decision !== "create_task" || !part.new_task_title) {
        return fail("create_new requires task_decision create_task and new_task_title for the new goal's first task.");
      }
      const first = definition();
      if (!first) return fail(missingDefinition);
      return done({
        kind: "new_goal",
        goalTitle: part.new_goal_title,
        goalObjective: part.new_goal_objective,
        taskTitle: part.new_task_title,
        ...first,
      });
    }

    case "continue_current": {
      if (!ctx.current) return fail("continue_current is invalid: there is no current goal. Use create_new, resume_existing, or goal_label general.");
      if (goalLabel !== "current") return fail('continue_current requires goal_label "current".');
      if (part.task_decision === "continue_task") {
        if (taskLabel !== "current") return fail('continue_task requires task_label "current".');
        return done({ kind: "existing_task", goal: ctx.current.goal, task: ctx.current.task });
      }
      if (part.task_decision === "create_task") {
        if (!part.new_task_title) return fail("create_task requires new_task_title.");
        const def = definition();
        if (!def) return fail(missingDefinition);
        return done({ kind: "new_task", goal: ctx.current.goal, taskTitle: part.new_task_title, ...def });
      }
      return fail("continue_current requires task_decision continue_task or create_task. To return to an earlier task of the current goal, use resume_existing with resume_task.");
    }

    case "resume_existing": {
      if (!goalLabel) return fail("resume_existing requires goal_label.");
      const g = resolveGoal(goalLabel, ctx, store, seen);
      if ("error" in g) return fail(g.error);
      const isCurrentGoal = g.goal.id === ctx.current?.goal.id;

      if (part.task_decision === "continue_task") {
        return fail("continue_task is valid only for the current task of the current goal (continue_current). Use resume_task or create_task.");
      }
      // A new task in the current goal is canonically continue_current; resume_existing reaches the same goal and is accepted.
      if (part.task_decision === "create_task") {
        if (!part.new_task_title) return fail("create_task requires new_task_title.");
        const def = definition();
        if (!def) return fail(missingDefinition);
        return done({ kind: "new_task", goal: g.goal, taskTitle: part.new_task_title, ...def });
      }
      if (part.task_decision === "resume_task") {
        if (!taskLabel) return fail("resume_task requires task_label.");
        if (isCurrentGoal && taskLabel === "current") {
          return fail('task_label "current" is the current task; continuing it is continue_current with continue_task.');
        }
        const t = resolveTask(g.goal, taskLabel, ctx, store, seen);
        if ("error" in t) return fail(t.error);
        return done({ kind: "existing_task", goal: g.goal, task: t });
      }
      return fail("resume_existing requires task_decision resume_task or create_task.");
    }
  }
}

/** Validate an ask_user call. Clarify is always constructive (Goal-router.md, rule 13). */
export function validateAskUser(input: unknown, ctx: RoutingContext, store?: LedgerStore, seen: SeenSelectors = emptySeen()): Validation<AskUserInput> {
  if (ctx.answeringClarification) {
    return { ok: false, errors: ["ask_user is unavailable: the user is answering your previous clarification. Return a decision."] };
  }
  const parsed = AskUserInput.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const ask = parsed.data;
  if (ask.candidates.length === 0) {
    if (!ask.zero_history) return { ok: false, errors: ["candidates must be non-empty: enumerate the goals you considered, leading with your best guess."] };
    if (!ctx.zeroHistory) return { ok: false, errors: ["zero_history is allowed only when there is no past activity at all; enumerate the nearest plausible candidates instead."] };
  } else if (ask.zero_history) {
    return { ok: false, errors: ["zero_history must not be set when candidates are supplied."] };
  }
  if (ask.candidates.filter((c) => c.suggested).length > 1) {
    return { ok: false, errors: ["Mark at most one candidate as suggested."] };
  }
  for (const candidate of ask.candidates) {
    if (candidate.task_label && !candidate.goal_label) return {ok: false, errors: ["Candidate task_label requires goal_label."]};
    if (!candidate.goal_label) continue;
    if (candidate.goal_label === "general") {
      if (candidate.task_label) return {ok: false, errors: ["The general candidate has task_label null."]};
      continue;
    }
    if (!store) return {ok: false, errors: ["Candidate binding requires ledger validation."]};
    const goal = resolveGoal(candidate.goal_label, ctx, store, seen);
    if ("error" in goal) return {ok: false, errors: [goal.error]};
    if (candidate.task_label) {
      const task = resolveTask(goal.goal, candidate.task_label, ctx, store, seen);
      if ("error" in task) return {ok: false, errors: [task.error]};
    }
  }
  return { ok: true, value: ask };
}
