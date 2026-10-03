import { countTokens } from "@socrates/shared";
import { type LedgerStore, toFtsQuery } from "@socrates/store";
import { head } from "@socrates/tools";

/** At most this many exchanges are retrieved for one request. */
export const RETRIEVED_MAX_EXCHANGES = 3;

/**
 * `<RETRIEVED_HISTORY>` (Goal-router.md, "RETRIEVED_HISTORY"): exact older
 * exchanges of the current task that are no longer in chat history — covered
 * by a checkpoint or capsule, or omitted — ranked by BM25 against the current
 * message. Other tasks' entries wait for the embeddings segment. Returns null
 * when nothing older matches.
 */
export function retrievedHistory(store: LedgerStore, input: { taskId: string; message: string; boundary: number; maxTokens: number }): string | null {
  if (input.boundary <= 0) return null;
  const fts = toFtsQuery(input.message);
  if (!fts) return null;
  const hits = store.searchExchanges({ fts, taskIds: [input.taskId], limit: 20 }).filter((h) => h.projectTurn <= input.boundary);
  const blocks: string[] = [];
  let used = countTokens("<RETRIEVED_HISTORY>\n</RETRIEVED_HISTORY>");
  const each = Math.floor(input.maxTokens / RETRIEVED_MAX_EXCHANGES);
  for (const hit of hits.slice(0, RETRIEVED_MAX_EXCHANGES)) {
    const hint = `context_retrieve inspect turn_number ${hit.projectTurn} returns the complete exchange`;
    const text = head(`[TURN ${hit.projectTurn}] (retrieved)\nUSER:\n${hit.userMessage}\n\nSOCRATES:\n${hit.response}`, each - 60, hint).text;
    const cost = countTokens(text) + 2;
    if (used + cost > input.maxTokens) break;
    blocks.push(text);
    used += cost;
  }
  return blocks.length ? `<RETRIEVED_HISTORY>\n${blocks.join("\n\n")}\n</RETRIEVED_HISTORY>` : null;
}
