import { type LedgerStore, type Memory, significantTerms, toFtsQuery } from "@socrates/store";
import { fuse, recencyBoost } from "./fuse";
import type { SemanticHit } from "./retrieval";

/** Keyword matches considered before ranking. */
const KEYWORD_CANDIDATES = 20;
/**
 * A meaning match this close, with one shared word, qualifies an entry offered
 * unasked. Measured with `pnpm eval:memory` (embeddinggemma): right entries
 * that needed it scored 0.34; wrong ones that a shared common word ("next",
 * "due") let in at the related floor scored 0.23–0.27.
 */
export const MEMORY_WEAK_FLOOR = 0.3;

export interface RankedMemory {
  memory: Memory;
  /** Cosine similarity of its meaning match, or null when only its words matched. */
  similarity: number | null;
  /** Significant words it shares with the query, after a light stemming. */
  shared: number;
}

/**
 * Memories that bear on a query (agent-harness.md, "Memory"): keyword
 * matches (BM25 over the memory's words) and meaning matches (`semantic`,
 * memory hits already at the "related" floor) fused into one ranking with a
 * small recency boost. Only entries that apply in `goalId` (everywhere, or
 * that goal; every goal's when it is undefined) and are not in `exclude`.
 *
 * `strict` is for offering entries unasked (`<MEMORY_CANDIDATES>`): an entry
 * qualifies on a strong enough meaning match (`meaningFloor`), on a weaker one
 * (`weakFloor`) that shares a word, or on two shared words; one common word
 * alone is not enough. Without it (the agent searching on purpose) any match
 * counts.
 */
export function rankMemories(store: LedgerStore, input: { query: string; goalId: string | null | undefined; semantic: SemanticHit[]; exclude?: Set<string>; strict: boolean; meaningFloor: number; weakFloor?: number; limit: number; now: Date }): RankedMemory[] {
  const usable = (m: Memory | null): m is Memory => !!m && !m.forgottenAt && (input.goalId === undefined || !m.goalId || m.goalId === input.goalId) && !input.exclude?.has(m.id);
  const fts = toFtsQuery(input.query);
  const lexical = fts ? store.searchMemories(fts, { goalId: input.goalId, limit: KEYWORD_CANDIDATES }).filter(usable) : [];
  const similarity = new Map<string, number>();
  for (const hit of input.semantic) if (hit.kind === "memory") similarity.set(hit.sourceId, Math.max(similarity.get(hit.sourceId) ?? 0, hit.similarity));
  const meaning = [...similarity.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => store.getMemory(id)).filter(usable);
  const words = new Set(significantTerms(input.query).map(stem));
  const ranked = fuse([lexical, meaning], (m) => m.id, (m) => recencyBoost(m.updatedAt, input.now)).map(({ item }) => ({
    memory: item,
    similarity: similarity.get(item.id) ?? null,
    shared: new Set(significantTerms(item.text).map(stem).filter((w) => words.has(w))).size,
  }));
  const weak = input.weakFloor ?? MEMORY_WEAK_FLOOR;
  const qualifies = (r: RankedMemory) => !input.strict || (r.similarity ?? 0) >= input.meaningFloor || ((r.similarity ?? 0) >= weak && r.shared >= 1) || r.shared >= 2;
  return ranked.filter(qualifies).slice(0, input.limit);
}

/** Enough stemming to match "projects" with "project" and "deployed" with "deploy". */
export function stem(word: string): string {
  const w = word.toLowerCase().replace(/'s$/, "");
  for (const suffix of ["ing", "ed", "es", "s"]) if (w.endsWith(suffix) && w.length - suffix.length >= 3) return w.slice(0, -suffix.length);
  return w;
}
