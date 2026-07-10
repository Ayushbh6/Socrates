import path from "node:path"
import type { MemoryRetrievalFile, MemoryRetrievalSection, MemoryRetrievalSurface, TraceRetrieveVisibleStatus } from "@socrates/contracts"
import { chunkMarkdown, retrievalChunkId } from "@socrates/core"
import type { DatabaseHandle } from "../../db/client"
import type { RetrievalIndexRow } from "./types"

const VISIBLE_CONVERSATION_STATUSES = ["active", "archived"]
const INDEXED_TURN_STATUSES = ["completed", "failed", "cancelled"]
const SKIPPED_MEMORY_SECTION_IDS = new Set(["always_apply_rules", "global_always_apply_rules"])
const LOW_PRIORITY_MEMORY_SECTION_IDS = new Set(["runtime_context", "legacy_content", "scratch_notes", "completed_archive"])

type CanonicalTurnRow = {
  projectId: string
  conversationId: string
  conversationTitle: string | null
  turnId: string
  turnStatus: string
  turnNumber: number
  startedAt: string
  completedAt: string | null
  failedAt: string | null
  cancelledAt: string | null
  userContent: string | null
  assistantContent: string | null
}

type CanonicalMemorySectionRow = {
  scope: string
  projectId: string
  path: string
  docType: string
  sectionId: string
  heading: string
  content: string
  updatedAt: string
}

export const loadCanonicalTraceRows = (handle: DatabaseHandle, projectId: string, turnId?: string): RetrievalIndexRow[] => {
  const placeholders = INDEXED_TURN_STATUSES.map(() => "?").join(",")
  const conversationPlaceholders = VISIBLE_CONVERSATION_STATUSES.map(() => "?").join(",")
  const rows = handle.sqlite
    .prepare(
      `WITH numbered_turns AS (
         SELECT t.id AS turnId,
                t.conversation_id AS conversationId,
                t.status AS turnStatus,
                t.started_at AS startedAt,
                t.completed_at AS completedAt,
                t.failed_at AS failedAt,
                t.cancelled_at AS cancelledAt,
                t.user_message_id AS userMessageId,
                t.assistant_message_id AS assistantMessageId,
                c.project_id AS projectId,
                c.title AS conversationTitle,
                ROW_NUMBER() OVER (PARTITION BY t.conversation_id ORDER BY t.started_at ASC, t.id ASC) AS turnNumber
         FROM turns t
         INNER JOIN conversations c ON c.id = t.conversation_id
         WHERE c.project_id = ?
           AND c.status IN (${conversationPlaceholders})
           AND t.status IN (${placeholders})
       )
       SELECT nt.*,
              um.content AS userContent,
              am.content AS assistantContent
       FROM numbered_turns nt
       LEFT JOIN messages um ON um.id = nt.userMessageId AND um.role = 'user'
       LEFT JOIN messages am ON am.id = nt.assistantMessageId AND am.role = 'assistant'
       ${turnId ? "WHERE nt.turnId = ?" : ""}
       ORDER BY nt.startedAt ASC`,
    )
    .all(projectId, ...VISIBLE_CONVERSATION_STATUSES, ...INDEXED_TURN_STATUSES, ...(turnId ? [turnId] : [])) as CanonicalTurnRow[]

  return rows.flatMap((row) => traceChunksForTurn(row))
}

export const loadCanonicalMemoryRows = (handle: DatabaseHandle, projectId: string): RetrievalIndexRow[] => {
  const rows = handle.sqlite
    .prepare(
      `SELECT scope,
              project_id AS projectId,
              path,
              doc_type AS docType,
              section_id AS sectionId,
              heading,
              content,
              updated_at AS updatedAt
       FROM memory_doc_sections
       WHERE project_id IN (?, 'global')
         AND doc_type NOT IN ('tool_doc', 'skill')
       ORDER BY scope, path, section_id`,
    )
    .all(projectId) as CanonicalMemorySectionRow[]

  return rows.flatMap((row) => memoryChunksForSection(projectId, row))
}

export const canonicalMemoryParentId = (input: { scope: string; projectId: string; path: string; sectionId: string }): string =>
  `${input.scope === "global" ? "global" : "project"}:${input.projectId}:${input.path}:${input.sectionId}`

