import { ContextRetrieveInput, type EventPayloads } from "@socrates/contracts";
import { countTokens, truncateToTokens, zonedParts } from "@socrates/shared";
import { type Evidence, type Goal, type Task, type Turn, excerpt, goalSelector, parseGoalSelector, parseTaskSelector, taskSelector, toFtsQuery } from "@socrates/store";
import { RESULT_CEILING_TOKENS, headTail } from "../bounds";
import type { HandlerContext } from "../context";
import { ToolError } from "../errors";
import { type ToolHandler, json } from "../handler";
import { page } from "../paging";

export const LEDGER_DEFAULT_LIMIT = 10;
export const LEDGER_MAX_LIMIT = 25;
export const SEARCH_DEFAULT_TOP_N = 5;
export const SEARCH_MAX_TOP_N = 10;
/** One aggregate bound for every context_retrieve action (agent-harness.md, "inspect"). */
export const MAX_LINES = 2_000;
export const MAX_BYTES = 50 * 1024;
const FROZEN_SET_LIMIT = 500;
const PREVIEW_TOKENS = 500;

type Query = Extract<ContextRetrieveInput, { action: "ledger_search" }>;
type Search = Extract<ContextRetrieveInput, { action: "search" }>;
type Inspect = Extract<ContextRetrieveInput, { action: "inspect" }>;

function dateOf(ctx: HandlerContext, iso: string): string {
  return zonedParts(new Date(iso), ctx.timeZone).date;
}

function inRange(ctx: HandlerContext, iso: string, from?: string, to?: string): boolean {
  const date = dateOf(ctx, iso);
  return (!from || date >= from) && (!to || date <= to);
}

function checkRange(from?: string, to?: string): void {
  if (from && to && from > to) throw new ToolError("invalid_range", `from (${from}) is after to (${to}).`, "Swap the dates or widen the range.");
}

function currentGoal(ctx: HandlerContext): Goal {
  return ctx.store.requireGoal(ctx.binding.goalId);
}

function goalLabel(goal: Goal): string {
  return `${goalSelector(goal)} — ${goal.title}`;
}

/** Resolve gN, tN (current goal only), or gN/tN. Never widens a bare tN to other goals. */
function resolveTask(ctx: HandlerContext, ref: string): { goal: Goal; task: Task } | null {
  const local = /^t(\d+)$/i.exec(ref);
  if (local) {
    const goal = currentGoal(ctx);
    const task = ctx.store.getTaskByNumber(goal.id, Number(local[1]));
    if (!task) {
      throw new ToolError(
        "task_not_found_in_current_goal",
        `${ref} is not a task of the current goal ${goalLabel(goal)}.`,
        "A bare tN always means the current goal. Use ledger_search to find the task, then retry with gN/tN.",
      );
    }
    return { goal, task };
  }
  const sel = parseTaskSelector(ref);
  if (!sel) return null;
  const goal = ctx.store.getGoalByNumber(sel.goal);
  const task = goal ? ctx.store.getTaskByNumber(goal.id, sel.task) : null;
  if (!goal || !task) throw new ToolError("task_not_found", `${ref} does not exist.`, "Use ledger_search to find the task selector.");
  return { goal, task };
}

function resolveGoalRef(ctx: HandlerContext, ref: string): Goal | null {
  const n = parseGoalSelector(ref);
  if (n === null) return null;
  const goal = ctx.store.getGoalByNumber(n);
  if (!goal) throw new ToolError("goal_not_found", `${ref} does not exist.`, "Use ledger_search with scope all_goals to find the goal selector.");
  return goal;
}

// ── ledger_search ───────────────────────────────────────────────────────────

interface LedgerItem {
  kind: "goal" | "task";
  goal: Goal;
  task: Task | null;
  updatedAt: string;
}

