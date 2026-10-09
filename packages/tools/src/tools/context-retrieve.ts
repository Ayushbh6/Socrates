import { ContextRetrieveInput, type EventPayloads } from "@socrates/contracts";
import { countTokens, nextDay, truncateToTokens, zonedDayStart, zonedParts } from "@socrates/shared";
import { type Evidence, type Goal, type Task, type Turn, excerpt, foldText, goalSelector, parseGoalSelector, parseTaskSelector, taskSelector, toFtsQuery } from "@socrates/store";
import { fuse, recencyBoost } from "@socrates/retrieval";
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

async function ledgerSearch(input: Query, ctx: HandlerContext) {
  checkRange(input.from, input.to);
  const entity = input.entity ?? "both";
  const scope = input.scope ?? "current_goal";
  const status = input.status ?? "any";
  const match = input.match ?? "hybrid";
  const limit = Math.min(input.limit ?? LEDGER_DEFAULT_LIMIT, LEDGER_MAX_LIMIT);
  const key = json(["ledger_search", input.query ?? null, entity, scope, status, input.from ?? null, input.to ?? null, match]);

  let items: LedgerItem[];
  let offset = 0;
  let capped = false;
  if (input.cursor) {
    ({ items, offset, capped } = ctx.run.takeCursor<LedgerItem>(input.cursor, key));
  } else {
    const store = ctx.store;
    const goals = scope === "current_goal" ? [currentGoal(ctx)] : store.listGoals();
    const goalIds = new Set(goals.map((g) => g.id));
    // Every filter applies while collecting, so the collection limit never hides a matching row.
    const keep = (c: LedgerItem) =>
      goalIds.has(c.goal.id) &&
      (entity === "both" || (entity === "goals" ? c.kind === "goal" : c.kind === "task")) &&
      (status === "any" || (c.task ?? c.goal).status === status) &&
      inRange(ctx, c.updatedAt, input.from, input.to);
    const collected: LedgerItem[] = [];
    const add = (goal: Goal, task: Task | null) => {
      const item: LedgerItem = { kind: task ? "task" : "goal", goal, task, updatedAt: task?.updatedAt ?? goal.updatedAt };
      if (keep(item)) collected.push(item);
      return collected.length <= FROZEN_SET_LIMIT;
    };

    if (input.query && match === "hybrid") {
      const fts = toFtsQuery(input.query);
      if (!fts) throw new ToolError("empty_query", "The query contains no searchable words.", "Use distinctive words such as a feature or project name, or omit query to list recent rows.");
      scan: for (let from = 0; ; from += 200) {
        const hits = store.searchLedger(fts, 200, from);
        for (const hit of hits) {
          if (!goalIds.has(hit.goalId)) continue;
          if (!add(store.requireGoal(hit.goalId), hit.entity === "task" ? store.requireTask(hit.entityId) : null)) break scan;
        }
        if (hits.length < 200) break;
      }
      // Meaning matches join the keyword matches in one fused ranking.
      const lexical = collected.splice(0);
      const eligibleIds = goals.flatMap((goal) => [
        { kind: "goal" as const, goal, task: null, updatedAt: goal.updatedAt },
        ...store.listTasks(goal.id).map((task) => ({ kind: "task" as const, goal, task, updatedAt: task.updatedAt })),
      ]).filter(keep).map((item) => (item.task ?? item.goal).id);
      const semantic = await ctx.semantic?.search(input.query, { kinds: entity === "goals" ? ["goal"] : entity === "tasks" ? ["task"] : ["goal", "task"], goalIds: [...goalIds], sourceIds: eligibleIds, limit: 50 }, ctx.signal) ?? [];
      const meaning: LedgerItem[] = [];
      for (const h of semantic) {
        const task = h.kind === "task" ? store.getTask(h.sourceId) : null;
        const goal = store.getGoal(task?.goalId ?? h.sourceId);
        if (!goal) continue;
        const item: LedgerItem = { kind: task ? "task" : "goal", goal, task, updatedAt: task?.updatedAt ?? goal.updatedAt };
        if (keep(item)) meaning.push(item);
      }
      const now = store.clock.now();
      collected.push(...fuse([lexical, meaning], (c) => `${c.kind}:${(c.task ?? c.goal).id}`, (c) => recencyBoost(c.updatedAt, now)).map((f) => f.item));
    } else {
      const needle = input.query ? foldText(input.query) : null;
      const has = (...parts: (string | null)[]) => !needle || foldText(parts.filter(Boolean).join("\n")).includes(needle);
      const candidates: { goal: Goal; task: Task | null; updatedAt: string; text: () => boolean }[] = [];
      for (const goal of goals) {
        const workspace = goal.workspaceId ? (store.getWorkspace(goal.workspaceId)?.name ?? null) : null;
        const anchors = store.listAnchors(goal.id).map((a) => `${a.path} ${a.role} ${a.summary}`).join("\n");
        candidates.push({ goal, task: null, updatedAt: goal.updatedAt, text: () => has(goal.title, goal.objective, goal.note, workspace, anchors) });
        for (const task of store.listTasks(goal.id)) {
          candidates.push({ goal, task, updatedAt: task.updatedAt, text: () => has(task.title, task.objective, task.completionCriteria, task.continuationNote, workspace, ...store.distinctFacts(task.id)) });
        }
      }
      candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const c of candidates) if (c.text() && !add(c.goal, c.task)) break;
    }
    capped = collected.length > FROZEN_SET_LIMIT;
    items = collected.slice(0, FROZEN_SET_LIMIT);
  }

  const row = (c: LedgerItem) =>
    c.task
      ? { kind: "task", selector: taskSelector(c.goal, c.task), goal: goalLabel(c.goal), title: c.task.title, objective: c.task.objective, status: c.task.status, note: excerpt(c.task.continuationNote, 240) || null, updated_at: c.updatedAt }
      : { kind: "goal", selector: goalSelector(c.goal), title: c.goal.title, objective: c.goal.objective, status: c.goal.status, note: excerpt(c.goal.note, 240) || null, updated_at: c.updatedAt };
  const { out, nextCursor } = page(ctx, key, items, offset, limit, (c) => json(row(c)), { capped, maxBytes: MAX_BYTES, maxLines: MAX_LINES });
  return {
    action: "ledger_search",
    query: input.query ?? null,
    scope,
    results: out.map(row),
    returned: out.length,
    more_matches: nextCursor !== null || capped,
    next_cursor: nextCursor,
    ...(capped ? { note: `More than ${FROZEN_SET_LIMIT} rows match; only the first ${FROZEN_SET_LIMIT} can be paged. Narrow the query, scope, status, or dates.` } : {}),
  };
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

