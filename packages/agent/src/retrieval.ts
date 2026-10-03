import { type SemanticHit, fuse, recencyBoost } from "@socrates/retrieval";
import { countTokens, zonedParts } from "@socrates/shared";
import { type ExchangeHit, type LedgerStore, toFtsQuery } from "@socrates/store";
import { head } from "@socrates/tools";

/** At most this many exchanges of the current task are retrieved for one request. */
export const RETRIEVED_MAX_EXCHANGES = 3;
/** At most this many exchanges of other tasks in the same goal, on a strong meaning match only. */
export const RETRIEVED_MAX_SIBLING_EXCHANGES = 1;
/** Keyword candidates of the current task considered before fusion. */
const LEXICAL_CANDIDATES = 10;

export interface RetrievedHistoryInput {
  taskId: string;
  message: string;
  /** The newest turn no longer shown in chat history; only turns at or before it qualify. */
  boundary: number;
  maxTokens: number;
  /** Meaning matches among the current task's exchanges and tool calls, at the related floor. */
  semantic?: SemanticHit[];
  /** Meaning matches among other tasks of the same goal, already at the strong floor. */
  siblings?: SemanticHit[];
  /** Turns never to retrieve, such as the other parts of the current message. */
  excludeTurnIds?: Set<string>;
  now?: Date;
  timeZone?: string;
}

/**
 * `<RETRIEVED_HISTORY>` (Goal-router.md, "RETRIEVED_HISTORY"): exact older
 * exchanges of the current task that chat history no longer shows, ranked by
 * the fused keyword and meaning rankings with a small recency boost, plus at
 * most one exchange of another task in the same goal when its meaning
 * matches strongly. Items are shown oldest first with their dates, so when
 * two disagree the later one is recognisable as current. Returns null when
 * nothing matches.
 */
export function retrievedHistory(store: LedgerStore, input: RetrievedHistoryInput): string | null {
  const now = input.now ?? store.clock.now();
  const exclude = input.excludeTurnIds ?? new Set<string>();
  const exchange = (turnId: string | null) => (turnId && !exclude.has(turnId) ? store.exchangeForTurn(turnId) : null);

  const own: ExchangeHit[] = [];
  if (input.boundary > 0) {
    const fts = toFtsQuery(input.message);
    const lexical = fts ? store.searchExchanges({ fts, taskIds: [input.taskId], throughTurn: input.boundary, limit: LEXICAL_CANDIDATES }).filter((h) => !exclude.has(h.turnId)) : [];
    const meaning = [...new Set((input.semantic ?? []).filter((h) => h.taskId === input.taskId && (h.projectTurn ?? Infinity) <= input.boundary).map((h) => h.turnId))]
      .map(exchange)
      .filter((h): h is ExchangeHit => !!h);
    own.push(...fuse([lexical, meaning], (h) => h.turnId, (h) => recencyBoost(h.at, now)).slice(0, RETRIEVED_MAX_EXCHANGES).map((f) => f.item));
  }
  const siblings = [...new Set((input.siblings ?? []).filter((h) => h.taskId !== input.taskId).map((h) => h.turnId))]
    .map(exchange)
    .filter((h): h is ExchangeHit => !!h)
    .slice(0, RETRIEVED_MAX_SIBLING_EXCHANGES);

  const picked = [...own, ...siblings].sort((a, b) => a.projectTurn - b.projectTurn);
  if (!picked.length) return null;
  const blocks: string[] = [];
  let used = countTokens("<RETRIEVED_HISTORY>\n</RETRIEVED_HISTORY>");
  const each = Math.floor(input.maxTokens / picked.length);
  for (const hit of picked) {
    const date = zonedParts(new Date(hit.at), input.timeZone ?? "UTC").date;
    const label = hit.taskId === input.taskId ? `[TURN ${hit.projectTurn} — ${date}] (retrieved)` : `[TURN ${hit.projectTurn} — ${date}] (retrieved from ${taskLabel(store, hit.taskId)})`;
    const hint = `context_retrieve inspect turn_number ${hit.projectTurn} returns the complete exchange`;
    const text = head(`${label}\nUSER:\n${hit.userMessage}\n\nSOCRATES:\n${hit.response}`, each - 60, hint).text;
    const cost = countTokens(text) + 2;
    if (used + cost > input.maxTokens) continue;
    blocks.push(text);
    used += cost;
  }
  return blocks.length ? `<RETRIEVED_HISTORY>\n${blocks.join("\n\n")}\n</RETRIEVED_HISTORY>` : null;
}

function taskLabel(store: LedgerStore, taskId: string): string {
  const task = store.requireTask(taskId);
  return `task g${store.requireGoal(task.goalId).number}/t${task.number} ${JSON.stringify(task.title)}`;
}
