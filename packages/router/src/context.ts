import {
  type CurrentBinding,
  type Exchange,
  type Goal,
  type LedgerStore,
  type Task,
  type Workspace,
  excerpt,
  toFtsQuery,
} from "@socrates/store";
import { countTokens, truncateToTokens, zonedParts } from "@socrates/shared";

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
  /** The rendered turn-specific router input. */
  input: string;
}

export interface BuildContextOptions {
  timeZone: string;
  historyBudgetTokens?: number;
}

export function buildRoutingContext(store: LedgerStore, message: string, options: BuildContextOptions): RoutingContext {
  const now = store.clock.now();
  const current = store.currentBinding();
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

  selectOlderCandidates(store, message, now, current?.goal.id ?? null).forEach((goal, i) => {
    const label = `older_${i + 1}`;
    goals.set(label, {
      label,
      kind: "older",
      goal,
      workspace: goal.workspaceId ? store.getWorkspace(goal.workspaceId) : null,
      tasks: olderGoalTasks(store, goal),
    });
  });

  const exchanges = collectHistory(store, options.historyBudgetTokens ?? ROUTER_HISTORY_BUDGET_TOKENS, goals);
  const answeringClarification = exchanges.newest?.kind === "clarification";
  const zeroHistory = !store.hasAnyActivity();

  const sections = [
    section("CURRENT_TIME", renderTime(now, options.timeZone)),
    section("RECENT_ACTIVITY", renderActivity(store, now, options.timeZone)),
    section("RECENT_EXACT_HISTORY", exchanges.text || "None"),
    section("KNOWN_GOALS", renderKnownGoals(store, goals, current)),
  ];
  if (answeringClarification) {
    sections.push(
      section(
        "ROUTING_NOTE",
        "Your previous routing turn asked the user a clarification question, shown last in RECENT_EXACT_HISTORY. " +
          "The current message answers it. You must return a decision now; ask_user is not available.",
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
 * anchors: keyword relevance (BM25) plus a small recency boost and a small
 * boost for open goals that matched. Remaining slots are filled with goals
 * active in the last week, so vague temporal references still see them.
 * Retrieval only builds a shortlist; the router decides.
 */
export function selectOlderCandidates(store: LedgerStore, message: string, now: Date, currentGoalId: string | null): Goal[] {
  const eligible = (goal: Goal | null): goal is Goal => !!goal && !goal.general && goal.id !== currentGoalId;

  const lexical = new Map<string, number>();
  const fts = toFtsQuery(message);
  if (fts) {
    for (const hit of store.searchLedger(fts, 200)) {
      const score = -hit.bm25;
      if (score > (lexical.get(hit.goalId) ?? 0)) lexical.set(hit.goalId, score);
    }
  }
  const best = Math.max(0, ...lexical.values());

  const scored: { goal: Goal; score: number }[] = [];
  for (const [goalId, raw] of lexical) {
    const goal = store.getGoal(goalId);
    if (!eligible(goal)) continue;
    const ageDays = (now.getTime() - new Date(goal.updatedAt).getTime()) / 86_400_000;
    const recency = 0.15 * Math.exp(-Math.max(0, ageDays) / 14);
    const open = store.listTasks(goal.id, { status: "open" }).length > 0 || goal.status === "open" ? 0.1 : 0;
    scored.push({ goal, score: (best > 0 ? raw / best : 0) + recency + open });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, MAX_OLDER_CANDIDATES).map((s) => s.goal);

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
): { text: string; newest: Exchange | null } {
  const blocks: string[] = [];
  let used = 0;
  let newest: Exchange | null = null;
  for (const exchange of store.recentExchanges()) {
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
