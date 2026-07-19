export type RetrievalCorpusKind = "trace_turn" | "memory_section" | "goal_card"
export type RetrievalRole = "user" | "assistant"

export type MarkdownChunk = {
  content: string
  chunkIndex: number
  tokenCount: number
  contentHash: string
}

export type RetrievalCandidate<TMetadata = Record<string, unknown>> = {
  chunkId: string
  parentId: string
  content: string
  rawScore: number
  normalizedScore: number
  occurredAt?: string
  metadata: TMetadata
}

export type RankedRetrievalParent<TMetadata = Record<string, unknown>> = RetrievalCandidate<TMetadata> & {
  rank: number
  recencyReordered: boolean
}

export type RetrievalChunkIdentityInput = {
  corpusKind: RetrievalCorpusKind
  parentId: string
  discriminator: string
  chunkIndex: number
  contentHash: string
}
