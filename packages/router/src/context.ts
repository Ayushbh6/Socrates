import {
  type CurrentBinding,
  type Exchange,
  type Goal,
  type LedgerStore,
  type Task,
  type Turn,
  type Workspace,
  excerpt,
  quoteEvidence, contextSection, contextTime, currentRequest, selectContextHistory, foregroundTurns,
  toFtsQuery,
} from "@socrates/store";
import { type SemanticHit, fuse, recencyBoost } from "@socrates/retrieval";
import { countTokens, truncateToTokens, eventTime, zonedParts } from "@socrates/shared";
import { laneSummaries } from "./lanes";

/**
 * Builds everything the Goal Router sees (Goal-router.md, "Exact router input"):
 * RECENT_CONVERSATION, GOAL_DIRECTORY, optional evidence, CURRENT_TIME, and the
 * current user message as the final block. Also returns the label table the
 * validator uses to resolve the router's answer back to real goals and tasks.
 */

export const ROUTER_HISTORY_BUDGET_TOKENS = 20_000;
export const MAX_OLDER_CANDIDATES = 3;
const MAX_CURRENT_TASKS_LISTED = 6;
const MAX_OLDER_TASKS_LISTED = 3;
const ACTIVITY_DETAIL_HOURS = 48;
const ACTIVITY_DAYS = 7;
const ACTIVITY_MAX_LINES = 15;

export interface TaskEntry {
  label: string;
  task: Task;
}

export interface GoalEntry {
  label: string;
  kind: "current" | "older";
  goal: Goal;
  workspace: Workspace | null;
  tasks: TaskEntry[];
}

export interface RoutingContext {
  now: Date;
  timeZone: string;
  message: string;
  current: CurrentBinding | null;
  /** Goal entries by label: "current" and "older_N". */
  goals: Map<string, GoalEntry>;
  /** True when the ledger holds no activity at all; permits the zero-history clarify. */
  zeroHistory: boolean;
  /** True when the previous exchange was a routing clarification this message answers. */
  answeringClarification: boolean;
  pending: { turn: Turn; request: string; question: string } | null;
  /** Goal and task selectors shown in LANES, usable as labels without a ledger query. */
  laneSelectors: { goals: number[]; tasks: string[] };
  /** The rendered turn-specific router input. */
  input: string;
  diagnostics: { historyBudget: number; historyUsed: number; includedTurns: number[]; omitted: number; asOf: string };
}

export interface BuildContextOptions {
  defaultFolder?: string;
  requestId?: string;
  timeZone: string;
  /** Explicit question being answered; null means a fresh request. Undefined supports older harness clients. */
  clarificationTurnId?: string | null;
  /** Names of the images attached to the current message. */
  attachments?: string[];
  historyBudgetTokens?: number;
  /** Meaning matches of goals and tasks for candidateQuery(), from the semantic index. */
  semantic?: SemanticHit[];
  /**
   * The lane the message was sent to. A lane answers its own clarifications
   * and continues its own task; until it has one, "current" is the main
   * conversation's, where the lane was started. History shows the main
   * conversation and this lane.
   */
  laneId?: string | null;
  /** Host snapshot: active lanes mapped to their executing turn, or null while routing/queued. */
  laneActivity?: ReadonlyMap<string, string | null>;
  /** Saved memories that may bear on the message, one per line, or null (Goal-router.md, "REMEMBERED"). */
  remembered?: string | null;
}

/** An open goal whose scope matched gets this much, in fused-rank units. */
export const OPEN_GOAL_BOOST = 0.05;

/** What candidate retrieval searches for: the message, plus the pending request it answers. */
export function candidateQuery(store: LedgerStore, message: string, laneId: string | null = null, clarificationTurnId?: string | null): string {
  const pending = clarificationTurnId === undefined ? store.pendingClarification(laneId) : clarificationTurnId ? store.requireTurn(clarificationTurnId) : null;
  return pending ? `${(store.getEvent(pending.userEventId)!.payload as { text: string }).text} ${message}` : message;
}