async function search(input: Search, ctx: HandlerContext) {
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
  let capped = false;
  if (input.cursor) {
    ({ items, offset, capped } = ctx.run.takeCursor<Hit>(input.cursor, key));
  } else {
    let fts: string | undefined;
    if (input.query && match === "hybrid") {
      fts = toFtsQuery(input.query);
      if (!fts) throw new ToolError("empty_query", "The query contains no searchable words.", 'Use distinctive words, or match "exact" for literal text.');
    }
    // Dates are the user's calendar days, applied in the query before any limit.
    const dates = {
      ...(input.from ? { fromIso: zonedDayStart(input.from, ctx.timeZone).toISOString() } : {}),
      ...(input.to ? { beforeIso: zonedDayStart(nextDay(input.to), ctx.timeZone).toISOString() } : {}),
    };
    let hits: Hit[] = ctx.store.searchExchanges({
      ...filter,
      ...dates,
      includeRedone: true,
      ...(fts ? { fts } : {}),
      ...(input.query && match === "exact" ? { exact: input.query } : {}),
      limit: FROZEN_SET_LIMIT + 1,
    });
    if (fts && ctx.semantic) {
      // A meaning match on an exchange or on one of its tool calls finds the exchange.
      const semantic = await ctx.semantic.search(input.query!, { kinds: ["exchange", "tool_call"], ...filter, ...dates, limit: 50 }, ctx.signal);
      const meaning = [...new Set(semantic.map((h) => h.turnId!))]
        .map((id) => ctx.store.exchangeForTurn(id))
        .filter((h): h is Hit => !!h && (!dates.fromIso || h.at >= dates.fromIso) && (!dates.beforeIso || h.at < dates.beforeIso));
      const now = ctx.store.clock.now();
      capped = hits.length > FROZEN_SET_LIMIT;
      hits = fuse([hits.slice(0, FROZEN_SET_LIMIT), meaning], (h) => h.turnId, (h) => recencyBoost(h.at, now)).map((f) => f.item);
    }
    capped ||= hits.length > FROZEN_SET_LIMIT;
    items = hits.slice(0, FROZEN_SET_LIMIT);
  }

  const goals = new Map<string, Goal>();
  const goalOf = (id: string) => goals.get(id) ?? goals.set(id, ctx.store.requireGoal(id)).get(id)!;
  const redoneIn = (turnId: string) => redoneInOf(ctx, turnId);
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
      ...redoneIn(h.turnId),
    };
  };
  const { out, nextCursor } = page(ctx, key, items, offset, topN, (h) => json(render(h, "r0")), { capped, maxBytes: MAX_BYTES, maxLines: MAX_LINES });
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
    more_matches: nextCursor !== null || capped,
    next_cursor: nextCursor,
    ...(capped ? { note: `More than ${FROZEN_SET_LIMIT} exchanges match; only the first ${FROZEN_SET_LIMIT} can be paged. Narrow the query, target, or dates.` } : {}),
  };
}

