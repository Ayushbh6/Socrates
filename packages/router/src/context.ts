import {
  type CurrentBinding,
  type Exchange,
  type Goal,
  type LedgerStore,
  type Task,
  type Turn,
  type Workspace,
  excerpt,
  toFtsQuery,
} from "@socrates/store";
import { type SemanticHit, fuse, recencyBoost } from "@socrates/retrieval";
import { countTokens, truncateToTokens, zonedParts } from "@socrates/shared";
import { laneSummaries, renderLanesForRouter } from "./lanes";

/**
 * Builds everything the Goal Router sees (Goal-router.md, "Exact router input"):
 * CURRENT_TIME, RECENT_ACTIVITY, RECENT_EXACT_HISTORY, KNOWN_GOALS, and the
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
}

export interface BuildContextOptions {
  timeZone: string;
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
}

/** An open goal whose scope matched gets this much, in fused-rank units. */
export const OPEN_GOAL_BOOST = 0.05;

/** What candidate retrieval searches for: the message, plus the pending request it answers. */
export function candidateQuery(store: LedgerStore, message: string, laneId: string | null = null): string {
  const pending = store.pendingClarification(laneId);
  return pending ? `${(store.getEvent(pending.userEventId)!.payload as { text: string }).text} ${message}` : message;
}

export function buildRoutingContext(store: LedgerStore, message: string, options: BuildContextOptions): RoutingContext {
  const now = store.clock.now();
  const laneId = options.laneId ?? null;
  const current = (laneId ? store.currentBinding(laneId) : null) ?? store.currentBinding();
  const pendingTurn = store.pendingClarification(laneId);
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

  selectOlderCandidates(store, candidateQuery(store, message, laneId), now, current?.goal.id ?? null, options.semantic ?? []).forEach((goal, i) => {
    const label = `older_${i + 1}`;
    goals.set(label, {
      label,
      kind: "older",
      goal,
      workspace: goal.workspaceId ? store.getWorkspace(goal.workspaceId) : null,
      tasks: olderGoalTasks(store, goal),
    });
  });

  const exchanges = collectHistory(store, options.historyBudgetTokens ?? ROUTER_HISTORY_BUDGET_TOKENS, goals, laneId ? [null, laneId] : [null]);
  const answeringClarification = pending !== null;
  const zeroHistory = !store.hasAnyActivity();

  const sections = [
    section("CURRENT_TIME", renderTime(now, options.timeZone)),
    section("RECENT_ACTIVITY", renderActivity(store, now, options.timeZone)),
    section("RECENT_EXACT_HISTORY", exchanges.text || "None"),
    section("KNOWN_GOALS", renderKnownGoals(store, goals, current)),
  ];
  // Work running or recently finished in parallel lanes, other than the lane being routed.
  const lanes = laneSummaries(store, now, laneId);
  if (lanes.length) sections.push(section("LANES", renderLanesForRouter(store, lanes, now, options.timeZone)));
  const laneSelectors = {
    goals: lanes.flatMap((l) => (l.goal ? [l.goal.number] : [])),
    tasks: lanes.flatMap((l) => (l.goal && l.task ? [`g${l.goal.number}/t${l.task.number}`] : [])),
  };
  if (answeringClarification) {
    sections.push(
      section(
        "ROUTING_NOTE",
        "Your previous routing turn asked the user a clarification question, shown last in RECENT_EXACT_HISTORY. " +
          "The current message answers it. Route the ORIGINAL request to the selected subject, rather than treating the selection as a new objective. You must return a decision now; ask_user is not available." +
          (pending && (!exchanges.text.includes(pending.request) || !exchanges.text.includes(pending.question))
            ? `\nPending request (bounded excerpt): ${truncateToTokens(pending.request, 400).text}\nPrevious question and candidates: ${pending.question}` : ""),
      ),
    );
  }
  sections.push(section("CURRENT_USER_MESSAGE", message));

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
  };
}

function section(name: string, body: string): string {
  return `<${name}>\n${body}\n</${name}>`;
}