export function buildRoutingContext(store: LedgerStore, message: string, options: BuildContextOptions): RoutingContext {
  const now = store.clock.now();
  const laneId = options.laneId ?? null;
  const current = (laneId ? store.currentBinding(laneId) : null) ?? store.currentBinding();
  const pendingTurn = options.clarificationTurnId === undefined ? store.pendingClarification(laneId) : options.clarificationTurnId ? store.requireTurn(options.clarificationTurnId) : null;
  const pending = pendingTurn ? {
    turn: pendingTurn,
    request: (store.getEvent(pendingTurn.userEventId)!.payload as { text: string }).text,
    question: (store.getEvent(pendingTurn.responseEventId!)!.payload as { text: string }).text,
  } : null;
  const goals = new Map<string, GoalEntry>();

  if (current) {
    goals.set("current", {
      label: "current",
      kind: "current",
      goal: current.goal,
      workspace: current.goal.workspaceId ? store.getWorkspace(current.goal.workspaceId) : null,
      tasks: currentGoalTasks(store, current),
    });
  }

  selectOlderCandidates(store, candidateQuery(store, message, laneId, options.clarificationTurnId), now, current?.goal.id ?? null, options.semantic ?? []).forEach((goal, i) => {
    const label = `older_${i + 1}`;
    goals.set(label, {
      label,
      kind: "older",
      goal,
      workspace: goal.workspaceId ? store.getWorkspace(goal.workspaceId) : null,
      tasks: olderGoalTasks(store, goal),
    });
  });

  const root = options.requestId ? store.requestRoot(pending?.turn.userEventId ?? options.requestId) : null;
  const exchanges = selectContextHistory(store, foregroundTurns(store, laneId ? [null, laneId] : [null]), {
    budget: options.historyBudgetTokens ?? ROUTER_HISTORY_BUDGET_TOKENS, previousBudget: 10_000,
    timeZone: options.timeZone, excludeRequest: root?.id, asOf: now.toISOString(),
  });
  const answeringClarification = pending !== null;
  const zeroHistory = !store.hasAnyActivity();
  const sections = [
    contextSection("RECENT_CONVERSATION", exchanges.text || "none"),
    contextSection("HISTORY_COVERAGE", `selection: newest_eligible_exchanges\npresentation_order: oldest_to_newest\nbudget_tokens: ${exchanges.budget}\nincluded_tokens: ${exchanges.used}\nolder_history_omitted: ${exchanges.omitted > 0}`),
    contextSection("CURRENT_BINDING", `goal_ref: ${current ? `g${current.goal.number}` : "none"}\ntask_ref: ${current ? `g${current.goal.number}/t${current.task.number}` : "none"}`),
    contextSection("GOAL_DIRECTORY", `as_of: ${contextTime(now, options.timeZone)}\ncoverage: current goal and at most ${MAX_OLDER_CANDIDATES} older candidates; omitted work available through ledger_query\n\n${renderKnownGoals(store, goals, current)}`),
  ];
  if (options.remembered) sections.push(contextSection("RECALLED_MEMORIES", options.remembered));
  const lanes = laneSummaries(store, now, laneId, options.laneActivity);
  if (lanes.length) sections.push(contextSection("ACTIVE_LANES", lanes.map(l => `## LANE\nlane_ref: ${l.lane.id}\nlane_number: ${l.lane.number}\ngoal_ref: ${l.goal ? `g${l.goal.number}` : "none"}\ntask_ref: ${l.goal && l.task ? `g${l.goal.number}/t${l.task.number}` : "none"}\nstatus: ${l.status}\nsummary:\n${quoteEvidence(excerpt(l.latestStep ?? l.task?.continuationNote ?? "none", 300))}`).join("\n\n")));
  const laneSelectors = {
    goals: lanes.flatMap(l => l.goal ? [l.goal.number] : []),
    tasks: lanes.flatMap(l => l.goal && l.task ? [`g${l.goal.number}/t${l.task.number}`] : []),
  };
  sections.push(contextSection("WORKSPACE_CONTEXT", `default_working_folder: ${JSON.stringify(options.defaultFolder ?? "none")}\nselection_basis: configured working-folder resolver; existing projects keep their folder. Access permissions still apply.`));
  if (pending) sections.push(contextSection("ROUTING_CLARIFICATION", `original_request_ref: ${root?.id ?? pending.turn.userEventId}\nquestion:\n${quoteEvidence(pending.question)}\nreply:\n${quoteEvidence(message)}\nRoute the original request now. ask_user is unavailable.`));
  sections.push(contextSection("CURRENT_TIME", `at: ${contextTime(now, options.timeZone)}\ntimezone: ${options.timeZone}`));
  sections.push(currentRequest({ id: root?.id ?? "unknown", at: root?.at ?? now.toISOString(), text: pending?.request ?? message,
    attachments: options.attachments?.map(name => ({ name })) }, options.timeZone));

  return {
    now,
    timeZone: options.timeZone,
    message,
    current,
    goals,
    zeroHistory,
    answeringClarification,
    pending,
    laneSelectors,
    input: sections.join("\n\n"),
    diagnostics: { historyBudget: exchanges.budget, historyUsed: exchanges.used, includedTurns: exchanges.turns.map(t => t.projectTurn), omitted: exchanges.omitted, asOf: now.toISOString() },
  };
}