function ledgerSearch(input: Query, ctx: HandlerContext) {
  checkRange(input.from, input.to);
  const entity = input.entity ?? "both";
  const scope = input.scope ?? "current_goal";
  const status = input.status ?? "any";
  const match = input.match ?? "hybrid";
  const limit = Math.min(input.limit ?? LEDGER_DEFAULT_LIMIT, LEDGER_MAX_LIMIT);
  const key = json(["ledger_search", input.query ?? null, entity, scope, status, input.from ?? null, input.to ?? null, match]);

  let items: LedgerItem[];
  let offset = 0;
  if (input.cursor) {
    ({ items, offset } = ctx.run.takeCursor<LedgerItem>(input.cursor, key));
  } else {
    const store = ctx.store;
    const goals = scope === "current_goal" ? [currentGoal(ctx)] : store.listGoals();
    const goalIds = new Set(goals.map((g) => g.id));
    const candidates: LedgerItem[] = [];
    const add = (goal: Goal, task: Task | null) => candidates.push({ kind: task ? "task" : "goal", goal, task, updatedAt: task?.updatedAt ?? goal.updatedAt });

    if (input.query && match === "hybrid") {
      const fts = toFtsQuery(input.query);
      if (!fts) throw new ToolError("empty_query", "The query contains no searchable words.", "Use distinctive words such as a feature or project name, or omit query to list recent rows.");
      for (const hit of store.searchLedger(fts, FROZEN_SET_LIMIT)) {
        if (!goalIds.has(hit.goalId)) continue;
        const goal = store.requireGoal(hit.goalId);
        add(goal, hit.entity === "task" ? store.requireTask(hit.entityId) : null);
      }
    } else {
      const needle = input.query?.toLowerCase();
      const hay = (...parts: (string | null)[]) => parts.join("\n").toLowerCase();
      for (const goal of goals) {
        if (!needle || hay(goal.title, goal.objective, goal.note).includes(needle)) add(goal, null);
        for (const task of store.listTasks(goal.id)) {
          if (!needle || hay(task.title, task.objective, task.completionCriteria, task.continuationNote).includes(needle)) add(goal, task);
        }
      }
      candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    items = candidates
      .filter((c) => entity === "both" || (entity === "goals" ? c.kind === "goal" : c.kind === "task"))
      .filter((c) => status === "any" || (c.task ?? c.goal).status === status)
      .filter((c) => inRange(ctx, c.updatedAt, input.from, input.to))
      .slice(0, FROZEN_SET_LIMIT);
  }

  const row = (c: LedgerItem) =>
    c.task
      ? { kind: "task", selector: taskSelector(c.goal, c.task), goal: goalLabel(c.goal), title: c.task.title, objective: c.task.objective, status: c.task.status, note: excerpt(c.task.continuationNote, 240) || null, updated_at: c.updatedAt }
      : { kind: "goal", selector: goalSelector(c.goal), title: c.goal.title, objective: c.goal.objective, status: c.goal.status, note: excerpt(c.goal.note, 240) || null, updated_at: c.updatedAt };
  const { out, nextCursor } = page(ctx, key, items, offset, limit, (c) => json(row(c)));
  return { action: "ledger_search", query: input.query ?? null, scope, results: out.map(row), returned: out.length, more_matches: nextCursor !== null, next_cursor: nextCursor };
}

// ── search ──────────────────────────────────────────────────────────────────

interface Hit {
  turnId: string;
  projectTurn: number;
  goalId: string;
  taskId: string;
  at: string;
  userMessage: string;
  response: string;
}

function preview(text: string, tokens: number) {
  const cut = truncateToTokens(text, tokens);
  return { text: cut.truncated ? `${cut.text}…` : text, complete: !cut.truncated, omitted: cut.truncated ? `about ${countTokens(text) - tokens} tokens omitted` : null };
}

function search(input: Search, ctx: HandlerContext) {
  checkRange(input.from, input.to);
  if (!input.query && !input.from && !input.to) {
    throw new ToolError("query_or_range_required", "search needs a query, a date range, or both.", 'Pass query, or from/to dates (YYYY-MM-DD) for "what did we do last week" questions.');
  }
  const match = input.match ?? "hybrid";
  const target = input.target ?? "current_task";
  const topN = Math.min(input.top_n ?? SEARCH_DEFAULT_TOP_N, SEARCH_MAX_TOP_N);
  const key = json(["search", input.query ?? null, match, target, input.from ?? null, input.to ?? null]);

  let resolvedTarget: Record<string, string> | null = null;
  let scopeNote: string | null = null;
  let filter: { taskIds?: string[]; goalIds?: string[] } = {};
  if (target === "current_task") filter = { taskIds: [ctx.binding.taskId] };
  else if (target === "current_goal") filter = { goalIds: [ctx.binding.goalId] };
  else if (target !== "all_goals") {
    const task = resolveTask(ctx, target);
    const goal = task ? null : resolveGoalRef(ctx, target);
    if (task) {
      filter = { taskIds: [task.task.id] };
      resolvedTarget = { goal: goalLabel(task.goal), task: `${taskSelector(task.goal, task.task)} — ${task.task.title}` };
      if (/^t\d+$/i.test(target)) scopeNote = "A task selector without a goal defaults to the current goal. Use gN/tN to select a task from another goal.";
    } else if (goal) {
      filter = { goalIds: [goal.id] };
      resolvedTarget = { goal: goalLabel(goal) };
    } else {
      throw new ToolError("invalid_target", `target ${target} is not recognized.`, "Use current_task, current_goal, all_goals, gN, tN, or gN/tN.");
    }
  }

  let items: Hit[];
  let offset = 0;
  if (input.cursor) {
    ({ items, offset } = ctx.run.takeCursor<Hit>(input.cursor, key));
  } else {
    let fts: string | undefined;
    if (input.query && match === "hybrid") {
      fts = toFtsQuery(input.query);
      if (!fts) throw new ToolError("empty_query", "The query contains no searchable words.", 'Use distinctive words, or match "exact" for literal text.');
    }
    items = ctx.store
      .searchExchanges({ ...filter, ...(fts ? { fts } : {}), ...(input.query && match === "exact" ? { exact: input.query } : {}), limit: FROZEN_SET_LIMIT })
      .filter((h) => inRange(ctx, h.at, input.from, input.to));
  }

  const goals = new Map<string, Goal>();
  const goalOf = (id: string) => goals.get(id) ?? goals.set(id, ctx.store.requireGoal(id)).get(id)!;
  const render = (h: Hit, ref: string) => {
    const user = preview(h.userMessage, PREVIEW_TOKENS);
    const reply = preview(h.response, PREVIEW_TOKENS);
    return {
      ref,
      project_turn: h.projectTurn,
      date: dateOf(ctx, h.at),
      goal: goalOf(h.goalId).title,
      user_message: user.text,
      socrates_response: reply.text,
      complete: user.complete && reply.complete,
      omitted: [user.omitted && `user message: ${user.omitted}`, reply.omitted && `response: ${reply.omitted}`].filter(Boolean).join("; ") || null,
    };
  };
  const { out, nextCursor } = page(ctx, key, items, offset, topN, (h) => json(render(h, "r0")));
  const results = out.map((h) => render(h, ctx.run.issueRef("r", { kind: "turn", turnId: h.turnId })));
  return {
    action: "search",
    query: input.query ?? null,
    match,
    target,
    ...(resolvedTarget ? { resolved_target: resolvedTarget } : {}),
    ...(scopeNote ? { scope_note: scopeNote } : {}),
    results,
    returned: results.length,
    more_matches: nextCursor !== null,
    next_cursor: nextCursor,
  };
}

// ── inspect ─────────────────────────────────────────────────────────────────

/** A bounded text component with explicit omission. */
function component(text: string | null, tokens: number) {
  if (text === null) return null;
  const cut = headTail(text, tokens);
  return { content: cut.text, complete: !cut.truncated, omitted: cut.truncated ? `${cut.omittedLines} lines omitted from the middle` : null };
}

function compactInput(input: unknown, tokens: number): string {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return headTail(text, tokens).text;
}

/** The complete stored output of one call, as text. */
function storedOutput(e: Evidence): string {
  const r = e.result;
  if (!r) return "(no result recorded; the call was interrupted)";
  if (r.status === "error") return JSON.stringify({ error: r.error });
  const full = (r.result as { output_full?: unknown } | null)?.output_full;
  return typeof full === "string" ? full : JSON.stringify(r.result);
}

function goalView(goal: Goal, ctx: HandlerContext, scale: number) {
  const store = ctx.store;
  const tasks = store.listTasks(goal.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = tasks.slice(0, Math.max(5, Math.floor(40 * scale)));
  const workspace = goal.workspaceId ? store.getWorkspace(goal.workspaceId)?.name ?? null : null;
  return {
    action: "inspect",
    goal: { selector: goalSelector(goal), title: goal.title, objective: goal.objective, status: goal.status, workspace, note: goal.note, created_at: goal.createdAt, updated_at: goal.updatedAt },
    anchors: store.listAnchors(goal.id).map((a) => ({ path: a.path, role: a.role, status: a.status, summary: a.summary })),
    tasks: shown.map((t) => ({ selector: taskSelector(goal, t), title: t.title, status: t.status, updated_at: t.updatedAt })),
    tasks_omitted: tasks.length - shown.length,
    bounded: true,
  };
}

function taskView(goal: Goal, task: Task, ctx: HandlerContext, scale: number) {
  const facts = ctx.store.taskFacts(task.id);
  const cap = Math.max(5, Math.floor(25 * scale));
  const of = (kind: string) => [...new Set(facts.filter((f) => f.kind === kind).map((f) => f.value))].slice(0, cap);
  const turns = ctx.store.turnsForTask(task.id);
  return {
    action: "inspect",
    task: {
      selector: taskSelector(goal, task),
      goal: goalLabel(goal),
      title: task.title,
      objective: task.objective,
      completion_criteria: task.completionCriteria,
      status: task.status,
      note: task.continuationNote,
      started_at: task.startedAt,
      updated_at: task.updatedAt,
      completed_at: task.completedAt,
    },
    files_changed: of("file_changed"),
    commands: of("command"),
    tests: of("test"),
    capabilities: of("capability"),
    turns: turns.slice(-Math.max(10, Math.floor(50 * scale))).map((t) => t.projectTurn),
    bounded: true,
  };
}

function turnView(turn: Turn, ref: string | null, ctx: HandlerContext, scale: number) {
  const store = ctx.store;
  const request = store.requestForTurn(turn.id).request;
  const response = turn.responseEventId ? (store.getEvent(turn.responseEventId)?.payload as EventPayloads["assistant_response"]).text : null;
  const goal = turn.goalId ? store.requireGoal(turn.goalId) : null;
  const task = turn.taskId ? store.requireTask(turn.taskId) : null;
  const sameTask = turn.taskId === ctx.binding.taskId;
  const evidence = store.evidenceForTurn(turn.id);
  const toolBudget = Math.floor(4_000 * scale);
  const perCall = evidence.length ? Math.floor(toolBudget / evidence.length) : 0;
  const detailed = perCall >= 80;
  return {
    action: "inspect",
    turn: {
      ref,
      project_turn: turn.projectTurn,
      date: dateOf(ctx, turn.createdAt),
      goal: goal?.title ?? null,
      task: goal && task ? `${taskSelector(goal, task)} — ${task.title}` : null,
      status: turn.status,
    },
    user_message: component(request, Math.floor(2_500 * scale)),
    tool_activity: evidence.map((e, i) => ({
      ref: sameTask ? e.handle : null,
      tool: e.tool,
      status: e.status ?? "interrupted",
      input: compactInput(e.input, detailed ? Math.min(150, Math.floor(perCall / 3)) : 40),
      ...(detailed || i < 3 ? { output: component(e.result?.content ?? storedOutput(e), Math.max(40, perCall - 50)) } : {}),
    })),
    ...(evidence.length && !sameTask ? { tool_note: "Tool calls of another task are inspected from within that task." } : {}),
    final_response: component(response, Math.floor(2_500 * scale)),
    bounded: true,
  };
}

function evidenceView(e: Evidence, ctx: HandlerContext, scale: number) {
  const turn = e.turnId ? ctx.store.getTurn(e.turnId) : null;
  return {
    action: "inspect",
    evidence: {
      ref: e.handle,
      tool: e.tool,
      status: e.status ?? "interrupted",
      project_turn: turn?.projectTurn ?? null,
      wall_time_ms: e.result?.wall_time_ms ?? null,
    },
    input: component(typeof e.input === "string" ? e.input : JSON.stringify(e.input, null, 1), Math.floor(2_000 * scale)),
    output: component(storedOutput(e), Math.floor(6_500 * scale)),
    bounded: true,
  };
}

function inspect(input: Inspect, ctx: HandlerContext) {
  if ((input.ref === undefined) === (input.turn_number === undefined)) {
    throw new ToolError("one_reference_required", "inspect takes exactly one of ref or turn_number.", 'Pass ref (gN, tN, gN/tN, rN, eN, hc-N) or turn_number, for example {"action":"inspect","ref":"e3"}.');
  }
  let build: (scale: number) => unknown;
  if (input.turn_number !== undefined) {
    const turn = ctx.store.getTurnByNumber(input.turn_number);
    if (!turn) {
      const latest = ctx.store.latestProjectTurn();
      throw new ToolError("turn_not_found", `Project turn ${input.turn_number} does not exist.`, latest ? `Use context_retrieve search, or inspect an existing project turn between 1 and ${latest}.` : "There are no earlier turns yet.");
    }
    build = (scale) => turnView(turn, null, ctx, scale);
  } else {
    const ref = input.ref!.trim();
    const goal = resolveGoalRef(ctx, ref);
    const task = goal ? null : resolveTask(ctx, ref);
    const runRef = /^r\d+$/i.test(ref) ? ctx.run.ref(ref.toLowerCase()) : undefined;
    const evidence = /^e(\d+)$/i.exec(ref);
    if (goal) build = (scale) => goalView(goal, ctx, scale);
    else if (task) build = (scale) => taskView(task.goal, task.task, ctx, scale);
    else if (runRef?.kind === "turn") {
      const turn = ctx.store.requireTurn(runRef.turnId);
      build = (scale) => turnView(turn, ref, ctx, scale);
    } else if (evidence) {
      const e = ctx.store.getEvidence(ctx.binding.taskId, Number(evidence[1]));
      if (!e) {
        const count = ctx.store.evidenceCount(ctx.binding.taskId);
        throw new ToolError("evidence_not_found", `${ref} is not a tool call of the current task.`, count ? `Evidence handles of this task run from e1 to e${count}. Handles from other tasks resolve only within them.` : "This task has no recorded tool calls yet.");
      }
      build = (scale) => evidenceView(e, ctx, scale);
    } else if (/^hc-\d+$/i.test(ref)) {
      throw new ToolError("checkpoint_not_found", `${ref} is not a history checkpoint of the current task.`, "This task has no checkpoints. Use search or inspect turn_number to recover earlier turns.");
    } else if (/^r\d+$/i.test(ref)) {
      throw new ToolError("unknown_reference", `${ref} is not a search result of this run.`, "Run context_retrieve search again and inspect a ref it returns.");
    } else {
      throw new ToolError("unknown_reference", `${ref} is not a recognized reference.`, "Use gN, tN, gN/tN, rN from search, eN for a tool call, hc-N for a checkpoint, or turn_number.");
    }
  }
  // Shrink the view until it fits every aggregate bound.
  for (let scale = 1; ; scale *= 0.6) {
    const view = build(scale);
    const text = json(view);
    if ((fits(text) && fits(viewLines(view))) || scale < 0.05) return view;
  }
}

function viewLines(view: unknown): string {
  return JSON.stringify(view, null, 0).replace(/\\n/g, "\n");
}

function fits(text: string): boolean {
  if (text.split("\n").length > MAX_LINES) return false;
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return false;
  return countTokens(text) <= RESULT_CEILING_TOKENS - 200;
}

export const contextRetrieveTool: ToolHandler<ContextRetrieveInput> = {
  name: "context_retrieve",
  description: [
    "Recall earlier work from Socrates' memory. Three actions:",
    "ledger_search — find goals and tasks by their metadata (query, entity goals|tasks|both, scope current_goal|all_goals, status, from/to dates, match hybrid|exact, limit, cursor); returns selectors such as g7 and g7/t4.",
    "search — find exact past questions and answers (query and/or from/to dates; target current_task (default) | current_goal | all_goals | gN | tN | gN/tN; top_n default 5); returns short refs such as r1. A bare tN means a task of the current goal.",
    "inspect — open one record: ref gN, tN, gN/tN, rN (a search result), eN (a tool call of this task), or turn_number for any [TURN k] label.",
    "Output is always bounded; omissions are stated with refs you can inspect.",
  ].join(" "),
  schema: ContextRetrieveInput,
  concurrency: "parallel",
  mutating: false,
  async execute(input, ctx) {
    const result = input.action === "ledger_search" ? ledgerSearch(input, ctx) : input.action === "search" ? search(input, ctx) : inspect(input, ctx);
    return { content: json(result), result };
  },
};
