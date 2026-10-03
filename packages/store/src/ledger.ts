import type { LedgerQueryInput } from "@socrates/contracts";
import { LEDGER_QUERY_DEFAULT_LIMIT } from "@socrates/contracts";
import { zonedParts } from "@socrates/shared";
import type { Goal, LedgerStore, Task, TaskWithGoal } from "./store";

/** Permanent human-facing selectors (agent-harness.md, "context_retrieve"). */
export const goalSelector = (goal: Pick<Goal, "number">): string => `g${goal.number}`;
export const taskSelector = (goal: Pick<Goal, "number">, task: Pick<Task, "number">): string => `g${goal.number}/t${task.number}`;

export function parseGoalSelector(value: string): number | null {
  const m = /^g(\d+)$/i.exec(value.trim());
  return m ? Number(m[1]) : null;
}

export function parseTaskSelector(value: string): { goal: number; task: number } | null {
  const m = /^g(\d+)\/t(\d+)$/i.exec(value.trim());
  return m ? { goal: Number(m[1]), task: Number(m[2]) } : null;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does doing for from had has have hey hi how i if in into is it its " +
    "just let lets let's me my of on or our please so that the their them then there these this those to up us was we were " +
    "what when where which who why will with would you your yes no ok okay now again also go get got make want need some any " +
    "about thing things one today yesterday tomorrow"
  ).split(" "),
);

/**
 * Turn free text into a safe FTS5 OR-expression of its significant words.
 * Each term is quoted, so user text can never inject FTS syntax.
 */
export function toFtsQuery(text: string, maxTerms = 24): string {
  return significantTerms(text, maxTerms).map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/** The distinct significant words of free text, lowercased, stopwords removed. */
export function significantTerms(text: string, maxTerms = 24): string[] {
  const terms: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []) {
    const term = raw.replace(/^[-_]+|[-_]+$/g, "");
    if (term.length < 2 || STOPWORDS.has(term) || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  return terms;
}

/** A ledger row as the router and the working agent see it. Metadata only, never message bodies. */
export interface LedgerRow {
  date: string;
  workspace: string | null;
  goalSelector: string;
  goalTitle: string;
  taskSelector: string;
  taskTitle: string;
  objective: string;
  status: string;
  note: string | null;
}

export function toLedgerRow(item: TaskWithGoal, timeZone: string): LedgerRow {
  return {
    date: zonedParts(new Date(item.task.updatedAt), timeZone).date,
    workspace: item.workspace?.name ?? null,
    goalSelector: goalSelector(item.goal),
    goalTitle: item.goal.title,
    taskSelector: taskSelector(item.goal, item.task),
    taskTitle: item.task.title,
    objective: item.task.objective,
    status: item.task.status,
    note: item.task.continuationNote,
  };
}

export function excerpt(text: string | null, max = 120): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** One line, in the same shape as the router's activity notepad. */
export function renderLedgerRow(row: LedgerRow): string {
  const ws = (row.workspace ?? "—").padEnd(12);
  const note = row.note ? ` — ${excerpt(row.note)}` : "";
  return `${row.date}  ${ws} ${row.goalSelector} ${row.goalTitle} · ${row.taskSelector} ${row.taskTitle} — ${row.status}${note}`;
}

export class LedgerQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly correction: string,
  ) {
    super(message);
    this.name = "LedgerQueryError";
  }
}

/**
 * Execute the router's structured `ledger_query` filter form. Never freeform
 * SQL: every filter maps to a fixed, parameterized predicate.
 */
export function runLedgerQuery(store: LedgerStore, input: LedgerQueryInput, timeZone: string): LedgerRow[] {
  const limit = input.limit ?? LEDGER_QUERY_DEFAULT_LIMIT;
  if (input.from && input.to && input.from > input.to) {
    throw new LedgerQueryError("invalid_range", `from (${input.from}) is after to (${input.to}).`, "Swap the dates or widen the range.");
  }

  let items: Iterable<TaskWithGoal>;
  if (input.match) {
    const fts = toFtsQuery(input.match);
    if (!fts) {
      throw new LedgerQueryError("empty_match", "match contains no searchable words.", "Use distinctive words such as a project or feature name.");
    }
    // Page internally until the scoped result limit is satisfied. A dense
    // unrelated workspace must never hide an older or lower-scored match.
    items = (function* () {
      const seen = new Set<string>();
      for (let offset = 0; ; offset += 200) {
        const hits = store.searchLedger(fts, 200, offset);
        for (const hit of hits) {
          const ids = hit.entity === "task" ? [hit.entityId] : store.listTasks(hit.goalId).map(t => t.id);
          for (const id of ids) {
            if (seen.has(id)) continue;
            seen.add(id);
            yield store.taskWithGoal(id);
          }
        }
        if (hits.length < 200) break;
      }
    })();
  } else {
    items = store.allTasks();
  }

  const goalFilter = input.goal?.trim();
  const goalNumber = goalFilter ? parseGoalSelector(goalFilter) : null;
  const taskFilter = input.task?.trim();
  const taskSel = taskFilter ? parseTaskSelector(taskFilter) : null;
  const status = input.status ?? "any";

  const rows: LedgerRow[] = [];
  for (const item of items) {
    const row = toLedgerRow(item, timeZone);
    if (input.from && row.date < input.from) continue;
    if (input.to && row.date > input.to) continue;
    if (status !== "any" && item.task.status !== status) continue;
    if (input.workspace && (item.workspace?.name.toLowerCase() ?? "") !== input.workspace.toLowerCase()) continue;
    if (goalFilter) {
      if (goalNumber !== null ? item.goal.number !== goalNumber : !item.goal.title.toLowerCase().includes(goalFilter.toLowerCase())) {
        continue;
      }
    }
    if (taskFilter) {
      if (taskSel) {
        if (item.goal.number !== taskSel.goal || item.task.number !== taskSel.task) continue;
      } else if (!item.task.title.toLowerCase().includes(taskFilter.toLowerCase())) continue;
    }
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}
