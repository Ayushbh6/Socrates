import type { RankedRetrievalParent, RetrievalCandidate } from "./types"

export const DEFAULT_RETRIEVAL_LIMIT = 8
export const MAX_RETRIEVAL_LIMIT = 8
export const RETRIEVAL_RECENCY_SCORE_BAND = 0.05

export const clampNormalizedScore = (score: number): number => Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0))

export const normalizeScores = (scores: number[], direction: "higher" | "lower" = "higher"): number[] => {
  if (scores.length === 0) return []
  const finite = scores.map((score) => (Number.isFinite(score) ? score : 0))
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  if (max === min) return finite.map(() => 1)
  return finite.map((score) => clampNormalizedScore(direction === "higher" ? (score - min) / (max - min) : (max - score) / (max - min)))
}

export const rankDistinctParents = <TMetadata>(
  candidates: RetrievalCandidate<TMetadata>[],
  options: { limit?: number; recencyBand?: number } = {},
): RankedRetrievalParent<TMetadata>[] => {
  const limit = Math.min(MAX_RETRIEVAL_LIMIT, Math.max(1, options.limit ?? DEFAULT_RETRIEVAL_LIMIT))
  const recencyBand = Math.max(0, options.recencyBand ?? RETRIEVAL_RECENCY_SCORE_BAND)
  const bestByParent = new Map<string, RetrievalCandidate<TMetadata>>()
  for (const candidate of candidates) {
    const current = bestByParent.get(candidate.parentId)
    if (!current || candidate.normalizedScore > current.normalizedScore) {
      bestByParent.set(candidate.parentId, { ...candidate, normalizedScore: clampNormalizedScore(candidate.normalizedScore) })
    }
  }
  const relevanceOrdered = [...bestByParent.values()].sort(compareRelevance)
  const reordered = [...relevanceOrdered]
  let start = 0
  while (start < reordered.length) {
    let end = start + 1
    const bandTop = reordered[start]?.normalizedScore ?? 0
    while (end < reordered.length && bandTop - (reordered[end]?.normalizedScore ?? 0) <= recencyBand) {
      end += 1
    }
    reordered.splice(start, end - start, ...reordered.slice(start, end).sort(compareRecencyThenRelevance))
    start = end
  }
  const originalRanks = new Map(relevanceOrdered.map((candidate, index) => [candidate.chunkId, index]))
  return reordered.slice(0, limit).map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
    recencyReordered: originalRanks.get(candidate.chunkId) !== index,
  }))
}

const compareRelevance = <TMetadata>(left: RetrievalCandidate<TMetadata>, right: RetrievalCandidate<TMetadata>): number =>
  right.normalizedScore - left.normalizedScore || right.rawScore - left.rawScore || left.chunkId.localeCompare(right.chunkId)

const compareRecencyThenRelevance = <TMetadata>(left: RetrievalCandidate<TMetadata>, right: RetrievalCandidate<TMetadata>): number =>
  Date.parse(right.occurredAt ?? "") - Date.parse(left.occurredAt ?? "") || compareRelevance(left, right)
