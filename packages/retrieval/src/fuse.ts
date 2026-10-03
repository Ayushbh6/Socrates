/**
 * The one hybrid scoring path (agent-harness.md, "Hybrid retrieval"): keyword
 * and meaning rankings are merged by reciprocal rank fusion, so raw BM25 and
 * cosine scores never have to be calibrated against each other, and a small
 * recency boost settles near-ties in favour of newer evidence.
 *
 * Scores are in "top-rank units": first place in one ranking is worth 1, and
 * place r is worth (K + 1) / (K + r). An item first in both rankings scores 2.
 */

export const RRF_K = 10;
/** At most this much is added for brand-new evidence: about half the gap between first and second place. */
export const RECENCY_WEIGHT = 0.05;
export const RECENCY_HALF_LIFE_DAYS = 30;

/** The fused value of one 1-based rank. */
export function rankScore(rank: number): number {
  return (RRF_K + 1) / (RRF_K + rank);
}

/** Up to RECENCY_WEIGHT for something from now, halving every RECENCY_HALF_LIFE_DAYS. */
export function recencyBoost(at: string | Date, now: Date, weight = RECENCY_WEIGHT): number {
  const ageDays = Math.max(0, (now.getTime() - new Date(at).getTime()) / 86_400_000);
  return weight * 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Merge rankings, each ordered best first, into one. An item may appear in
 * any subset of rankings; its scores add up. `boost` adds a per-item term in
 * the same units, once. Ties keep the order of first appearance.
 */
export function fuse<T>(rankings: T[][], key: (item: T) => string, boost?: (item: T) => number): { item: T; score: number }[] {
  const merged = new Map<string, { item: T; score: number; order: number }>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    let rank = 0;
    for (const item of ranking) {
      const k = key(item);
      if (seen.has(k)) continue;
      seen.add(k);
      rank++;
      const entry = merged.get(k) ?? merged.set(k, { item, score: 0, order: merged.size }).get(k)!;
      entry.score += rankScore(rank);
    }
  }
  const out = [...merged.values()];
  if (boost) for (const e of out) e.score += boost(e.item);
  return out.sort((a, b) => b.score - a.score || a.order - b.order).map(({ item, score }) => ({ item, score }));
}