// ── Task labels ───────────────────────────────────────────────────────────

/** Current goal: its current task is `current`; other open, then completed, tasks are `task_N`. */
function currentGoalTasks(store: LedgerStore, current: CurrentBinding): TaskEntry[] {
  const others = store.listTasks(current.goal.id).filter((t) => t.id !== current.task.id);
  const ordered = [...others.filter((t) => t.status === "open"), ...others.filter((t) => t.status !== "open")];
  return [
    { label: "current", task: current.task },
    ...ordered.slice(0, MAX_CURRENT_TASKS_LISTED).map((task, i) => ({ label: `task_${i + 1}`, task })),
  ];
}

/** Older goal: its most recently updated task is `latest`; up to two other open tasks are `task_N`. */
function olderGoalTasks(store: LedgerStore, goal: Goal): TaskEntry[] {
  const [latest, ...rest] = store.listTasks(goal.id);
  if (!latest) return [];
  const open = rest.filter((t) => t.status === "open").slice(0, MAX_OLDER_TASKS_LISTED - 1);
  return [{ label: "latest", task: latest }, ...open.map((task, i) => ({ label: `task_${i + 1}`, task }))];
}

// ── Candidate retrieval ───────────────────────────────────────────────────

/**
 * Hybrid candidate retrieval over goal titles, goal notes, task metadata, and
 * anchors: the keyword (BM25) ranking and the meaning ranking of goals are
 * fused, with a small recency boost and a small boost for open goals that
 * matched. Remaining slots are filled with goals active in the last week, so
 * vague temporal references still see them. Retrieval only builds a
 * shortlist; the router decides.
 */
export function selectOlderCandidates(store: LedgerStore, message: string, now: Date, currentGoalId: string | null, semantic: SemanticHit[] = []): Goal[] {
  const eligible = (goal: Goal | null): goal is Goal => !!goal && !goal.general && goal.id !== currentGoalId;

  const lexical = new Map<string, number>();
  const fts = toFtsQuery(message);
  if (fts) {
    for (const hit of store.searchLedger(fts, 200)) {
      const score = -hit.bm25;
      if (score > (lexical.get(hit.goalId) ?? 0)) lexical.set(hit.goalId, score);
    }
  }
  const goals = (ids: string[]) => [...new Set(ids)].map((id) => store.getGoal(id)).filter(eligible);
  const byKeywords = goals([...lexical].sort((a, b) => b[1] - a[1]).map(([id]) => id));
  // Hits arrive best first; a goal ranks by its own best match or its best task's.
  const byMeaning = goals(semantic.flatMap((h) => (h.goalId ? [h.goalId] : [])));
  const open = (goal: Goal) => (store.listTasks(goal.id, { status: "open" }).length > 0 || goal.status === "open" ? OPEN_GOAL_BOOST : 0);
  const picked = fuse([byKeywords, byMeaning], (g) => g.id, (g) => recencyBoost(g.updatedAt, now) + open(g))
    .slice(0, MAX_OLDER_CANDIDATES)
    .map((s) => s.item);

  if (picked.length < MAX_OLDER_CANDIDATES) {
    const since = new Date(now.getTime() - ACTIVITY_DAYS * 86_400_000).toISOString();
    for (const { goal } of store.tasksUpdatedSince(since)) {
      if (picked.length >= MAX_OLDER_CANDIDATES) break;
      if (eligible(goal) && !picked.some((g) => g.id === goal.id)) picked.push(goal);
    }
  }
  return picked;
}

// ── RECENT_ACTIVITY ───────────────────────────────────────────────────────