/** For a turn set aside by a redo: where its question was asked again, so its answer is not taken as that task's. */
function redoneInOf(ctx: HandlerContext, turnId: string): { redone_in?: string } {
  const redo = ctx.store.redoneTo(turnId);
  if (!redo?.taskId) return {};
  const task = ctx.store.requireTask(redo.taskId);
  const goal = ctx.store.requireGoal(task.goalId);
  return { redone_in: `${taskSelector(goal, task)} (the user asked this again there; this answer was set aside)` };
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
  if (r.status === "error") return JSON.stringify({ error: r.error, failure_detail: r.failure_detail ?? null });
  const full = (r.result as { output_full?: unknown } | null)?.output_full;
  return typeof full === "string" ? full : JSON.stringify(r.result);
}

function goalView(goal: Goal, ctx: HandlerContext, scale: number) {
  const store = ctx.store;
  const tasks = store.listTasks(goal.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = tasks.slice(0, Math.max(5, Math.floor(40 * scale)));
  const workspace = goal.workspaceId ? store.getWorkspace(goal.workspaceId)?.name ?? null : null;
  const anchors = store.listAnchors(goal.id);
  const anchorCap = Math.max(5, Math.floor(40 * scale));
  return {
    action: "inspect",
    goal: { selector: goalSelector(goal), title: goal.title, objective: goal.objective, status: goal.status, workspace, note: goal.note, created_at: goal.createdAt, updated_at: goal.updatedAt },
    anchors: anchors.slice(0, anchorCap).map((a) => ({ path: a.path, role: a.role, status: a.status, summary: excerpt(a.summary, Math.max(60, Math.floor(400 * scale))) })),
    anchors_omitted: Math.max(0, anchors.length - anchorCap),
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
  const { request, attachments } = store.requestForTurn(turn.id);
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
    // Read one by its path to see it again.
    ...(attachments.length ? { attached_images: attachments.map((a) => ({ path: a.path, name: a.name, width: a.width, height: a.height })) } : {}),
    tool_activity: evidence.map((e, i) => ({
      ref: sameTask ? e.handle : null,
      tool: e.tool,
      status: e.status ?? "interrupted",
      input: compactInput(e.input, detailed ? Math.min(150, Math.floor(perCall / 3)) : 40),
      ...(detailed || i < 3 ? { output: component(e.result?.content ?? storedOutput(e), Math.max(40, perCall - 50)) } : {}),
    })),
    ...(evidence.length && !sameTask ? { tool_note: "Tool calls of another task are inspected from within that task." } : {}),
    final_response: component(response, Math.floor(2_500 * scale)),
    // Exact received text remains in agent_message events; inspection exposes
    // a bounded transcript without provider-private reasoning or signatures.
    assistant_messages: component(store.listEvents({ turnId: turn.id, type: "agent_message" }).map(e => {
      const p = e.payload as EventPayloads["agent_message"];
      return `${p.phase}: ${p.response.text}`;
    }).join("\n\n"), Math.floor(1_500 * scale)),
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
    // A qualified gN/tN/eM names evidence of another task, as compound-part handoffs do.
    const qualified = /^(g\d+\/t\d+)\/e(\d+)$/i.exec(ref);
    const goal = qualified ? null : resolveGoalRef(ctx, ref);
    const task = goal ? null : resolveTask(ctx, qualified ? qualified[1]! : ref);
    const runRef = /^r\d+$/i.test(ref) ? ctx.run.ref(ref.toLowerCase()) : undefined;
    const evidence = /^e(\d+)$/i.exec(ref);
    if (qualified) {
      const e = ctx.store.getEvidence(task!.task.id, Number(qualified[2]));
      if (!e) {
        const count = ctx.store.evidenceCount(task!.task.id);
        throw new ToolError("evidence_not_found", `${ref} does not exist.`, count ? `Evidence handles of ${qualified[1]} run from e1 to e${count}.` : `${qualified[1]} has no recorded tool calls.`);
      }
      build = (scale) => evidenceView(e, ctx, scale);
    } else if (goal) build = (scale) => goalView(goal, ctx, scale);
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
      const record = ctx.store.historyRecord(ctx.binding.taskId, Number(ref.slice(3)));
      if (!record) {
        const count = ctx.store.historyRecordCount(ctx.binding.taskId);
        throw new ToolError(
          "checkpoint_not_found",
          `${ref} is not a history checkpoint of the current task.`,
          count ? `This task's checkpoints and capsules run from hc-1 to hc-${count}.` : "This task has no checkpoints. Use search or inspect turn_number to recover earlier turns.",
        );
      }
      const latest = ctx.store.latestHistoryRecord(ctx.binding.taskId)!;
      build = () => ({
        action: "inspect",
        checkpoint: {
          ref: record.handle,
          kind: record.kind,
          turns_covered: record.from > 0 ? { from: record.from, to: record.to } : null,
          date: dateOf(ctx, record.createdAt),
          active: record.number === latest.number,
          mechanical: record.mechanical,
        },
        content: record.content,
        bounded: true,
      });
    } else if (/^r\d+$/i.test(ref)) {
      throw new ToolError("unknown_reference", `${ref} is not a search result of this run.`, "Run context_retrieve search again and inspect a ref it returns.");
    } else {
      throw new ToolError("unknown_reference", `${ref} is not a recognized reference.`, "Use gN, tN, gN/tN, rN from search, eN (or gN/tN/eN for another task) for a tool call, hc-N for a checkpoint, or turn_number.");
    }
  }
  // Prefer a proportionally smaller view; enforceBounds is the final guarantee.
  for (let scale = 1; ; scale *= 0.6) {
    const view = build(scale);
    if (fitsBounds(view) || scale < 0.1) return view;
  }
}