const traceChunksForTurn = (row: CanonicalTurnRow): RetrievalIndexRow[] => {
  const status = visibleStatus(row)
  const occurredAt = row.completedAt ?? row.cancelledAt ?? row.failedAt ?? row.startedAt
  const parentId = row.turnId
  const base = {
    projectId: row.projectId,
    corpusKind: "trace_turn" as const,
    parentId,
    occurredAt,
    priority: 1,
    scope: "project" as const,
    surface: "" as const,
    fileName: "" as const,
    sectionId: "" as const,
    sectionHeading: "",
    conversationId: row.conversationId,
    conversationTitle: row.conversationTitle?.trim() || "Untitled conversation",
    turnId: row.turnId,
    turnNumber: row.turnNumber,
    status,
  }
  const parts: Array<{ role: "user" | "assistant"; content: string }> = []
  if (row.userContent?.trim()) parts.push({ role: "user", content: row.userContent })
  if (row.assistantContent?.trim()) parts.push({ role: "assistant", content: row.assistantContent })
  return parts.flatMap((part) =>
    chunkMarkdown(part.content).map((chunk) => ({
      ...base,
      id: retrievalChunkId({ corpusKind: "trace_turn", parentId, discriminator: part.role, chunkIndex: chunk.chunkIndex, contentHash: chunk.contentHash }),
      discriminator: part.role,
      content: chunk.content,
      contentHash: chunk.contentHash,
      chunkIndex: chunk.chunkIndex,
      tokenCount: chunk.tokenCount,
      matchedRole: part.role,
    })),
  )
}

const memoryChunksForSection = (activeProjectId: string, row: CanonicalMemorySectionRow): RetrievalIndexRow[] => {
  if (!row.content.trim() || SKIPPED_MEMORY_SECTION_IDS.has(row.sectionId)) return []
  const mapped = memoryLocation(row)
  if (!mapped) return []
  const scope = row.scope === "global" ? "global" : "project"
  const parentId = canonicalMemoryParentId(row)
  return chunkMarkdown(row.content).map((chunk) => ({
    id: retrievalChunkId({ corpusKind: "memory_section", parentId, discriminator: "section", chunkIndex: chunk.chunkIndex, contentHash: chunk.contentHash }),
    projectId: activeProjectId,
    corpusKind: "memory_section",
    parentId,
    discriminator: "section",
    content: chunk.content,
    contentHash: chunk.contentHash,
    chunkIndex: chunk.chunkIndex,
    tokenCount: chunk.tokenCount,
    occurredAt: row.updatedAt,
    priority: LOW_PRIORITY_MEMORY_SECTION_IDS.has(row.sectionId) ? 0.65 : 1,
    scope,
    surface: mapped.surface,
    fileName: mapped.fileName,
    sectionId: row.sectionId as MemoryRetrievalSection,
    sectionHeading: row.heading,
    conversationId: "",
    conversationTitle: "",
    turnId: "",
    turnNumber: 0,
    matchedRole: "",
    status: "",
  }))
}

const visibleStatus = (row: CanonicalTurnRow): TraceRetrieveVisibleStatus => {
  if (row.turnStatus === "completed") return "complete"
  if (row.turnStatus === "cancelled") return row.assistantContent?.trim() ? "cancelled_partial" : "cancelled_user_only"
  return "failed_user_only"
}

const memoryLocation = (row: CanonicalMemorySectionRow): { surface: MemoryRetrievalSurface; fileName: MemoryRetrievalFile } | undefined => {
  const fileName = path.basename(row.path) as MemoryRetrievalFile
  if (row.docType === "project_notes") return { surface: "project_notes", fileName: "PROJECT_NOTES.md" }
  if (row.docType === "project_memory") return { surface: "project_memory", fileName: "MEMORY.md" }
  if (row.docType === "user_profile") return { surface: "user_profile", fileName: "user_profile.md" }
  if (row.docType === "identity") return { surface: "identity", fileName: "identity.md" }
  if (row.docType.startsWith("repo_")) return { surface: "repo_docs", fileName }
  return undefined
}