/** A derived view of the ledger, rendered fresh on every request; never stored prose. */
export function renderActivity(store: LedgerStore, now: Date, timeZone: string, excludeUserEventId?: string): string {
  const boundary = now.toISOString();
  const since = new Date(now.getTime() - ACTIVITY_DAYS * 86_400_000).toISOString();
  const redone = store.redoneTurnIds();
  const rows = store.listGoals().flatMap(goal => store.listTasks(goal.id).flatMap(task =>
    store.turnsForTask(task.id).filter(t => t.status !== "in_progress" && t.userEventId !== excludeUserEventId && !redone.has(t.id) && (t.completedAt ?? t.createdAt) >= since && (t.completedAt ?? t.createdAt) <= boundary).map(turn => ({ goal, task, turn }))
  )).sort((a, b) => (b.turn.completedAt ?? b.turn.createdAt).localeCompare(a.turn.completedAt ?? a.turn.createdAt)).slice(0, ACTIVITY_MAX_LINES);
  const lines = [`As of ${boundary} (${timeZone}). Chat status is not outstanding work; completed turns do not imply every command succeeded. Exact answers and tool results override summaries.`];
  for (const { goal, task, turn } of rows) {
    const requestAt = store.requestRoot(turn.userEventId).at;
    const warnings = store.listEvents({ turnId: turn.id, type: "agent_warning" }).map(e => e.payload as import("@socrates/contracts").EventPayloads["agent_warning"]);
    const calls = store.evidenceForTurn(turn.id);
    const failed = calls.filter(e => e.status === "error" || ((e.result?.result as { exit_code?: number } | undefined)?.exit_code ?? 0) !== 0).length;
    const note = store.noteState(task.id);
    const invalid = warnings.some(w => w.kind === "final_answer_invalid");
    lines.push(`\n## ITEM\ngoal_ref: g${goal.number}\ntask_ref: g${goal.number}/t${task.number}\nlane_ref: ${turn.laneId ?? "none"}\nstatus: ${task.status}\nsource_refs: turn_number ${turn.projectTurn}\nsummary:`);
    lines.push(`g${goal.number}/t${task.number} turn_number ${turn.projectTurn} | ${goal.title} · ${task.title} | requested ${eventTime(requestAt, timeZone)}; completed ${turn.completedAt ? eventTime(turn.completedAt, timeZone) : "unknown"}; task updated ${task.updatedAt} | chat/task ${task.status}; execution ${turn.status}; tool calls ${calls.length}, failed commands/calls ${failed}; answer validation ${invalid ? "invalid metadata" : "no recorded validation failure"}; note ${note.freshness} (source ${note.sourceTurn ?? "unknown"}).`);
    // Summaries are explicitly task-current, not falsely attributed to every historical turn.
    if (task.continuationNote) lines.push(`Task summary (may cover later turns; ${note.freshness}): ${excerpt(task.continuationNote, 360)}${task.continuationNote.length > 360 ? " [excerpt; context_retrieve inspect task for full note]" : ""}`);
  }
  return lines.join("\n");
}

function renderGoalEntry(store: LedgerStore, entry: GoalEntry): string {
  const goal = entry.goal;
  const note = store.goalNoteState(goal.id);
  const lines = ["## GOAL", `goal_ref: g${goal.number}`, `route_label: ${entry.label}`, `title: ${JSON.stringify(goal.title)}`,
    `objective: ${JSON.stringify(excerpt(goal.objective ?? "", 300))}`, `workspace_ref: ${goal.workspaceId ?? "none"}`,
    `workspace_name: ${JSON.stringify(entry.workspace?.name ?? "none")}`, `status: ${goal.status}${store.listEvents({goalId: goal.id, type: "goal_status_set"}).length > 0 ? " (set by the user)" : ""}`,
    `anchor_refs: ${JSON.stringify(store.listAnchors(goal.id).slice(0, 8).map(a => ({path: a.path, role: a.role, summary: excerpt(a.summary ?? "", 200)})))}`,
    `\n### GOAL_NOTE\ntext:\n${quoteEvidence(excerpt(goal.note ?? "none", 300))}\nsource_turn_ref: ${note.sourceTurn ?? "unknown"}\nfreshness: ${note.freshness}`];
  for (const { label, task } of entry.tasks) {
    const n = store.noteState(task.id);
    lines.push(`\n### TASK\ntask_ref: g${goal.number}/t${task.number}\nroute_label: ${label}\ntitle: ${JSON.stringify(task.title)}\nobjective: ${JSON.stringify(excerpt(task.objective, 300))}\ncompletion_criteria: ${JSON.stringify(excerpt(task.completionCriteria ?? "none", 300))}\nstatus: ${task.status}${store.statusSource(task.id)?.by === "user" ? " (set by the user)" : ""}\n\n#### CONTINUATION_NOTE\ntext:\n${quoteEvidence(excerpt(task.continuationNote ?? "none", 300))}\nsource_turn_ref: ${n.sourceTurn ?? "unknown"}\nfreshness: ${n.freshness}`);
  }
  return lines.join("\n");
}
function renderKnownGoals(store: LedgerStore, goals: Map<string, GoalEntry>, current: CurrentBinding | null): string {
  const blocks = [...goals.values()].map(entry => renderGoalEntry(store, entry));
  if (!current?.goal.general) blocks.push("## GOAL\ngoal_ref: general\nroute_label: general\ntitle: General conversation\nobjective: Greetings, small talk and quick questions without a task anchor. Task fields must be null; the harness chooses the day.");
  return blocks.join("\n\n");
}