/** Whether a view's rendering is within every aggregate bound: lines (of its text), bytes, and tokens. */
function fitsBounds(view: unknown): boolean {
  const text = json(view);
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return false;
  if (text.split("\\n").length > MAX_LINES) return false;
  return countTokens(text) <= RESULT_CEILING_TOKENS - 200;
}

/**
 * The one aggregate bound for every context_retrieve result: shorten the
 * longest text first, then long lists, each with an explicit omission
 * marker, until the result fits. Nothing is silently dropped.
 */
export function enforceBounds<T>(view: T): T {
  if (fitsBounds(view)) return view;
  const copy = structuredClone(view) as unknown;
  while (!fitsBounds(copy)) {
    let longest: { holder: Record<string, unknown> | unknown[]; key: string | number; value: string } | null = null;
    let biggest: { holder: Record<string, unknown>; key: string; value: unknown[] } | null = null;
    const visit = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => (typeof v === "string" ? consider(node, i, v) : visit(v)));
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (Array.isArray(v) && v.length && (!biggest || json(v).length > json(biggest.value).length)) biggest = { holder: node as Record<string, unknown>, key: k, value: v };
          if (typeof v === "string") consider(node as Record<string, unknown>, k, v);
          else visit(v);
        }
      }
    };
    const consider = (holder: Record<string, unknown> | unknown[], key: string | number, value: string) => {
      if (!longest || value.length > longest.value.length) longest = { holder, key, value };
    };
    visit(copy);
    const text = longest as { holder: Record<string, unknown> | unknown[]; key: string | number; value: string } | null;
    const list = biggest as { holder: Record<string, unknown>; key: string; value: unknown[] } | null;
    if (text && text.value.length > 160) {
      const keep = Math.floor(text.value.length / 2);
      const end = /[\uD800-\uDBFF]/.test(text.value[keep - 1] ?? "") ? keep - 1 : keep;
      (text.holder as Record<string | number, unknown>)[text.key] = `${text.value.slice(0, end)}… [${text.value.length - end} characters omitted]`;
      if (!Array.isArray(text.holder) && "complete" in text.holder) {
        text.holder.complete = false;
        text.holder.omitted = "Content shortened to fit aggregate output bounds.";
      }
    } else if (list) {
      const drop = Math.ceil(list.value.length / 2);
      const removed = list.value.splice(list.value.length - drop, drop);
      const key = `${list.key}_omitted`;
      list.holder[key] = Number(list.holder[key] ?? 0) + drop;
      // Preserve a bounded reference range for omitted tool evidence.
      if (list.key === "tool_activity") {
        const refs = removed.flatMap((v) => v && typeof v === "object" && "ref" in v && typeof v.ref === "string" ? [v.ref] : []);
        if (refs.length) list.holder.tool_activity_omitted_refs = [refs[0], refs.at(-1)];
      }
    } else break;
  }
  if (!fitsBounds(copy)) throw new ToolError("result_too_large", "This record cannot be represented within the output bounds.", "Inspect a more specific turn or evidence reference.");
  return copy as T;
}

export const contextRetrieveTool: ToolHandler<ContextRetrieveInput> = {
  name: "context_retrieve",
  description: [
    "Recall earlier work from Socrates' memory.",
    "ledger_search: goals and tasks by their metadata; returns selectors such as g7 and g7/t4.",
    "search: exact past questions and answers by query and/or dates, in target: current_task (default), current_goal, all_goals, gN, tN (a task of the current goal) or gN/tN; top_n default 5; returns refs such as r1.",
    "inspect: one record by ref (gN, tN, gN/tN, rN, eN: a tool call of this task, gN/tN/eN, hc-N) or turn_number (any [TURN k]).",
    "Dates are YYYY-MM-DD. Output is bounded; omissions name refs to inspect.",
  ].join(" "),
  schema: ContextRetrieveInput,
  concurrency: "parallel",
  mutating: false,
  async execute(input, ctx) {
    const result = enforceBounds(input.action === "ledger_search" ? await ledgerSearch(input, ctx) : input.action === "search" ? await search(input, ctx) : inspect(input, ctx));
    return { content: json(result), result };
  },
};
