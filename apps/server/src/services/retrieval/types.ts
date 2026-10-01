import type { MemoryRetrievalFile, MemoryRetrievalSection, MemoryRetrievalSurface, TraceRetrieveVisibleStatus } from "@socrates/contracts"
import type { RetrievalCorpusKind, RetrievalRole } from "@socrates/core"

export type RetrievalIndexRow = {
  id: string
  projectId: string
  corpusKind: RetrievalCorpusKind
  parentId: string
  discriminator: string
  content: string
  contentHash: string
  chunkIndex: number
  tokenCount: number
  occurredAt: string
  priority: number
  scope: "global" | "project"
  runtimeKind: "classic" | "v2_flow" | "memory"
  flowId: string
  surface: MemoryRetrievalSurface | ""
  fileName: MemoryRetrievalFile | ""
  sectionId: MemoryRetrievalSection | ""
  sectionHeading: string
  conversationId: string
  conversationTitle: string
  turnId: string
  turnNumber: number
  matchedRole: RetrievalRole | ""
  status: TraceRetrieveVisibleStatus | ""
  vector?: number[]
}

export type RetrievalSearchMode = "lexical" | "semantic" | "combined"

export type RetrievalSearchFilters = {
  corpusKind: RetrievalCorpusKind
  scope?: "current_conversation" | "recent_conversations" | "project" | "global" | "all"
  runtimeKind?: "classic" | "v2_flow" | "memory"
  flowId?: string
  conversationId?: string
  conversationTitle?: string
  role?: RetrievalRole | "any"
  createdAfter?: string
  createdBefore?: string
}

export type LanceSearchRow = RetrievalIndexRow & {
  _distance?: number
  _score?: number
  _relevance_score?: number
}