function renderTime(now: Date, timeZone: string): string {
  const p = zonedParts(now, timeZone);
  return `${p.date} ${p.time} (${p.weekday}, ${timeZone})`;
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
export function renderActivity(store: LedgerStore, now: Date, timeZone: string): string {
  const detailSince = new Date(now.getTime() - ACTIVITY_DETAIL_HOURS * 3_600_000).toISOString();
  const weekSince = new Date(now.getTime() - ACTIVITY_DAYS * 86_400_000).toISOString();
  const items = store.tasksUpdatedSince(weekSince);
  if (items.length === 0) return "None";

  const detail = items.filter((i) => i.task.updatedAt >= detailSince);
  const older = items.filter((i) => i.task.updatedAt < detailSince);
  const lines: string[] = [];
  const ws = (w: Workspace | null) => (w?.name ?? "—").padEnd(12);

  if (detail.length) {
    lines.push("Last 48 hours (detail):");
    for (const { task, goal, workspace } of detail) {
      if (lines.length >= ACTIVITY_MAX_LINES) break;
      const p = zonedParts(new Date(task.updatedAt), timeZone);
      const note = task.continuationNote ? ` — ${excerpt(task.continuationNote, 100)}` : "";
      lines.push(`${p.date} ${p.time}  ${ws(workspace)} ${goal.title} · ${task.title} (${task.status})${note}`);
    }
  }
  if (older.length && lines.length < ACTIVITY_MAX_LINES) {
    if (lines.length) lines.push("");
    lines.push("Last 7 days (one line each):");
    for (const { task, goal, workspace } of older) {
      if (lines.length >= ACTIVITY_MAX_LINES + 2) break;
      const p = zonedParts(new Date(task.updatedAt), timeZone);
      lines.push(`${p.date}        ${ws(workspace)} ${goal.title} · ${task.title} (${task.status})`);
    }
  }
  return lines.join("\n");
}

// ── RECENT_EXACT_HISTORY ──────────────────────────────────────────────────

function tagFor(exchange: Exchange, goals: Map<string, GoalEntry>, store: LedgerStore): string {
  if (exchange.kind === "clarification") return "[routing clarification — not bound to any task]";
  const tags = exchange.bindings.map(({ goalId, taskId }) => {
    const entry = [...goals.values()].find((g) => g.goal.id === goalId);
    const goal = entry?.goal ?? store.requireGoal(goalId);
    const goalTag = goal.general ? "general" : (entry?.label ?? `"${goal.title}"`);
    const taskEntry = entry?.tasks.find((t) => t.task.id === taskId);
    const task = taskEntry?.task ?? store.requireTask(taskId);
    const taskTag = goal.general ? "general" : (taskEntry?.label ?? `"${task.title}"`);
    const workspace = goal.workspaceId ? (store.getWorkspace(goal.workspaceId)?.name ?? "—") : "—";
    return `goal=${goalTag} · task=${taskTag} · workspace=${workspace}`;
  });
  return `[${tags.join(" + ")}]`;
}

function renderExchange(tag: string, user: string, response: string): string {
  return `${tag}\nUSER:\n${user}\n\nSOCRATES:\n${response}`;
}

/**
 * Walk backward through the flow's completed exchanges and keep the newest
 * complete pairs that fit the budget, presented oldest to newest. Purely
 * chronological: no semantic or keyword filtering.
 */
function collectHistory(
  store: LedgerStore,
  budget: number,
  goals: Map<string, GoalEntry>,
  lanes: (string | null)[],
): { text: string; newest: Exchange | null } {
  const blocks: string[] = [];
  let used = 0;
  let newest: Exchange | null = null;
  for (const exchange of store.recentExchanges(lanes)) {
    newest ??= exchange;
    const tag = tagFor(exchange, goals, store);
    const block = renderExchange(tag, exchange.userMessage, exchange.response);
    const tokens = countTokens(block);
    if (used + tokens <= budget) {
      blocks.push(block);
      used += tokens;
      continue;
    }
    if (blocks.length === 0) {
      // The newest exchange alone exceeds the budget: include a marked, bounded excerpt.
      const half = Math.floor((budget - countTokens(tag) - 100) / 2);
      const user = truncateToTokens(exchange.userMessage, half);
      const response = truncateToTokens(exchange.response, half);
      blocks.push(
        renderExchange(
          `${tag} [bounded excerpt — the complete exchange remains in storage]`,
          user.text + (user.truncated ? "\n[…truncated]" : ""),
          response.text + (response.truncated ? "\n[…truncated]" : ""),
        ),
      );
    }
    break;
  }
  return { text: blocks.reverse().join("\n\n"), newest };
}

// ── KNOWN_GOALS ───────────────────────────────────────────────────────────

function renderGoalEntry(store: LedgerStore, entry: GoalEntry): string {
  const lines = [`label: ${entry.label}`, `title: ${entry.goal.title}`, `workspace: ${entry.workspace?.name ?? "—"}`];
  if (entry.goal.general) lines.push("kind: the general conversation goal");
  if (entry.goal.objective) lines.push(`objective: ${excerpt(entry.goal.objective, 300)}`);
  if (entry.goal.note) lines.push(`note: ${excerpt(entry.goal.note, 300)}`);
  const anchors = store.listAnchors(entry.goal.id);
  if (anchors.length) {
    lines.push("anchors:");
    for (const a of anchors.slice(0, 5)) lines.push(`- ${a.path} — ${excerpt(a.summary, 100)}`);
  }
  if (entry.tasks.length) {
    lines.push("tasks:");
    for (const { label, task } of entry.tasks) {
      const note = task.continuationNote ? `; ${excerpt(task.continuationNote, 140)}` : "";
      lines.push(`- ${label}: ${task.title} — ${task.status}${note}`);
    }
  }
  return lines.join("\n");
}

function renderKnownGoals(store: LedgerStore, goals: Map<string, GoalEntry>, current: CurrentBinding | null): string {
  const blocks: string[] = [];
  const cur = goals.get("current");
  blocks.push(cur ? `CURRENT\n${renderGoalEntry(store, cur)}` : "CURRENT\nNone");
  const older = [...goals.values()].filter((g) => g.kind === "older");
  if (older.length) blocks.push(`OLDER\n${older.map((g) => renderGoalEntry(store, g)).join("\n\n")}`);
  if (!current?.goal.general) {
    blocks.push(
      "GENERAL\nlabel: general\ntitle: General conversation — greetings, small talk, and unrelated quick questions with no task anchor",
    );
  }
  return blocks.join("\n\n");
}
