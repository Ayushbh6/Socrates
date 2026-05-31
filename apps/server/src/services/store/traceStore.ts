import { createHash } from "node:crypto"
import type {
  TraceRetrieveInclude,
  TraceRetrieveEntryType,
  TraceRetrieveInspectArgs,
  TraceRetrieveInspectInput,
  TraceRetrieveMode,
  TraceRetrieveProvenanceKind,
  TraceRetrieveRole,
  TraceRetrieveSearchInput,
  TraceRetrieveScope,
  TraceRetrieveSourceKind,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
} from "@socrates/contracts"
import { normalizeTraceRetrieveInput, traceRetrieveToolInputSchema } from "@socrates/contracts"
import { estimateTextTokens } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, desc, eq, inArray } from "drizzle-orm"
import {
  approvals,
  conversations,
  errors,
  fileOperations,
  messageAttachments,
  messages,
  patches,
  shellCommands,
  shellOutputChunks,
  toolCalls,
  traceDocuments,
  traceIndexJobs,
} from "../../db/schema"
import { StoreBase } from "./shared"
import type { TraceQueryEmbeddingResult } from "./embeddingStore"

const DEFAULT_LIMIT = 5
const DEFAULT_CHAR_LIMIT = 20_000
const DEFAULT_CONVERSATION_LIMIT = 10
const DEFAULT_TURN_LIMIT = 20
const DEFAULT_PER_CONVERSATION_LIMIT = 5
const QUERYLESS_RESULT_UNIT_LIMIT = 20
const QUERYLESS_OUTPUT_TOKEN_LIMIT = 6_000
const SNIPPET_CONTEXT_LINES = 8
const SNIPPET_MIN_CHARS = 1_600
const SNIPPET_MAX_CHARS = 3_200
const CHUNK_SIZE = 6_000
const CHUNK_OVERLAP = 300
const VISIBLE_CONVERSATION_STATUSES = ["active", "archived"] as const
const visibleTraceConversationJoin =
  "INNER JOIN conversations vc ON vc.id = td.conversation_id AND vc.project_id = td.project_id AND vc.status IN ('active', 'archived')"

type TraceDocumentInsert = typeof traceDocuments.$inferInsert
type TraceDocumentRow = typeof traceDocuments.$inferSelect
type MessageAttachmentRow = typeof messageAttachments.$inferSelect

type TraceTurnContext = {
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  status: string
  startedAt: string
  completedAt: string | null
  failedAt: string | null
  cancelledAt: string | null
  errorId: string | null
  title: string | null
}

type SearchRow = TraceDocumentRow & {
  score: number | null
}

type ConversationProvenance = {
  id: string
  title?: string
  status?: "active" | "archived" | "deleted"
  updatedAt?: string
  isCurrentConversation: boolean
}

type TraceEmbeddingQueryProvider = {
  embedTraceQuery(projectId: string, query: string): Promise<TraceQueryEmbeddingResult>
}

type MessageOrdinalRow = {
  id: string
  conversationId: string
  sessionId: string
  turnId: string
  role: string
  content: string
  status: string
  createdAt: string
  completedAt: string | null
}

type ConversationRow = {
  id: string
  title: string | null
  status: string
  updatedAt: string
}

type TurnOrdinalRow = {
  id: string
  conversationId: string
  status: string
  startedAt: string
  completedAt: string | null
  failedAt: string | null
  cancelledAt: string | null
  userMessageId: string | null
  assistantMessageId: string | null
}

type TraceMessageEntryType = Exclude<TraceRetrieveEntryType, "qa_pair">

type InternalTraceMessageResult = {
  resultNumber?: number
  text: string
  entryType: TraceMessageEntryType
  conversationTitle: string
  conversationId: string
  messageId?: string
  toolId?: string
  messageNo?: number
  provenanceKind?: TraceRetrieveProvenanceKind
  pairedUserMessageNo?: number
  pairedUserPreview?: string
  inspectArgs: TraceRetrieveInspectArgs
  rank: number
  createdAt?: string
}

type InternalTraceQaPairResult = {
  resultNumber?: number
  entryType: "qa_pair"
  conversationTitle: string
  conversationId: string
  turnNo: number
  turnId: string
  userMessageId?: string
  assistantMessageId?: string
  userText?: string
  assistantText?: string
  startedAt: string
  completedAt?: string | null
  inspectArgs: TraceRetrieveInspectArgs
  rank: number
  createdAt?: string
}

type InternalTraceSearchResult = InternalTraceMessageResult | InternalTraceQaPairResult

type ResolveConversationOptions = {
  conversationTitle?: string
  conversationId?: string
  conversationOffset?: number
  conversationLimitProvided?: boolean
  updatedAfter?: string
  updatedBefore?: string
}

const traceDocumentSelect = `td.id AS id,
  td.project_id AS projectId,
  td.conversation_id AS conversationId,
  td.turn_id AS turnId,
  td.source_kind AS sourceKind,
  td.source_table AS sourceTable,
  td.source_id AS sourceId,
  td.handle AS handle,
  td.title AS title,
  td.summary AS summary,
  td.content AS content,
  td.content_hash AS contentHash,
  td.importance AS importance,
  td.preserve_verbatim AS preserveVerbatim,
  td.chunk_index AS chunkIndex,
  td.token_count_estimate AS tokenCountEstimate,
  td.metadata_json AS metadataJson,
  td.created_at AS createdAt,
  td.updated_at AS updatedAt`

export class TraceStore extends StoreBase {
  private readonly recentSearchRefs = new Map<string, TraceRetrieveInspectArgs[]>()

  constructor(
    context: ConstructorParameters<typeof StoreBase>[0],
    private readonly embeddingQueryProvider?: TraceEmbeddingQueryProvider,
  ) {
    super(context)
  }

  indexTurn(projectId: string, conversationId: string, turnId: string): void {
    const now = nowIso()
    const jobId = createId("tjob")
    this.handle.db
      .insert(traceIndexJobs)
      .values({
        id: jobId,
        projectId,
        conversationId,
        turnId,
        jobKind: "build_trace_documents",
        status: "queued",
        attempts: 0,
        createdAt: now,
      })
      .run()

    try {
      this.handle.db
        .update(traceIndexJobs)
        .set({ status: "running", attempts: 1, startedAt: nowIso() })
        .where(eq(traceIndexJobs.id, jobId))
        .run()
      const inserted = this.buildTurnDocuments(projectId, conversationId, turnId)
      this.handle.db
        .update(traceIndexJobs)
        .set({
          status: "completed",
          completedAt: nowIso(),
          metadataJson: JSON.stringify({ insertedDocuments: inserted }),
        })
        .where(eq(traceIndexJobs.id, jobId))
        .run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.handle.db
        .update(traceIndexJobs)
        .set({
          status: "failed",
          completedAt: nowIso(),
          metadataJson: JSON.stringify({ error: message }),
        })
        .where(eq(traceIndexJobs.id, jobId))
        .run()
    }
  }

  indexCompactionSnapshot(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId?: string
    snapshotId: string
    renderedSummary: string
    sourceHandles: Array<Record<string, unknown>>
  }): void {
    const now = nowIso()
    const context: TraceTurnContext = {
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId ?? input.snapshotId,
      status: "completed",
      startedAt: now,
      completedAt: now,
      failedAt: null,
      cancelledAt: null,
      errorId: null,
      title: "Context compaction summary",
    }
    this.insertTraceDocument(
      makeTraceDocument({
        context,
        sourceKind: "conversation_summary",
        sourceTable: "context_compaction_snapshots",
        sourceId: input.snapshotId,
        title: "Context compaction summary",
        summary: summarizeText(input.renderedSummary, 240),
        content: input.renderedSummary,
        importance: "high",
        metadata: {
          hidden: true,
          sessionId: input.sessionId,
          snapshotId: input.snapshotId,
          sourceHandles: input.sourceHandles,
        },
      }),
    )
  }

  async retrieve(projectId: string, currentConversationId: string, input: TraceRetrieveToolInput): Promise<TraceRetrieveToolOutput> {
    const parsed = traceRetrieveToolInputSchema.safeParse(normalizeTraceRetrieveInput(input))
    if (!parsed.success) {
      throw new SocratesError("trace_retrieve_invalid_input", parsed.error.message, { recoverable: true })
    }
    const normalizedInput = parsed.data
    if (normalizedInput.operation === "inspect") {
      return this.inspect(projectId, currentConversationId, normalizedInput)
    }
    return this.search(projectId, currentConversationId, normalizedInput)
  }

  private buildTurnDocuments(projectId: string, conversationId: string, turnId: string): number {
    const context = this.getTurnContext(projectId, conversationId, turnId)
    if (!context) {
      return 0
    }

    this.deleteTurnTraceDocuments(turnId)

    const docs: TraceDocumentInsert[] = []
    docs.push(...this.buildMessageDocuments(context))
    docs.push(...this.buildToolDocuments(context))
    docs.push(...this.buildShellDocuments(context))
    docs.push(...this.buildFileDocuments(context))
    docs.push(...this.buildPatchDocuments(context))
    docs.push(...this.buildErrorDocuments(context))
    docs.push(this.buildTurnSummaryDocument(context, docs))

    for (const doc of docs) {
      this.insertTraceDocument(doc)
    }
    return docs.length
  }

  private async search(
    projectId: string,
    currentConversationId: string,
    input: TraceRetrieveSearchInput,
  ): Promise<TraceRetrieveToolOutput> {
    const scope = input.scope ?? "recent_conversations"
    const mode = input.mode ?? "exact"
    const limit = input.limit ?? DEFAULT_LIMIT
    const requestedConversationLimit = input.conversationLimit ?? DEFAULT_CONVERSATION_LIMIT
    const hasTextQuery = input.query !== undefined
    const ignoredOrdinalLookup = hasTextQuery && input.turnNo !== undefined
    const conversationLimit = input.turnNo === undefined || ignoredOrdinalLookup ? requestedConversationLimit : DEFAULT_CONVERSATION_LIMIT
    const conversationOffset = input.conversationOffset ?? 0
    const perConversationLimit = input.perConversationLimit ?? DEFAULT_PER_CONVERSATION_LIMIT
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const include = input.include
    const warnings: string[] = []
    const createdAfter = input.createdAfter
    const createdBefore = input.createdBefore
    const updatedAfter = input.updatedAfter
    const updatedBefore = input.updatedBefore

    if (scope === "current_conversation") {
      warnings.push(`Only viewing the current chat. Use scope="recent_conversations" or "project" to widen.`)
    }
    if (input.includeRaw) {
      warnings.push(`Search returns compact snippets only. Use operation="inspect" with a returned handle for exact source text.`)
    }
    if (ignoredOrdinalLookup) {
      warnings.push(
        `trace_retrieve received both query and turnNo. This is not allowed for exact turn selection, so turnNo was ignored and query search was run${input.role ? " with role kept as a query filter" : ""}. To retrieve one exact Q/A turn, call trace_retrieve with turnNo and optional role, without query.`,
      )
    }
    if (mode !== "audit" && requiresAuditMode(input)) {
      throw new SocratesError(
        "trace_audit_mode_required",
        `Normal trace_retrieve search returns conversation memory only. Retry with mode="audit" to search tool calls, shell output, file operations, patches, errors, commands, or tool names.`,
        { recoverable: true },
      )
    }

    const useOrdinalLookup = input.turnNo !== undefined && !hasTextQuery
    const conversationIds = this.resolveConversationIds(projectId, currentConversationId, scope, conversationLimit, {
      ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      conversationOffset,
      conversationLimitProvided: input.conversationLimit !== undefined,
      ...(updatedAfter ? { updatedAfter } : {}),
      ...(updatedBefore ? { updatedBefore } : {}),
    })
    if (input.conversationTitle && conversationIds.length === 0) {
      warnings.push(`No visible conversation matched conversationTitle="${input.conversationTitle}".`)
    }
    if (input.conversationId && conversationIds.length === 0) {
      warnings.push(`No visible conversation matched conversationId="${input.conversationId}".`)
    }
    if (useOrdinalLookup) {
      return this.searchOrdinalTurn(projectId, currentConversationId, input, {
        scope,
        mode,
        conversationLimit,
        conversationOffset,
        conversationLimitProvided: input.conversationLimit !== undefined,
        conversationTitle: input.conversationTitle,
        conversationId: input.conversationId,
        charLimit,
        include,
        updatedAfter,
        updatedBefore,
        warnings,
      })
    }
    if (!hasTextQuery) {
      return this.searchQuerylessBrowse(projectId, currentConversationId, input, {
        scope,
        mode,
        limit,
        conversationLimit,
        conversationOffset,
        conversationLimitProvided: input.conversationLimit !== undefined,
        perConversationLimit,
        conversationTitle: input.conversationTitle,
        conversationId: input.conversationId,
        charLimit,
        conversationIds,
        createdAfter,
        createdBefore,
        updatedAfter,
        updatedBefore,
        warnings,
      })
    }

    const query = input.query ?? ""
    if (mode === "audit") {
      return this.searchAuditTraceDocuments(projectId, currentConversationId, input, {
        scope,
        mode,
        limit,
        conversationLimit,
        conversationOffset,
        conversationLimitProvided: input.conversationLimit !== undefined,
        conversationTitle: input.conversationTitle,
        conversationId: input.conversationId,
        charLimit,
        conversationIds,
        createdAfter,
        createdBefore,
        updatedAfter,
        updatedBefore,
        warnings,
      })
    }

    const lexicalRows =
      mode === "semantic"
        ? []
        : this.searchTraceDocuments(projectId, {
            query,
            mode,
            conversationIds,
            sourceKinds: normalSourceKindsForInclude(include),
            include: undefined,
            toolNames: input.toolNames,
            paths: input.paths,
            command: input.command,
            role: input.role,
            entryType: input.entryType,
            hasAttachment: input.hasAttachment,
            createdAfter,
            createdBefore,
            limit,
          })
    const semanticRows =
      mode === "combined" || mode === "semantic"
        ? await this.searchSemanticTraceDocuments(projectId, {
            query,
            conversationIds,
            sourceKinds: normalSourceKindsForInclude(include),
            include: undefined,
            toolNames: input.toolNames,
            paths: input.paths,
            command: input.command,
            role: input.role,
            entryType: input.entryType,
            hasAttachment: input.hasAttachment,
            createdAfter,
            createdBefore,
            limit,
            warnings,
          })
        : []
    const rows =
      mode === "semantic"
        ? semanticRows
        : mergeSearchRows([...lexicalRows, ...semanticRows], limit)

    const fallbackRows =
      mode === "semantic" && rows.length === 0
        ? this.searchTraceDocuments(projectId, {
            query,
            mode,
            conversationIds,
            sourceKinds: normalSourceKindsForInclude(include),
            include: undefined,
            toolNames: input.toolNames,
            paths: input.paths,
            command: input.command,
            role: input.role,
            entryType: input.entryType,
            hasAttachment: input.hasAttachment,
            createdAfter,
            createdBefore,
            limit,
          })
        : rows

    const results = this.numberSearchResults(this.memoryResultsFromTraceRows(projectId, currentConversationId, fallbackRows, input, limit))
    this.rememberSearchRefs(projectId, currentConversationId, results.map((result) => result.inspectArgs))
    appendProvenanceWarnings(warnings, results, query)

    const publicResults = publicTraceSearchResults(results)
    const text = JSON.stringify(publicResults)
    return {
      results: publicResults,
      totalMatches: publicResults.length,
      truncation: truncationFor(text, charLimit),
      appliedFilters: {
        operation: "search",
        scope,
        mode,
        ...(scope === "project" && input.conversationLimit === undefined ? {} : { conversationLimit }),
        ...(conversationOffset ? { conversationOffset } : {}),
        ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        conversationIds,
        ...(input.role ? { role: input.role } : {}),
        ...(input.entryType ? { entryType: input.entryType } : {}),
        ...(input.hasAttachment !== undefined ? { hasAttachment: input.hasAttachment } : {}),
        ...(createdAfter ? { createdAfter } : {}),
        ...(createdBefore ? { createdBefore } : {}),
        ...(updatedAfter ? { updatedAfter } : {}),
        ...(updatedBefore ? { updatedBefore } : {}),
        ...(include ? { include } : {}),
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  private searchAuditTraceDocuments(
    projectId: string,
    currentConversationId: string,
    input: TraceRetrieveSearchInput,
    resolved: {
      scope: TraceRetrieveScope
      mode: TraceRetrieveMode
      limit: number
      conversationLimit: number
      conversationOffset: number
      conversationLimitProvided: boolean
      conversationTitle: string | undefined
      conversationId: string | undefined
      charLimit: number
      conversationIds: string[]
      createdAfter: string | undefined
      createdBefore: string | undefined
      updatedAfter: string | undefined
      updatedBefore: string | undefined
      warnings: string[]
    },
  ): TraceRetrieveToolOutput {
    const auditInclude = input.include ?? ["tool_calls", "shell", "files", "errors"]
    const query = input.query ?? ""
    const rows = this.searchTraceDocuments(projectId, {
      query,
      mode: "exact",
      conversationIds: resolved.conversationIds,
      include: auditInclude,
      toolNames: input.toolNames,
      paths: input.paths,
      command: input.command,
      role: input.role,
      entryType: input.entryType,
      hasAttachment: input.hasAttachment,
      createdAfter: resolved.createdAfter,
      createdBefore: resolved.createdBefore,
      limit: resolved.limit,
    })
    const results = this.numberSearchResults(
      rows.map((row) => ({
        ...this.searchResultFromTraceRow(row, input, currentConversationId),
        rank: memoryRank(row, input),
      })),
    )
    this.rememberSearchRefs(projectId, currentConversationId, results.map((result) => result.inspectArgs))
    appendProvenanceWarnings(resolved.warnings, results, query)
    const publicResults = publicTraceSearchResults(results)
    const text = JSON.stringify(publicResults)
    return {
      results: publicResults,
      totalMatches: publicResults.length,
      truncation: truncationFor(text, resolved.charLimit),
      appliedFilters: {
        operation: "search",
        scope: resolved.scope,
        mode: resolved.mode,
        ...(resolved.scope === "project" && !resolved.conversationLimitProvided ? {} : { conversationLimit: resolved.conversationLimit }),
        ...(resolved.conversationOffset ? { conversationOffset: resolved.conversationOffset } : {}),
        ...(resolved.conversationTitle ? { conversationTitle: resolved.conversationTitle } : {}),
        ...(resolved.conversationId ? { conversationId: resolved.conversationId } : {}),
        conversationIds: resolved.conversationIds,
        ...(input.role ? { role: input.role } : {}),
        ...(input.entryType ? { entryType: input.entryType } : {}),
        ...(input.hasAttachment !== undefined ? { hasAttachment: input.hasAttachment } : {}),
        ...(resolved.createdAfter ? { createdAfter: resolved.createdAfter } : {}),
        ...(resolved.createdBefore ? { createdBefore: resolved.createdBefore } : {}),
        ...(resolved.updatedAfter ? { updatedAfter: resolved.updatedAfter } : {}),
        ...(resolved.updatedBefore ? { updatedBefore: resolved.updatedBefore } : {}),
        include: auditInclude,
      },
      warnings: resolved.warnings.length > 0 ? resolved.warnings : undefined,
    }
  }

  private searchQuerylessBrowse(
    projectId: string,
    currentConversationId: string,
    input: TraceRetrieveSearchInput,
    resolved: {
      scope: TraceRetrieveScope
      mode: TraceRetrieveMode
      limit: number
      conversationLimit: number
      conversationOffset: number
      conversationLimitProvided: boolean
      perConversationLimit: number
      conversationTitle: string | undefined
      conversationId: string | undefined
      charLimit: number
      conversationIds: string[]
      createdAfter: string | undefined
      createdBefore: string | undefined
      updatedAfter: string | undefined
      updatedBefore: string | undefined
      warnings: string[]
    },
  ): TraceRetrieveToolOutput {
    const warnings = [...resolved.warnings]
    if (resolved.conversationIds.length === 0) {
      warnings.push("No visible conversations matched the queryless browse filters.")
    }
    const roleFilter =
      input.role === "user" || input.role === "assistant"
        ? input.role
        : input.entryType === "user_query"
          ? "user"
          : input.entryType === "assistant_response"
            ? "assistant"
            : undefined
    const resultUnitLimit = Math.min(input.limit ?? QUERYLESS_RESULT_UNIT_LIMIT, QUERYLESS_RESULT_UNIT_LIMIT)
    const rawResults =
      roleFilter !== undefined
        ? this.querylessBrowseMessages(projectId, currentConversationId, resolved.conversationIds, roleFilter, input, resolved)
        : this.querylessBrowseQaPairs(projectId, currentConversationId, resolved.conversationIds, input, resolved)
    const accepted: Array<InternalTraceSearchResult & { resultNumber: number }> = []
    let tokenBudgetStopped = false
    for (const result of rawResults) {
      if (accepted.length >= resultUnitLimit) {
        break
      }
      const numberedCandidate = { ...result, resultNumber: accepted.length + 1 }
      const publicCandidate = publicTraceSearchResults([...accepted, numberedCandidate])
      if (estimateTokens(JSON.stringify(publicCandidate)) > QUERYLESS_OUTPUT_TOKEN_LIMIT && accepted.length > 0) {
        tokenBudgetStopped = true
        break
      }
      accepted.push(numberedCandidate)
    }
    if (rawResults.length > accepted.length) {
      warnings.push(
        tokenBudgetStopped
          ? `Queryless browse stopped early near the ${QUERYLESS_OUTPUT_TOKEN_LIMIT} token output budget. Narrow with conversationLimit, perConversationLimit, role, dates, title, or offset.`
          : `Queryless browse is capped at ${QUERYLESS_RESULT_UNIT_LIMIT} result units. Narrow with conversationLimit, perConversationLimit, role, dates, title, or offset.`,
      )
    }
    this.rememberSearchRefs(projectId, currentConversationId, accepted.map((result) => result.inspectArgs))
    const publicResults = publicTraceSearchResults(accepted)
    const text = JSON.stringify(publicResults)
    return {
      results: publicResults,
      totalMatches: publicResults.length,
      truncation: truncationFor(text, resolved.charLimit),
      appliedFilters: {
        operation: "search",
        scope: resolved.scope,
        mode: resolved.mode,
        ...(resolved.scope === "project" && !resolved.conversationLimitProvided ? {} : { conversationLimit: resolved.conversationLimit }),
        ...(resolved.conversationOffset ? { conversationOffset: resolved.conversationOffset } : {}),
        perConversationLimit: resolved.perConversationLimit,
        ...(resolved.conversationTitle ? { conversationTitle: resolved.conversationTitle } : {}),
        ...(resolved.conversationId ? { conversationId: resolved.conversationId } : {}),
        conversationIds: resolved.conversationIds,
        ...(input.role ? { role: input.role } : {}),
        ...(input.entryType ? { entryType: input.entryType } : {}),
        ...(input.hasAttachment !== undefined ? { hasAttachment: input.hasAttachment } : {}),
        ...(resolved.createdAfter ? { createdAfter: resolved.createdAfter } : {}),
        ...(resolved.createdBefore ? { createdBefore: resolved.createdBefore } : {}),
        ...(resolved.updatedAfter ? { updatedAfter: resolved.updatedAfter } : {}),
        ...(resolved.updatedBefore ? { updatedBefore: resolved.updatedBefore } : {}),
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  private querylessBrowseQaPairs(
    projectId: string,
    currentConversationId: string,
    conversationIds: string[],
    input: TraceRetrieveSearchInput,
    resolved: { perConversationLimit: number; createdAfter: string | undefined; createdBefore: string | undefined },
  ): InternalTraceSearchResult[] {
    const results: InternalTraceSearchResult[] = []
    for (const conversationId of conversationIds) {
      const conversation = this.conversationProvenance(projectId, currentConversationId, conversationId)
      const rows = this.selectConversationTurnsForBrowse(projectId, conversationId, input, resolved)
      for (const row of rows) {
        results.push({
          entryType: "qa_pair",
          conversationTitle: conversation.title ?? "Untitled conversation",
          conversationId,
          turnNo: row.turnNo,
          turnId: row.turnId,
          ...(row.userMessageId ? { userMessageId: row.userMessageId } : {}),
          ...(row.assistantMessageId ? { assistantMessageId: row.assistantMessageId } : {}),
          ...(row.userText ? { userText: truncateText(row.userText, input.charLimit ?? DEFAULT_CHAR_LIMIT).text } : {}),
          ...(row.assistantText ? { assistantText: truncateText(row.assistantText, input.charLimit ?? DEFAULT_CHAR_LIMIT).text } : {}),
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          inspectArgs: { operation: "inspect", turnId: row.turnId },
          rank: 0,
          createdAt: row.startedAt,
        })
      }
    }
    return results
  }

  private querylessBrowseMessages(
    projectId: string,
    currentConversationId: string,
    conversationIds: string[],
    role: "user" | "assistant",
    input: TraceRetrieveSearchInput,
    resolved: { perConversationLimit: number; createdAfter: string | undefined; createdBefore: string | undefined },
  ): InternalTraceSearchResult[] {
    const results: InternalTraceSearchResult[] = []
    for (const conversationId of conversationIds) {
      const rows = this.selectConversationTurnsForBrowse(projectId, conversationId, input, resolved)
      for (const row of rows) {
        const message =
          role === "user"
            ? row.userMessageId && row.userText
              ? { id: row.userMessageId, content: row.userText, createdAt: row.startedAt }
              : undefined
            : row.assistantMessageId && row.assistantText
              ? { id: row.assistantMessageId, content: row.assistantText, createdAt: row.completedAt ?? row.startedAt }
              : undefined
        if (!message) {
          continue
        }
        results.push(
          this.searchResultFromRawMessage(
            projectId,
            currentConversationId,
            input,
            {
              id: message.id,
              conversationId,
              sessionId: "",
              turnId: row.turnId,
              role,
              content: message.content,
              status: "completed",
              createdAt: message.createdAt,
              completedAt: message.createdAt,
            },
            row.turnNo,
          ),
        )
      }
    }
    return results
  }

  private selectConversationTurnsForBrowse(
    projectId: string,
    conversationId: string,
    input: TraceRetrieveSearchInput,
    resolved: { perConversationLimit: number; createdAfter: string | undefined; createdBefore: string | undefined },
  ): Array<{
    turnId: string
    turnNo: number
    startedAt: string
    completedAt: string | null
    userMessageId: string | null
    assistantMessageId: string | null
    userText: string | null
    assistantText: string | null
  }> {
    if (input.entryType && !["qa_pair", "user_query", "assistant_response"].includes(input.entryType)) {
      return []
    }
    const params: unknown[] = [projectId, conversationId]
    const where = [
      "c.project_id = ?",
      "c.status IN ('active', 'archived')",
      "t.conversation_id = ?",
      "t.user_message_id IS NOT NULL",
    ]
    const outerWhere: string[] = []
    if (resolved.createdAfter) {
      outerWhere.push("ordered.startedAt >= ?")
      params.push(resolved.createdAfter)
    }
    if (resolved.createdBefore) {
      outerWhere.push("ordered.startedAt <= ?")
      params.push(resolved.createdBefore)
    }
    if (input.hasAttachment === true) {
      outerWhere.push(
        `EXISTS (
          SELECT 1 FROM message_attachments ma
          WHERE ma.status = 'attached' AND ma.turn_id = ordered.turnId
        )`,
      )
    } else if (input.hasAttachment === false) {
      outerWhere.push(
        `NOT EXISTS (
          SELECT 1 FROM message_attachments ma
          WHERE ma.status = 'attached' AND ma.turn_id = ordered.turnId
        )`,
      )
    }
    params.push(resolved.perConversationLimit)
    return this.handle.sqlite
      .prepare(
        `WITH ordered AS (
           SELECT
             t.id AS turnId,
             t.started_at AS startedAt,
             t.completed_at AS completedAt,
             t.user_message_id AS userMessageId,
             t.assistant_message_id AS assistantMessageId,
             ROW_NUMBER() OVER (ORDER BY t.started_at ASC, t.id ASC) AS turnNo
           FROM turns t
           INNER JOIN conversations c ON c.id = t.conversation_id
           WHERE ${where.join(" AND ")}
         )
         SELECT
           ordered.turnId,
           ordered.turnNo,
           ordered.startedAt,
           ordered.completedAt,
           ordered.userMessageId,
           ordered.assistantMessageId,
           um.content AS userText,
           am.content AS assistantText
         FROM ordered
         LEFT JOIN messages um ON um.id = ordered.userMessageId
         LEFT JOIN messages am ON am.id = ordered.assistantMessageId
         ${outerWhere.length > 0 ? `WHERE ${outerWhere.join(" AND ")}` : ""}
         ORDER BY ordered.startedAt DESC, ordered.turnId DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{
      turnId: string
      turnNo: number
      startedAt: string
      completedAt: string | null
      userMessageId: string | null
      assistantMessageId: string | null
      userText: string | null
      assistantText: string | null
    }>
  }

  private inspect(
    projectId: string,
    currentConversationId: string,
    input: TraceRetrieveInspectInput,
  ): TraceRetrieveToolOutput {
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const include = input.include
    const docs = this.resolveInspectDocuments(projectId, currentConversationId, input)
    const results = docs.map((doc) => {
      const content =
        input.conversationId && !input.handle
          ? this.buildConversationBundle(projectId, input.conversationId, include, input.startTurnNo ?? 1, input.turnLimit ?? DEFAULT_TURN_LIMIT)
          : input.turnId && !input.handle
            ? this.buildTurnBundle(projectId, input.turnId, include)
            : doc.content
      const truncated = truncateText(content, charLimit)
      const turnNo = doc.turnId && doc.conversationId ? this.findTurnNo(projectId, doc.conversationId, doc.turnId) : undefined
      const rawMessage = doc.sourceTable === "messages" ? this.getRawMessage(projectId, doc.sourceId) : undefined
      const resolvedMessageRole = doc.sourceTable === "messages" ? (this.messageRoleForDocument(doc) ?? messageRole(rawMessage?.role ?? "")) : undefined
      const conversation = doc.conversationId ? this.conversationProvenance(projectId, currentConversationId, doc.conversationId) : undefined
      const messageNo = messageNoForMatchedMessage(turnNo, doc.sourceTable === "messages" ? resolvedMessageRole : undefined)
      const pairedUser = doc.turnId && resolvedMessageRole === "assistant" && messageNo ? this.pairedUserReference(projectId, doc.turnId, messageNo, input.query) : undefined
      return {
        ...(input.resultNumber ? { resultNumber: input.resultNumber } : {}),
        content: truncated.text,
        entryType: entryTypeForTraceDocument(doc, resolvedMessageRole),
        ...(doc.conversationId ? { conversationId: doc.conversationId } : {}),
        ...(conversation?.title ? { conversationTitle: conversation.title } : {}),
        ...(doc.sourceTable === "messages" ? { messageId: doc.sourceId } : {}),
        ...(doc.sourceTable === "tool_calls" ? { toolId: doc.sourceId } : {}),
        ...(messageNo ? { messageNo } : {}),
        provenanceKind: provenanceKindForTraceDocument(doc),
        ...pairedUser,
        ...(truncated.truncated
          ? {
              truncation: {
                truncated: true,
                charLimit,
                originalLength: content.length,
                returnedLength: truncated.text.length,
                nextOffset: truncated.text.length,
              },
            }
          : {}),
      }
    })
    const text = JSON.stringify(results)
    return {
      results,
      totalMatches: results.length,
      truncation: truncationFor(text, charLimit),
      appliedFilters: {
        operation: "inspect",
        ...(input.startTurnNo ? { startTurnNo: input.startTurnNo } : {}),
        ...(input.turnLimit ? { turnLimit: input.turnLimit } : {}),
        ...(include ? { include } : {}),
      },
      warnings: results.length === 0 ? [`No visible trace source matched the inspect handle or id. It may not exist, or its conversation may have been deleted.`] : undefined,
    }
  }

  private searchResultFromTraceRow(row: SearchRow, input: TraceRetrieveSearchInput, currentConversationId: string): InternalTraceSearchResult {
    const conversation = row.conversationId ? this.conversationProvenance(row.projectId, currentConversationId, row.conversationId) : undefined
    const turnNo = row.turnId && row.conversationId ? this.findTurnNo(row.projectId, row.conversationId, row.turnId) : undefined
    const documentMessageRole = row.sourceTable === "messages" ? this.messageRoleForDocument(row) : undefined
    const rawMessage =
      row.sourceTable === "messages"
        ? (this.getRawMessage(row.projectId, row.sourceId) ??
          (row.turnId && (documentMessageRole === "user" || documentMessageRole === "assistant")
            ? this.findMessageForTurnRole(row.projectId, row.turnId, documentMessageRole)
            : undefined))
        : undefined
    const resolvedMessageRole = row.sourceTable === "messages" ? (documentMessageRole ?? messageRole(rawMessage?.role ?? "")) : undefined
    const messageNo = messageNoForMatchedMessage(turnNo, row.sourceTable === "messages" ? resolvedMessageRole : undefined)
    const pairedUser = row.turnId && resolvedMessageRole === "assistant" && messageNo ? this.pairedUserReference(row.projectId, row.turnId, messageNo, input.query) : undefined
    const inspectArgs = rawMessage ? ({ operation: "inspect" as const, messageId: rawMessage.id } satisfies TraceRetrieveInspectArgs) : inspectArgsForSource(row.handle, row.sourceTable, row.sourceId, row.turnId)
    return {
      text: makeSnippet(rawMessage?.content ?? row.content, input.query),
      entryType: entryTypeForTraceDocument(row, resolvedMessageRole),
      conversationTitle: conversation?.title ?? "Untitled conversation",
      conversationId: row.conversationId ?? conversation?.id ?? "",
      ...(row.sourceTable === "messages" ? { messageId: rawMessage?.id ?? row.sourceId } : {}),
      ...(row.sourceTable === "tool_calls" ? { toolId: row.sourceId } : {}),
      ...(messageNo ? { messageNo } : {}),
      provenanceKind: provenanceKindForTraceDocument(row),
      ...pairedUser,
      inspectArgs,
      rank: memoryRank(row, input),
      createdAt: row.createdAt,
    }
  }

  private numberSearchResults<T extends { inspectArgs: TraceRetrieveInspectArgs }>(results: T[]): Array<T & { resultNumber: number }> {
    return results.map((result, index) => ({ ...result, resultNumber: index + 1 }))
  }

  private memoryResultsFromTraceRows(
    projectId: string,
    currentConversationId: string,
    rows: SearchRow[],
    input: TraceRetrieveSearchInput,
    limit: number,
  ) {
    const bestByMessageId = new Map<string, SearchRow>()
    const summaryRows: SearchRow[] = []
    for (const row of rows) {
      if (row.sourceKind === "conversation_summary" || row.sourceKind === "turn_summary") {
        summaryRows.push(row)
        continue
      }
      if (row.sourceTable !== "messages" || !row.conversationId) {
        continue
      }
      const existing = bestByMessageId.get(row.sourceId)
      if (!existing || memoryRank(row, input) < memoryRank(existing, input)) {
        bestByMessageId.set(row.sourceId, row)
      }
    }

    const messageResults = [...bestByMessageId.values()].map((row) => this.searchResultFromTraceRow(row, input, currentConversationId))
    const summaryResults = summaryRows.map((row) => this.searchResultFromTraceRow(row, input, currentConversationId))

    return [...messageResults, ...summaryResults]
      .sort((left, right) => {
        const qualityDelta = entryTypeWeight(left.entryType) - entryTypeWeight(right.entryType)
        if (qualityDelta !== 0) {
          return qualityDelta
        }
        const scoreDelta = left.rank - right.rank
        if (scoreDelta !== 0) {
          return scoreDelta
        }
        return (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
      })
      .slice(0, limit)
  }

  private rememberSearchRefs(projectId: string, currentConversationId: string, refs: TraceRetrieveInspectArgs[]): void {
    this.recentSearchRefs.set(traceSearchRefKey(projectId, currentConversationId), refs)
  }

  private searchOrdinalOrNaturalInspectCandidate(
    projectId: string,
    currentConversationId: string,
    input: TraceRetrieveInspectInput,
    query: string,
  ): { inspectArgs: TraceRetrieveInspectArgs } | undefined {
    if (input.turnNo !== undefined) {
      const resolved = this.resolveOrdinalConversationIds(
        projectId,
        currentConversationId,
        "current_conversation",
        DEFAULT_CONVERSATION_LIMIT,
      )
      const conversationId = resolved.conversationIds.length === 1 ? resolved.conversationIds[0] : undefined
      if (!conversationId) {
        return undefined
      }
      const turn = this.findTurnByNumber(projectId, conversationId, input.turnNo)
      if (!turn) {
        return undefined
      }
      if (input.role === "user" || input.role === "assistant") {
        const message = this.findMessageForTurnRole(projectId, turn.id, input.role)
        return message ? { inspectArgs: { operation: "inspect", messageId: message.id } } : undefined
      }
      return { inspectArgs: { operation: "inspect", turnId: turn.id } }
    }

    const conversationIds = this.resolveConversationIds(
      projectId,
      currentConversationId,
      "current_conversation",
      DEFAULT_CONVERSATION_LIMIT,
      {},
    )
    const rows = this.searchTraceDocuments(projectId, {
      query,
      mode: "exact",
      conversationIds,
      include: input.include,
      toolNames: undefined,
      paths: input.paths,
      command: input.command,
      role: input.role,
      entryType: undefined,
      hasAttachment: undefined,
      createdAfter: undefined,
      createdBefore: undefined,
      limit: 1,
    })
    const row = rows[0]
    return row ? this.searchResultFromTraceRow(row, { query, mode: "exact", paths: input.paths, command: input.command, role: input.role }, currentConversationId) : undefined
  }

  private searchOrdinalTurn(
    projectId: string,
    currentConversationId: string,
    input: TraceRetrieveSearchInput,
    resolved: {
      scope: TraceRetrieveScope
      mode: TraceRetrieveMode
      conversationLimit: number
      conversationOffset: number
      conversationLimitProvided: boolean
      conversationTitle: string | undefined
      conversationId: string | undefined
      charLimit: number
      include: TraceRetrieveInclude[] | undefined
      updatedAfter: string | undefined
      updatedBefore: string | undefined
      warnings: string[]
    },
  ): TraceRetrieveToolOutput {
    const warnings = [...resolved.warnings]
    const conversationResolution = this.resolveOrdinalConversationIds(
      projectId,
      currentConversationId,
      resolved.scope,
      resolved.conversationLimit,
      resolved.conversationTitle,
      resolved.conversationId,
      resolved.conversationOffset,
      resolved.updatedAfter,
      resolved.updatedBefore,
    )
    warnings.push(...conversationResolution.warnings)
    const conversationIds = conversationResolution.conversationIds
    let results: InternalTraceSearchResult[] = []

    for (const conversationId of conversationIds) {
      const turn = this.findTurnByNumber(projectId, conversationId, input.turnNo as number)
      if (!turn) {
        continue
      } else if (input.role === "user" || input.role === "assistant") {
        const message = this.findMessageForTurnRole(projectId, turn.id, input.role)
        if (message) {
          results.push(this.searchResultFromRawMessage(projectId, currentConversationId, input, message, input.turnNo as number))
        }
      } else {
        const userMessage = this.findMessageForTurnRole(projectId, turn.id, "user")
        const assistantMessage = this.findMessageForTurnRole(projectId, turn.id, "assistant")
        if (userMessage) {
          results.push(this.searchResultFromRawMessage(projectId, currentConversationId, input, userMessage, input.turnNo as number))
        }
        if (assistantMessage) {
          results.push(this.searchResultFromRawMessage(projectId, currentConversationId, input, assistantMessage, input.turnNo as number))
        }
      }
    }
    results = results.slice(0, DEFAULT_LIMIT)
    if (results.length === 0) {
      warnings.push(`No turn number ${input.turnNo} matched the selected scope.`)
    }

    const numberedResults = this.numberSearchResults(results)
    this.rememberSearchRefs(projectId, currentConversationId, numberedResults.map((result) => result.inspectArgs))
    const publicResults = publicTraceSearchResults(numberedResults)
    const text = JSON.stringify(publicResults)
    return {
      results: publicResults,
      totalMatches: publicResults.length,
      truncation: truncationFor(text, resolved.charLimit),
      appliedFilters: {
        operation: "search",
        scope: resolved.scope,
        mode: resolved.mode,
        ...(resolved.scope === "project" && !resolved.conversationLimitProvided ? {} : { conversationLimit: resolved.conversationLimit }),
        ...(resolved.conversationOffset ? { conversationOffset: resolved.conversationOffset } : {}),
        ...(resolved.conversationTitle ? { conversationTitle: resolved.conversationTitle } : {}),
        ...(resolved.conversationId ? { conversationId: resolved.conversationId } : {}),
        conversationIds,
        turnNo: input.turnNo as number,
        ...(input.role ? { role: input.role } : {}),
        ...(resolved.updatedAfter ? { updatedAfter: resolved.updatedAfter } : {}),
        ...(resolved.updatedBefore ? { updatedBefore: resolved.updatedBefore } : {}),
        ...(resolved.include ? { include: resolved.include } : {}),
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  private getTurnContext(projectId: string, conversationId: string, turnId: string): TraceTurnContext | undefined {
    return this.handle.sqlite
      .prepare(
        `SELECT
           c.project_id AS projectId,
           t.conversation_id AS conversationId,
           t.session_id AS sessionId,
           t.id AS turnId,
           t.status AS status,
           t.started_at AS startedAt,
           t.completed_at AS completedAt,
           t.failed_at AS failedAt,
           t.cancelled_at AS cancelledAt,
           t.error_id AS errorId,
           c.title AS title
         FROM turns t
         INNER JOIN conversations c ON c.id = t.conversation_id
         WHERE c.project_id = ? AND t.conversation_id = ? AND t.id = ?
         LIMIT 1`,
      )
      .get(projectId, conversationId, turnId) as TraceTurnContext | undefined
  }

  private deleteTurnTraceDocuments(turnId: string): void {
    const rows = this.handle.db.select().from(traceDocuments).where(eq(traceDocuments.turnId, turnId)).all()
    const deleteFts = this.handle.sqlite.prepare("DELETE FROM trace_documents_fts WHERE trace_document_id = ?")
    for (const row of rows) {
      deleteFts.run(row.id)
    }
    this.handle.db.delete(traceDocuments).where(eq(traceDocuments.turnId, turnId)).run()
  }

  private insertTraceDocument(doc: TraceDocumentInsert): void {
    this.handle.db.insert(traceDocuments).values(doc).run()
    this.handle.sqlite
      .prepare(
        `INSERT INTO trace_documents_fts (trace_document_id, title, summary, content, metadata_text)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(doc.id, doc.title, doc.summary ?? "", doc.content, metadataText(doc.metadataJson ?? undefined))
  }

  private buildMessageDocuments(context: TraceTurnContext): TraceDocumentInsert[] {
    const rows = this.handle.db.select().from(messages).where(eq(messages.turnId, context.turnId)).orderBy(messages.createdAt).all()
    const attachmentsByMessageId = this.getMessageAttachmentsByMessageId(rows.map((row) => row.id))
    const docs: TraceDocumentInsert[] = []
    for (const row of rows) {
      const attachmentReferences = attachmentsByMessageId.get(row.id) ?? []
      const content = appendMessageAttachmentReferences(row.content, attachmentReferences)
      const chunks = chunkText(content)
      chunks.forEach((chunk, index) => {
        docs.push(
          makeTraceDocument({
            context,
            sourceKind: "message",
            sourceTable: "messages",
            sourceId: row.id,
            title: `${capitalize(row.role)} message${chunks.length > 1 ? ` chunk ${index + 1}` : ""}`,
            summary: summarizeText(content, 240),
            content: chunk,
            importance: row.role === "user" ? "normal" : "low",
            chunkIndex: index,
            metadata: { role: row.role, status: row.status, attachmentCount: attachmentReferences.length },
          }),
        )
      })
      if (shouldCreateVerbatimAnchor(content)) {
        chunkText(content).forEach((chunk, index) => {
          docs.push(
            makeTraceDocument({
              context,
              sourceKind: "verbatim_anchor",
              sourceTable: "messages",
              sourceId: row.id,
              title: `Verbatim anchor: ${summarizeText(content, 80)}`,
              summary: "Exact user-provided source text that should be inspected before relying on a summary.",
              content: chunk,
              importance: "high",
              preserveVerbatim: true,
              chunkIndex: index,
              metadata: { role: row.role, tags: ["verbatim_anchor", "user_source_text"] },
            }),
          )
        })
      }
    }
    return docs
  }

  private getMessageAttachmentsByMessageId(messageIds: string[]): Map<string, MessageAttachmentRow[]> {
    const unique = Array.from(new Set(messageIds))
    if (unique.length === 0) {
      return new Map()
    }
    const rows = this.handle.db
      .select()
      .from(messageAttachments)
      .where(and(eq(messageAttachments.status, "attached"), inArray(messageAttachments.messageId, unique)))
      .orderBy(messageAttachments.createdAt)
      .all()
    const grouped = new Map<string, MessageAttachmentRow[]>()
    for (const row of rows) {
      if (!row.messageId) {
        continue
      }
      grouped.set(row.messageId, [...(grouped.get(row.messageId) ?? []), row])
    }
    return grouped
  }

  private buildToolDocuments(context: TraceTurnContext): TraceDocumentInsert[] {
    const rows = this.handle.db.select().from(toolCalls).where(eq(toolCalls.turnId, context.turnId)).orderBy(toolCalls.startedAt).all()
    const approvalRows = rows.length > 0 ? this.handle.db.select().from(approvals).where(inArray(approvals.toolCallId, rows.map((row) => row.id))).all() : []
    return rows.map((row) => {
      const approval = approvalRows.find((approvalRow) => approvalRow.toolCallId === row.id)
      const args = parseJson(row.argumentsJson)
      const result = parseJson(row.resultJson)
      const content = [
        `Tool: ${row.toolName}`,
        `Status: ${row.status}`,
        `Arguments: ${previewJson(args, 4_000)}`,
        row.resultJson ? `Result: ${previewJson(result, 8_000)}` : "",
        approval ? `Approval: ${approval.status} ${approval.decision ?? ""} ${approval.actionJson}` : "",
      ]
        .filter(Boolean)
        .join("\n")
      return makeTraceDocument({
        context,
        sourceKind: "tool_call",
        sourceTable: "tool_calls",
        sourceId: row.id,
        title: `${row.toolName} tool ${row.status}`,
        summary: summarizeTool(row.toolName, row.status, result),
        content,
        importance: row.status === "failed" || row.status === "rejected" ? "high" : "normal",
        metadata: { toolName: row.toolName, status: row.status, approvalStatus: approval?.status },
      })
    })
  }

  private buildShellDocuments(context: TraceTurnContext): TraceDocumentInsert[] {
    const rows = this.handle.db.select().from(shellCommands).where(eq(shellCommands.turnId, context.turnId)).orderBy(shellCommands.startedAt).all()
    return rows.map((row) => {
      const chunks = this.handle.db
        .select()
        .from(shellOutputChunks)
        .where(eq(shellOutputChunks.shellCommandId, row.id))
        .orderBy(shellOutputChunks.sequence)
        .all()
      const stdout = chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text).join("")
      const stderr = chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.text).join("")
      const log = chunks.filter((chunk) => chunk.stream !== "stdout" && chunk.stream !== "stderr").map((chunk) => chunk.text).join("")
      const content = [
        `Command: ${row.command}`,
        `cwd: ${row.cwd}`,
        `Status: ${row.status}`,
        `Exit code: ${row.exitCode ?? "none"}`,
        stdout ? `stdout:\n${truncateText(stdout, 8_000).text}` : "",
        stderr ? `stderr:\n${truncateText(stderr, 8_000).text}` : "",
        log ? `log:\n${truncateText(log, 4_000).text}` : "",
      ]
        .filter(Boolean)
        .join("\n")
      return makeTraceDocument({
        context,
        sourceKind: "shell",
        sourceTable: "shell_commands",
        sourceId: row.id,
        title: `Shell: ${truncateInline(row.command, 120)}`,
        summary: `Command ${row.status}${row.exitCode === null || row.exitCode === undefined ? "" : ` with exit code ${row.exitCode}`}.`,
        content,
        importance: row.exitCode && row.exitCode !== 0 ? "high" : "normal",
        metadata: { command: row.command, cwd: row.cwd, exitCode: row.exitCode, status: row.status },
      })
    })
  }

  private buildFileDocuments(context: TraceTurnContext): TraceDocumentInsert[] {
    const rows = this.handle.db.select().from(fileOperations).where(eq(fileOperations.turnId, context.turnId)).orderBy(fileOperations.startedAt).all()
    return rows.map((row) => {
      const metadata = parseJson(row.metadataJson)
      const metadataRecord = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : undefined
      return makeTraceDocument({
        context,
        sourceKind: "file",
        sourceTable: "file_operations",
        sourceId: row.id,
        title: `File ${row.operation}: ${row.path}`,
        summary: `${row.operation} ${row.path} ${row.status}.`,
        content: [
          `Operation: ${row.operation}`,
          `Path: ${row.path}`,
          row.oldPath ? `Old path: ${row.oldPath}` : "",
          `Status: ${row.status}`,
          row.contentHashBefore ? `Content hash before: ${row.contentHashBefore}` : "",
          row.contentHashAfter ? `Content hash after: ${row.contentHashAfter}` : "",
          typeof metadataRecord?.verification === "string" ? `Verification: ${metadataRecord.verification}` : "",
          typeof metadataRecord?.lineDelta === "number" ? `Line delta: ${metadataRecord.lineDelta}` : "",
          row.errorId ? `Error id: ${row.errorId}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        importance: row.status === "failed" ? "high" : "normal",
        metadata: {
          path: row.path,
          oldPath: row.oldPath,
          operation: row.operation,
          status: row.status,
          contentHashBefore: row.contentHashBefore,
          contentHashAfter: row.contentHashAfter,
          verification: metadataRecord?.verification,
        },
      })
    })
  }

  private buildPatchDocuments(context: TraceTurnContext): TraceDocumentInsert[] {
    const rows = this.handle.db.select().from(patches).where(eq(patches.turnId, context.turnId)).orderBy(patches.createdAt).all()
    return rows.map((row) =>
      makeTraceDocument({
        context,
        sourceKind: "patch",
        sourceTable: "patches",
        sourceId: row.id,
        title: `Patch ${row.status}`,
        summary: `Patch ${row.status}.`,
        content: truncateText(row.diffText, 12_000).text,
        importance: row.status === "failed" ? "high" : "normal",
        metadata: { status: row.status, files: parseJson(row.filesJson) },
      }),
    )
  }

  private buildErrorDocuments(context: TraceTurnContext): TraceDocumentInsert[] {
    const rows = this.handle.db.select().from(errors).where(eq(errors.turnId, context.turnId)).orderBy(errors.createdAt).all()
    return rows.map((row) =>
      makeTraceDocument({
        context,
        sourceKind: "error",
        sourceTable: "errors",
        sourceId: row.id,
        title: `Error ${row.code}`,
        summary: row.message,
        content: [
          `Source: ${row.source}`,
          `Code: ${row.code}`,
          `Message: ${row.message}`,
          row.detailsJson ? `Details: ${row.detailsJson}` : "",
          row.stack ? `Stack: ${truncateText(row.stack, 4_000).text}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        importance: "high",
        metadata: { source: row.source, code: row.code, recoverable: row.recoverable },
      }),
    )
  }

  private buildTurnSummaryDocument(context: TraceTurnContext, docs: TraceDocumentInsert[]): TraceDocumentInsert {
    const kinds = countBy(docs.map((doc) => doc.sourceKind))
    const messageSummary = docs.find((doc) => doc.sourceKind === "message")?.summary
    const content = [
      `Turn ${context.turnId} in conversation ${context.title ?? context.conversationId}`,
      `Status: ${context.status}`,
      messageSummary ? `User/assistant summary: ${messageSummary}` : "",
      `Indexed evidence: ${Object.entries(kinds)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(", ")}`,
      context.errorId ? `Error id: ${context.errorId}` : "",
    ]
      .filter(Boolean)
      .join("\n")
    return makeTraceDocument({
      context,
      sourceKind: "turn_summary",
      sourceTable: "turns",
      sourceId: context.turnId,
      title: `Turn summary: ${context.status}`,
      summary: summarizeText(content, 300),
      content,
      importance: context.status === "failed" ? "high" : "normal",
      metadata: { status: context.status, evidenceCounts: kinds },
    })
  }

  private resolveConversationIds(
    projectId: string,
    currentConversationId: string,
    scope: TraceRetrieveScope,
    conversationLimit: number,
    options: ResolveConversationOptions = {},
  ): string[] {
    const conversationOffset = options.conversationOffset ?? 0
    const dateWhere: string[] = []
    const dateParams: unknown[] = []
    if (options.updatedAfter) {
      dateWhere.push("updated_at >= ?")
      dateParams.push(options.updatedAfter)
    }
    if (options.updatedBefore) {
      dateWhere.push("updated_at <= ?")
      dateParams.push(options.updatedBefore)
    }
    if (options.conversationId) {
      const row = this.handle.sqlite
        .prepare(
          `SELECT id
           FROM conversations
           WHERE project_id = ?
             AND id = ?
             AND status IN ('active', 'archived')
             ${dateWhere.length > 0 ? `AND ${dateWhere.join(" AND ")}` : ""}
           LIMIT 1`,
        )
        .get(projectId, options.conversationId, ...dateParams) as { id: string } | undefined
      return row ? [row.id] : []
    }
    if (options.conversationTitle) {
      return this.resolveConversationIdsByTitle(projectId, currentConversationId, options.conversationTitle, {
        conversationLimit,
        conversationOffset,
        ...(options.conversationLimitProvided !== undefined ? { conversationLimitProvided: options.conversationLimitProvided } : {}),
        ...(options.updatedAfter ? { updatedAfter: options.updatedAfter } : {}),
        ...(options.updatedBefore ? { updatedBefore: options.updatedBefore } : {}),
      })
    }
    if (scope === "current_conversation") {
      return this.isVisibleConversation(projectId, currentConversationId) ? [currentConversationId] : []
    }
    const params: unknown[] = [projectId, currentConversationId, ...dateParams]
    const limitSql = scope === "recent_conversations" || options.conversationLimitProvided ? " LIMIT ?" : ""
    const offsetSql = conversationOffset > 0 ? " OFFSET ?" : ""
    if (limitSql) {
      params.push(conversationLimit)
    }
    if (conversationOffset > 0) {
      params.push(conversationOffset)
    }
    const rows = this.handle.sqlite
      .prepare(
        `SELECT id
         FROM conversations
         WHERE project_id = ?
           AND status IN ('active', 'archived')
           AND id != ?
           ${dateWhere.length > 0 ? `AND ${dateWhere.join(" AND ")}` : ""}
         ORDER BY updated_at DESC, id DESC${limitSql}${offsetSql}`,
      )
      .all(...params) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  private resolveConversationIdsByTitle(
    projectId: string,
    currentConversationId: string,
    conversationTitle: string,
    options: ResolveConversationOptions & { conversationLimit: number } = { conversationLimit: DEFAULT_CONVERSATION_LIMIT },
  ): string[] {
    const needle = normalizeConversationTitle(conversationTitle)
    if (!needle) {
      return []
    }
    const dateWhere: string[] = []
    const params: unknown[] = [projectId]
    if (options.updatedAfter) {
      dateWhere.push("updated_at >= ?")
      params.push(options.updatedAfter)
    }
    if (options.updatedBefore) {
      dateWhere.push("updated_at <= ?")
      params.push(options.updatedBefore)
    }
    params.push(500)
    const rows = this.handle.sqlite
      .prepare(
        `SELECT id, title
         FROM conversations
         WHERE project_id = ?
           AND status IN ('active', 'archived')
           ${dateWhere.length > 0 ? `AND ${dateWhere.join(" AND ")}` : ""}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{ id: string; title: string | null }>
    const conversationOffset = options.conversationOffset ?? 0
    const rankedLimit = options.conversationLimitProvided ? options.conversationLimit : DEFAULT_CONVERSATION_LIMIT
    const ranked = rows
      .map((row) => ({ row, normalizedTitle: normalizeConversationTitle(row.title ?? "") }))
      .filter(({ row, normalizedTitle }) => row.id !== currentConversationId && normalizedTitle)
      .flatMap(({ row, normalizedTitle }) => {
        if (normalizedTitle === needle) {
          return [{ row, rank: 0 }]
        }
        if (normalizedTitle.includes(needle)) {
          return [{ row, rank: 1 }]
        }
        if (needle.includes(normalizedTitle)) {
          return [{ row, rank: 2 }]
        }
        return []
      })
      .sort((left, right) => left.rank - right.rank)
      .slice(conversationOffset, conversationOffset + rankedLimit)
    return ranked.map(({ row }) => row.id)
  }

  private resolveOrdinalConversationIds(
    projectId: string,
    currentConversationId: string,
    scope: TraceRetrieveScope,
    conversationLimit: number,
    conversationTitle?: string,
    conversationId?: string,
    conversationOffset?: number,
    updatedAfter?: string,
    updatedBefore?: string,
  ): { conversationIds: string[]; warnings: string[] } {
    return {
      conversationIds: this.resolveConversationIds(projectId, currentConversationId, scope, conversationLimit, {
        ...(conversationTitle ? { conversationTitle } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(conversationOffset !== undefined ? { conversationOffset } : {}),
        conversationLimitProvided: conversationLimit !== DEFAULT_CONVERSATION_LIMIT,
        ...(updatedAfter ? { updatedAfter } : {}),
        ...(updatedBefore ? { updatedBefore } : {}),
      }),
      warnings: [],
    }
  }

  private findTurnByNumber(projectId: string, conversationId: string, turnNo: number): TurnOrdinalRow | undefined {
    return this.handle.sqlite
      .prepare(
        `SELECT
           t.id,
           t.conversation_id AS conversationId,
           t.status,
           t.started_at AS startedAt,
           t.completed_at AS completedAt,
           t.failed_at AS failedAt,
           t.cancelled_at AS cancelledAt,
           t.user_message_id AS userMessageId,
           t.assistant_message_id AS assistantMessageId
         FROM turns t
         INNER JOIN conversations c ON c.id = t.conversation_id
         WHERE c.project_id = ? AND c.status IN ('active', 'archived') AND t.conversation_id = ? AND t.user_message_id IS NOT NULL
         ORDER BY t.started_at ASC, t.id ASC
         LIMIT 1 OFFSET ?`,
      )
      .get(projectId, conversationId, turnNo - 1) as TurnOrdinalRow | undefined
  }

  private findMessageForTurnRole(projectId: string, turnId: string, role: Exclude<TraceRetrieveRole, "any">): MessageOrdinalRow | undefined {
    return this.handle.sqlite
      .prepare(
        `SELECT
           m.id,
           m.conversation_id AS conversationId,
           m.session_id AS sessionId,
           m.turn_id AS turnId,
           m.role,
           m.content,
           m.status,
           m.created_at AS createdAt,
           m.completed_at AS completedAt
         FROM messages m
         INNER JOIN conversations c ON c.id = m.conversation_id
         WHERE c.project_id = ? AND c.status IN ('active', 'archived') AND m.turn_id = ? AND m.role = ?
         ORDER BY m.created_at ASC, m.id ASC
         LIMIT 1`,
      )
      .get(projectId, turnId, role) as MessageOrdinalRow | undefined
  }

  private pairedUserReference(
    projectId: string,
    turnId: string,
    messageNo: number,
    query: string | undefined,
  ): { pairedUserMessageNo: number; pairedUserPreview: string } | undefined {
    const userMessage = this.findMessageForTurnRole(projectId, turnId, "user")
    return userMessage
      ? {
          pairedUserMessageNo: messageNo,
          pairedUserPreview: makeSnippet(userMessage.content, query),
        }
      : undefined
  }

  private searchResultFromRawMessage(
    projectId: string,
    currentConversationId: string,
    input: TraceRetrieveSearchInput,
    row: MessageOrdinalRow,
    turnNo: number,
  ): InternalTraceSearchResult {
    const conversation = this.conversationProvenance(projectId, currentConversationId, row.conversationId)
    const role = messageRole(row.role)
    const entryType = role === "user" ? "user_query" : role === "assistant" ? "assistant_response" : "continuation_summary"
    const pairedUser = role === "assistant" ? this.pairedUserReference(projectId, row.turnId, turnNo, input.query) : undefined
    return {
      text: makeSnippet(row.content, input.query),
      entryType,
      conversationTitle: conversation.title ?? "Untitled conversation",
      conversationId: row.conversationId,
      messageId: row.id,
      inspectArgs: { operation: "inspect" as const, messageId: row.id },
      ...(role === "user" || role === "assistant" ? { messageNo: turnNo } : {}),
      provenanceKind: "original_turn",
      ...pairedUser,
      rank: entryType === "continuation_summary" ? 2_000 : 0,
      createdAt: row.createdAt,
    }
  }

  private conversationProvenance(
    projectId: string,
    currentConversationId: string,
    conversationId: string,
  ): ConversationProvenance {
    const row = this.handle.sqlite
      .prepare(
        `SELECT id, title, status, updated_at AS updatedAt
         FROM conversations
         WHERE project_id = ? AND id = ? AND status IN ('active', 'archived')
         LIMIT 1`,
      )
      .get(projectId, conversationId) as ConversationRow | undefined
    if (!row) {
      return { id: conversationId, isCurrentConversation: conversationId === currentConversationId }
    }
    const status = conversationStatus(row.status)
    return {
      id: row.id,
      ...(row.title ? { title: row.title } : {}),
      ...(status ? { status } : {}),
      updatedAt: row.updatedAt,
      isCurrentConversation: row.id === currentConversationId,
    }
  }

  private findTurnNo(projectId: string, conversationId: string, turnId: string): number | undefined {
    const row = this.handle.sqlite
      .prepare(
        `SELECT ordered.turn_no AS turnNo
         FROM (
           SELECT t.id, ROW_NUMBER() OVER (ORDER BY t.started_at ASC, t.id ASC) AS turn_no
           FROM turns t
           INNER JOIN conversations c ON c.id = t.conversation_id
           WHERE c.project_id = ? AND c.status IN ('active', 'archived') AND t.conversation_id = ? AND t.user_message_id IS NOT NULL
         ) ordered
         WHERE ordered.id = ?
         LIMIT 1`,
      )
      .get(projectId, conversationId, turnId) as { turnNo: number } | undefined
    return row?.turnNo
  }

  private messageRoleForDocument(doc: Pick<TraceDocumentRow, "metadataJson">): "user" | "assistant" | "system" | "tool" | "developer" | undefined {
    const metadata = parseJson(doc.metadataJson)
    if (!metadata || typeof metadata !== "object") {
      return undefined
    }
    const role = (metadata as { role?: unknown }).role
    return typeof role === "string" ? messageRole(role) : undefined
  }

  private isVisibleConversation(projectId: string, conversationId: string): boolean {
    const row = this.handle.sqlite
      .prepare("SELECT 1 FROM conversations WHERE project_id = ? AND id = ? AND status IN ('active', 'archived') LIMIT 1")
      .get(projectId, conversationId)
    return Boolean(row)
  }

  private getVisibleTurnConversationId(projectId: string, turnId: string): string | undefined {
    const row = this.handle.sqlite
      .prepare(
        `SELECT t.conversation_id AS conversationId
         FROM turns t
         INNER JOIN conversations c ON c.id = t.conversation_id
         WHERE c.project_id = ? AND c.status IN ('active', 'archived') AND t.id = ?
         LIMIT 1`,
      )
      .get(projectId, turnId) as { conversationId: string } | undefined
    return row?.conversationId
  }

  private selectVisibleTraceDocuments(
    projectId: string,
    whereSql: string,
    params: unknown[],
    options: { orderBy?: string; limit?: number } = {},
  ): TraceDocumentRow[] {
    const allParams = [projectId, ...params]
    const limitSql = options.limit === undefined ? "" : " LIMIT ?"
    if (options.limit !== undefined) {
      allParams.push(options.limit)
    }
    return this.handle.sqlite
      .prepare(
        `SELECT ${traceDocumentSelect}
         FROM trace_documents td
         ${visibleTraceConversationJoin}
         WHERE td.project_id = ? AND ${whereSql}
         ORDER BY ${options.orderBy ?? "td.created_at ASC"}${limitSql}`,
      )
      .all(...allParams) as TraceDocumentRow[]
  }

  private findTraceDocumentForSource(projectId: string, sourceTable: string, sourceId: string): TraceDocumentRow | undefined {
    return this.selectVisibleTraceDocuments(projectId, "td.source_table = ? AND td.source_id = ?", [sourceTable, sourceId], {
      orderBy: "td.chunk_index ASC",
      limit: 1,
    })[0]
  }

  private searchTraceDocuments(
    projectId: string,
    input: {
      query: string
      mode: TraceRetrieveMode
      conversationIds: string[]
      sourceKinds?: TraceRetrieveSourceKind[]
      include: TraceRetrieveInclude[] | undefined
      toolNames: string[] | undefined
      paths: string[] | undefined
      command: string | undefined
      role: TraceRetrieveRole | undefined
      entryType: TraceRetrieveEntryType | undefined
      hasAttachment: boolean | undefined
      createdAfter: string | undefined
      createdBefore: string | undefined
      limit: number
    },
  ): SearchRow[] {
    if (input.conversationIds.length === 0) {
      return []
    }
    const params: unknown[] = [projectId]
    const where = ["td.project_id = ?"]
    if (input.conversationIds.length > 0) {
      where.push(`td.conversation_id IN (${input.conversationIds.map(() => "?").join(", ")})`)
      params.push(...input.conversationIds)
    }
    const sourceKinds = input.sourceKinds ?? sourceKindsForInclude(input.include)
    if (sourceKinds.length > 0) {
      where.push(`td.source_kind IN (${sourceKinds.map(() => "?").join(", ")})`)
      params.push(...sourceKinds)
    }
    appendMessageFacetFilters(where, params, input)
    if (input.createdAfter) {
      where.push("td.created_at >= ?")
      params.push(input.createdAfter)
    }
    if (input.createdBefore) {
      where.push("td.created_at <= ?")
      params.push(input.createdBefore)
    }
    if (input.toolNames && input.toolNames.length > 0) {
      where.push(`td.metadata_json LIKE ?`)
      params.push(`%"toolName"%`)
      where.push(`(${input.toolNames.map(() => "td.metadata_json LIKE ?").join(" OR ")})`)
      params.push(...input.toolNames.map((toolName) => `%"${toolName}"%`))
    }
    if (input.paths && input.paths.length > 0) {
      where.push(`(${input.paths.map(() => "td.metadata_json LIKE ? OR td.content LIKE ? OR td.title LIKE ?").join(" OR ")})`)
      for (const path of input.paths) {
        params.push(`%${path}%`, `%${path}%`, `%${path}%`)
      }
    }
    if (input.command) {
      where.push("(td.metadata_json LIKE ? OR td.content LIKE ? OR td.title LIKE ?)")
      params.push(`%${input.command}%`, `%${input.command}%`, `%${input.command}%`)
    }

    const match = makeFtsQuery(input.query)
    if (match) {
      params.push(match)
      params.push(input.limit)
      return this.handle.sqlite
        .prepare(
          `SELECT ${traceDocumentSelect}, bm25(trace_documents_fts) AS score
           FROM trace_documents_fts
           INNER JOIN trace_documents td ON td.id = trace_documents_fts.trace_document_id
           ${visibleTraceConversationJoin}
           WHERE ${where.join(" AND ")} AND trace_documents_fts MATCH ?
           ORDER BY score ASC, td.preserve_verbatim DESC, td.created_at DESC
           LIMIT ?`,
        )
        .all(...params) as SearchRow[]
    }

    params.push(input.limit)
    return this.handle.sqlite
      .prepare(
        `SELECT ${traceDocumentSelect}, NULL AS score
         FROM trace_documents td
         ${visibleTraceConversationJoin}
         WHERE ${where.join(" AND ")}
         ORDER BY td.preserve_verbatim DESC, td.created_at DESC
         LIMIT ?`,
      )
      .all(...params) as SearchRow[]
  }

  private async searchSemanticTraceDocuments(
    projectId: string,
    input: {
      query: string
      conversationIds: string[]
      sourceKinds?: TraceRetrieveSourceKind[]
      include: TraceRetrieveInclude[] | undefined
      toolNames: string[] | undefined
      paths: string[] | undefined
      command: string | undefined
      role: TraceRetrieveRole | undefined
      entryType: TraceRetrieveEntryType | undefined
      hasAttachment: boolean | undefined
      createdAfter: string | undefined
      createdBefore: string | undefined
      limit: number
      warnings: string[]
    },
  ): Promise<SearchRow[]> {
    if (!this.embeddingQueryProvider) {
      input.warnings.push(`Semantic trace retrieval is not available in this server process; using lexical/exact retrieval instead.`)
      return []
    }

    const queryEmbedding = await this.embeddingQueryProvider.embedTraceQuery(projectId, input.query)
    if (!queryEmbedding.ready || !queryEmbedding.embedding || !queryEmbedding.providerId || !queryEmbedding.modelId || !queryEmbedding.dimensions) {
      input.warnings.push(...(queryEmbedding.warnings ?? [`Semantic trace retrieval is not ready; using lexical/exact retrieval instead.`]))
      return []
    }

    const candidates = this.searchTraceDocumentCandidates(projectId, input, Math.max(input.limit * 25, 200))
    if (candidates.length === 0) {
      return []
    }
    const ids = candidates.map((candidate) => candidate.id)
    const embeddingRows = this.handle.sqlite
      .prepare(
        `SELECT trace_document_id AS traceDocumentId, content_hash AS contentHash, vector_json AS vectorJson
         FROM trace_embeddings
         WHERE provider_id = ?
           AND model_id = ?
           AND dimensions = ?
           AND status = 'completed'
           AND trace_document_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .all(queryEmbedding.providerId, queryEmbedding.modelId, queryEmbedding.dimensions, ...ids) as Array<{
      traceDocumentId: string
      contentHash: string
      vectorJson: string
    }>
    const embeddingByDocument = new Map(embeddingRows.map((row) => [row.traceDocumentId, row]))
    return candidates
      .flatMap((candidate) => {
        const embeddingRow = embeddingByDocument.get(candidate.id)
        if (!embeddingRow || embeddingRow.contentHash !== candidate.contentHash) {
          return []
        }
        const vector = parseNumberVector(embeddingRow.vectorJson)
        if (!vector || vector.length !== queryEmbedding.embedding?.length) {
          return []
        }
        return [{ ...candidate, score: 1 - cosineSimilarity(queryEmbedding.embedding, vector) }]
      })
      .sort((left, right) => scoreTraceRow(left, { query: input.query, command: input.command, paths: input.paths }) - scoreTraceRow(right, { query: input.query, command: input.command, paths: input.paths }))
      .slice(0, input.limit)
  }

  private searchTraceDocumentCandidates(
    projectId: string,
    input: {
      conversationIds: string[]
      sourceKinds?: TraceRetrieveSourceKind[]
      include: TraceRetrieveInclude[] | undefined
      toolNames: string[] | undefined
      paths: string[] | undefined
      command: string | undefined
      role: TraceRetrieveRole | undefined
      entryType: TraceRetrieveEntryType | undefined
      hasAttachment: boolean | undefined
      createdAfter: string | undefined
      createdBefore: string | undefined
    },
    limit: number,
  ): SearchRow[] {
    if (input.conversationIds.length === 0) {
      return []
    }
    const params: unknown[] = [projectId]
    const where = ["td.project_id = ?"]
    if (input.conversationIds.length > 0) {
      where.push(`td.conversation_id IN (${input.conversationIds.map(() => "?").join(", ")})`)
      params.push(...input.conversationIds)
    }
    const sourceKinds = input.sourceKinds ?? sourceKindsForInclude(input.include)
    if (sourceKinds.length > 0) {
      where.push(`td.source_kind IN (${sourceKinds.map(() => "?").join(", ")})`)
      params.push(...sourceKinds)
    }
    appendMessageFacetFilters(where, params, input)
    if (input.createdAfter) {
      where.push("td.created_at >= ?")
      params.push(input.createdAfter)
    }
    if (input.createdBefore) {
      where.push("td.created_at <= ?")
      params.push(input.createdBefore)
    }
    if (input.toolNames && input.toolNames.length > 0) {
      where.push(`td.metadata_json LIKE ?`)
      params.push(`%"toolName"%`)
      where.push(`(${input.toolNames.map(() => "td.metadata_json LIKE ?").join(" OR ")})`)
      params.push(...input.toolNames.map((toolName) => `%"${toolName}"%`))
    }
    if (input.paths && input.paths.length > 0) {
      where.push(`(${input.paths.map(() => "td.metadata_json LIKE ? OR td.content LIKE ? OR td.title LIKE ?").join(" OR ")})`)
      for (const path of input.paths) {
        params.push(`%${path}%`, `%${path}%`, `%${path}%`)
      }
    }
    if (input.command) {
      where.push("(td.metadata_json LIKE ? OR td.content LIKE ? OR td.title LIKE ?)")
      params.push(`%${input.command}%`, `%${input.command}%`, `%${input.command}%`)
    }
    params.push(limit)
    return this.handle.sqlite
      .prepare(
        `SELECT ${traceDocumentSelect}, NULL AS score
         FROM trace_documents td
         ${visibleTraceConversationJoin}
         WHERE ${where.join(" AND ")}
         ORDER BY td.preserve_verbatim DESC, td.created_at DESC
         LIMIT ?`,
      )
      .all(...params) as SearchRow[]
  }

  private resolveInspectDocuments(
    projectId: string,
    currentConversationId: string,
    input: Extract<TraceRetrieveToolInput, { operation: "inspect" }>,
  ): TraceDocumentRow[] {
    if (input.resultNumber) {
      const refs = this.recentSearchRefs.get(traceSearchRefKey(projectId, currentConversationId)) ?? []
      const ref = refs[input.resultNumber - 1]
      return ref ? this.resolveInspectDocuments(projectId, currentConversationId, ref) : []
    }
    if (input.query || input.turnNo || input.command || input.paths) {
      const query = input.query ?? input.command ?? input.paths?.join(" ") ?? `turn ${input.turnNo ?? ""}`.trim()
      const searchResult = this.searchOrdinalOrNaturalInspectCandidate(projectId, currentConversationId, input, query)
      const ref = searchResult?.inspectArgs
      return ref ? this.resolveInspectDocuments(projectId, currentConversationId, ref) : []
    }
    if (input.handle) {
      return this.selectVisibleTraceDocuments(projectId, "td.handle = ?", [input.handle], { limit: 1 })
    }
    if (input.messageId) {
      const docs = this.selectVisibleTraceDocuments(projectId, "td.source_table = 'messages' AND td.source_id = ?", [input.messageId])
      if (docs.length > 0) {
        return docs
      }
      const message = this.getRawMessage(projectId, input.messageId)
      return message ? [makeSyntheticSourceDocument(projectId, message.conversationId, message.turnId, "messages", message.id, `${capitalize(message.role)} message`, message.content)] : []
    }
    if (input.toolCallId) {
      const docs = this.selectVisibleTraceDocuments(projectId, "td.source_table = 'tool_calls' AND td.source_id = ?", [input.toolCallId])
      if (docs.length > 0) {
        return docs
      }
      const toolCall = this.getRawToolCall(projectId, input.toolCallId)
      return toolCall
        ? [
            makeSyntheticSourceDocument(
              projectId,
              toolCall.conversationId,
              toolCall.turnId,
              "tool_calls",
              toolCall.id,
              `${toolCall.toolName} tool ${toolCall.status}`,
              [
                `Tool: ${toolCall.toolName}`,
                `Status: ${toolCall.status}`,
                `Arguments: ${toolCall.argumentsJson}`,
                toolCall.resultJson ? `Result: ${toolCall.resultJson}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            ),
          ]
        : []
    }
    if (input.turnId) {
      const docs = this.selectVisibleTraceDocuments(projectId, "td.turn_id = ?", [input.turnId], {
        orderBy: "td.created_at ASC",
        limit: 1,
      })
      if (docs.length > 0) {
        return docs
      }
      const conversationId = this.getVisibleTurnConversationId(projectId, input.turnId)
      return conversationId
        ? [
            makeSyntheticSourceDocument(
              projectId,
              conversationId,
              input.turnId,
              "turns",
              input.turnId,
              "Turn bundle",
              this.buildTurnBundle(projectId, input.turnId, input.include),
            ),
          ]
        : []
    }
    if (input.conversationId) {
      const conversation = this.handle.db
        .select({ id: conversations.id, title: conversations.title })
        .from(conversations)
        .where(and(eq(conversations.projectId, projectId), eq(conversations.id, input.conversationId), inArray(conversations.status, [...VISIBLE_CONVERSATION_STATUSES])))
        .limit(1)
        .all()[0]
      return conversation
        ? [
            makeSyntheticSourceDocument(
              projectId,
              conversation.id,
              undefined,
              "conversations",
              conversation.id,
              `Conversation bundle: ${conversation.title ?? conversation.id}`,
              this.buildConversationBundle(projectId, conversation.id, input.include, input.startTurnNo ?? 1, input.turnLimit ?? DEFAULT_TURN_LIMIT),
            ),
          ]
        : []
    }
    return []
  }

  private getRawMessage(projectId: string, messageId: string): MessageOrdinalRow | undefined {
    return this.handle.sqlite
      .prepare(
        `SELECT
           m.id,
           m.conversation_id AS conversationId,
           m.session_id AS sessionId,
           m.turn_id AS turnId,
           m.role,
           m.content,
           m.status,
           m.created_at AS createdAt,
           m.completed_at AS completedAt
         FROM messages m
         INNER JOIN conversations c ON c.id = m.conversation_id
         WHERE c.project_id = ? AND c.status IN ('active', 'archived') AND m.id = ?
         LIMIT 1`,
      )
      .get(projectId, messageId) as MessageOrdinalRow | undefined
  }

  private getRawToolCall(
    projectId: string,
    toolCallId: string,
  ): { id: string; conversationId: string; turnId: string; toolName: string; status: string; argumentsJson: string; resultJson: string | null } | undefined {
    return this.handle.sqlite
      .prepare(
        `SELECT
           tc.id,
           tc.conversation_id AS conversationId,
           tc.turn_id AS turnId,
           tc.tool_name AS toolName,
           tc.status,
           tc.arguments_json AS argumentsJson,
           tc.result_json AS resultJson
         FROM tool_calls tc
         INNER JOIN conversations c ON c.id = tc.conversation_id
         WHERE c.project_id = ? AND c.status IN ('active', 'archived') AND tc.id = ?
         LIMIT 1`,
      )
      .get(projectId, toolCallId) as
      | { id: string; conversationId: string; turnId: string; toolName: string; status: string; argumentsJson: string; resultJson: string | null }
      | undefined
  }

  private buildTurnBundle(projectId: string, turnId: string, include?: TraceRetrieveInclude[]): string {
    const parts: string[] = []
    const sourceKinds = sourceKindsForInclude(include)
    const includeKind = (kind: TraceRetrieveSourceKind): boolean =>
      sourceKinds.length === 0 ? kind === "message" || kind === "verbatim_anchor" : sourceKinds.includes(kind)
    const messageRows = includeKind("message")
      ? (this.handle.sqlite
          .prepare(
            `SELECT m.role, m.status, m.content, m.created_at
             FROM messages m
             INNER JOIN conversations c ON c.id = m.conversation_id
             WHERE c.project_id = ? AND c.status IN ('active', 'archived') AND m.turn_id = ?
             ORDER BY m.created_at`,
          )
          .all(projectId, turnId) as Array<{ role: string; status: string; content: string; created_at: string }>)
      : []
    for (const row of messageRows) {
      parts.push(`[message ${row.role} ${row.status} ${row.created_at}]\n${row.content}`)
    }
    const toolRows = includeKind("tool_call")
      ? (this.handle.sqlite
          .prepare(
            `SELECT tc.tool_name, tc.status, tc.arguments_json, tc.result_json, tc.started_at, tc.completed_at
             FROM tool_calls tc
             INNER JOIN conversations c ON c.id = tc.conversation_id
             WHERE c.project_id = ? AND c.status IN ('active', 'archived') AND tc.turn_id = ?
             ORDER BY tc.started_at`,
          )
          .all(projectId, turnId) as Array<{
          tool_name: string
          status: string
          arguments_json: string
          result_json: string | null
          started_at: string | null
          completed_at: string | null
        }>)
      : []
    for (const row of toolRows) {
      parts.push(
        `[tool ${row.tool_name} ${row.status} ${row.started_at ?? ""}]\narguments: ${row.arguments_json}\nresult: ${row.result_json ?? ""}`,
      )
    }
    const errorRows = includeKind("error")
      ? (this.handle.sqlite
          .prepare(
            `SELECT e.code, e.message, e.details_json, e.created_at
             FROM errors e
             INNER JOIN conversations c ON c.id = e.conversation_id
             WHERE c.project_id = ? AND c.status IN ('active', 'archived') AND e.turn_id = ?
             ORDER BY e.created_at`,
          )
          .all(projectId, turnId) as Array<{ code: string; message: string; details_json: string | null; created_at: string }>)
      : []
    for (const row of errorRows) {
      parts.push(`[error ${row.code} ${row.created_at}]\n${row.message}\n${row.details_json ?? ""}`)
    }
    return parts.join("\n\n")
  }

  private buildConversationBundle(
    projectId: string,
    conversationId: string,
    include: TraceRetrieveInclude[] | undefined,
    startTurnNo: number,
    turnLimit: number,
  ): string {
    const turns = this.handle.sqlite
      .prepare(
        `SELECT t.id, t.status, t.started_at AS startedAt
         FROM turns t
         INNER JOIN conversations c ON c.id = t.conversation_id
         WHERE c.project_id = ? AND c.status IN ('active', 'archived') AND t.conversation_id = ? AND t.user_message_id IS NOT NULL
         ORDER BY t.started_at ASC, t.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(projectId, conversationId, turnLimit, startTurnNo - 1) as Array<{ id: string; status: string; startedAt: string }>
    const parts: string[] = []
    for (const [index, turn] of turns.entries()) {
      const turnNo = startTurnNo + index
      const bundle = this.buildTurnBundle(projectId, turn.id, include)
      parts.push(`[turn ${turnNo} ${turn.status} ${turn.startedAt} id=${turn.id}]\n${bundle}`)
    }
    return parts.join("\n\n")
  }
}

const makeTraceDocument = (input: {
  context: TraceTurnContext
  sourceKind: TraceRetrieveSourceKind
  sourceTable: string
  sourceId: string
  title: string
  summary?: string
  content: string
  importance?: "low" | "normal" | "high" | "critical"
  preserveVerbatim?: boolean
  chunkIndex?: number
  metadata?: unknown
}): TraceDocumentInsert => {
  const now = nowIso()
  const id = createId("tdoc")
  return {
    id,
    projectId: input.context.projectId,
    conversationId: input.context.conversationId,
    turnId: input.context.turnId,
    sourceKind: input.sourceKind,
    sourceTable: input.sourceTable,
    sourceId: input.sourceId,
    handle: id,
    title: input.title,
    summary: input.summary,
    content: input.content,
    contentHash: hashText(input.content),
    importance: input.importance ?? "normal",
    preserveVerbatim: input.preserveVerbatim ?? false,
    chunkIndex: input.chunkIndex,
    tokenCountEstimate: estimateTokens(input.content),
    metadataJson: input.metadata === undefined ? undefined : JSON.stringify(input.metadata),
    createdAt: now,
    updatedAt: now,
  }
}

const makeSyntheticSourceDocument = (
  projectId: string,
  conversationId: string,
  turnId: string | undefined,
  sourceTable: string,
  sourceId: string,
  title: string,
  content: string,
): TraceDocumentRow => {
  const now = nowIso()
  return {
    id: `synthetic_${sourceId}`,
    projectId,
    conversationId,
    turnId: turnId ?? null,
    sourceKind:
      sourceTable === "messages"
        ? "message"
        : sourceTable === "tool_calls"
          ? "tool_call"
          : sourceTable === "context_compaction_snapshots"
            ? "conversation_summary"
            : "turn_summary",
    sourceTable,
    sourceId,
    handle: `${sourceTable}:${sourceId}`,
    title,
    summary: summarizeText(content, 240),
    content,
    contentHash: hashText(content),
    importance: "normal",
    preserveVerbatim: false,
    chunkIndex: null,
    tokenCountEstimate: estimateTokens(content),
    metadataJson: null,
    createdAt: now,
    updatedAt: now,
  }
}

const parseJson = (text: string | null): unknown => {
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const previewJson = (value: unknown, limit: number): string => truncateText(typeof value === "string" ? value : JSON.stringify(value, null, 2), limit).text

const hashText = (text: string): string => createHash("sha256").update(text).digest("hex")

const estimateTokens = (text: string): number => estimateTextTokens(text).inputTokens

const truncationFor = (text: string, charLimit: number) => ({
  truncated: text.length > charLimit,
  charLimit,
  originalLength: text.length,
  returnedLength: Math.min(text.length, charLimit),
})

const truncateText = (text: string, charLimit: number): { text: string; truncated: boolean } => {
  if (text.length <= charLimit) {
    return { text, truncated: false }
  }
  return { text: text.slice(0, charLimit), truncated: true }
}

const truncateInline = (text: string, limit: number): string => {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized
}

const summarizeText = (text: string, limit: number): string => truncateInline(text, limit)

const chunkText = (text: string): string[] => {
  if (text.length <= CHUNK_SIZE) {
    return [text]
  }
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length)
    chunks.push(text.slice(start, end))
    if (end === text.length) {
      break
    }
    start = Math.max(end - CHUNK_OVERLAP, start + 1)
  }
  return chunks
}

const shouldCreateVerbatimAnchor = (content: string): boolean => {
  if (content.length < 1_500) {
    return false
  }
  return /\b(rubric|follow this exactly|use this throughout|source of truth|canonical|rules|template|format|do not change|must preserve|exact wording)\b/i.test(
    content,
  )
}

const summarizeTool = (toolName: string, status: string, result: unknown): string => {
  if (typeof result === "object" && result !== null) {
    if ("summary" in result && typeof result.summary === "string") {
      return result.summary
    }
    if ("totalMatches" in result && typeof result.totalMatches === "number") {
      return `${toolName} ${status}; found ${result.totalMatches} matches.`
    }
    if ("changedFiles" in result && Array.isArray(result.changedFiles)) {
      return `${toolName} ${status}; changed ${result.changedFiles.length} files.`
    }
  }
  return `${toolName} ${status}.`
}

const metadataText = (metadataJson: string | undefined): string => {
  if (!metadataJson) {
    return ""
  }
  return metadataJson
}

const makeFtsQuery = (query: string): string => {
  const terms = query
    .toLowerCase()
    .match(/[a-z0-9_./:-]+/g)
    ?.filter((term) => term.length > 1)
    .slice(0, 8)
  if (!terms || terms.length === 0) {
    return ""
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
}

const makeSnippet = (content: string, query: string | undefined): string => {
  const anchor = bestSnippetAnchor(content, query)
  const lineBounds = snippetLineBounds(content, anchor, SNIPPET_CONTEXT_LINES)
  let start = lineBounds.start
  let end = lineBounds.end
  if (end - start < SNIPPET_MIN_CHARS) {
    const target = Math.min(SNIPPET_MIN_CHARS, content.length)
    const center = Math.min(Math.max(anchor, start), end)
    start = Math.max(0, center - Math.floor(target / 2))
    end = Math.min(content.length, start + target)
    start = Math.max(0, end - target)
  }
  if (end - start > SNIPPET_MAX_CHARS) {
    start = Math.max(0, anchor - Math.floor(SNIPPET_MAX_CHARS / 2))
    end = Math.min(content.length, start + SNIPPET_MAX_CHARS)
    start = Math.max(0, end - SNIPPET_MAX_CHARS)
  }
  const prefix = start > 0 ? "..." : ""
  const suffix = end < content.length ? "..." : ""
  return `${prefix}${content.slice(start, end)}${suffix}`
}

const bestSnippetAnchor = (content: string, query: string | undefined): number => {
  if (!query) {
    return 0
  }
  const lower = content.toLowerCase()
  const normalizedQuery = normalizeSnippetText(query)
  const exactPhrase = normalizedQuery.length >= 8 ? lower.indexOf(normalizedQuery) : -1
  if (exactPhrase >= 0) {
    return exactPhrase
  }

  const terms = query.toLowerCase().match(/[a-z0-9_./:-]+/g)?.filter((term) => term.length > 2) ?? []
  if (terms.length === 0) {
    return 0
  }
  const phraseAnchor = bestContiguousPhraseAnchor(lower, terms)
  if (phraseAnchor >= 0) {
    return phraseAnchor
  }
  const tokenAnchors = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0)
  if (tokenAnchors.length === 0) {
    return 0
  }
  const scored = tokenAnchors.map((position) => ({
    position,
    score: terms.filter((term) => lower.slice(Math.max(0, position - 400), Math.min(lower.length, position + 1_200)).includes(term)).length,
  }))
  scored.sort((left, right) => right.score - left.score || left.position - right.position)
  return scored[0]?.position ?? 0
}

const bestContiguousPhraseAnchor = (lowerContent: string, terms: string[]): number => {
  const maxTerms = Math.min(terms.length, 12)
  for (let size = maxTerms; size >= 2; size -= 1) {
    for (let start = 0; start + size <= terms.length; start += 1) {
      const phrase = terms.slice(start, start + size).join(" ")
      const index = lowerContent.indexOf(phrase)
      if (index >= 0) {
        return index
      }
    }
  }
  return -1
}

const normalizeSnippetText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim()

const snippetLineBounds = (content: string, anchor: number, contextLines: number, floor = 0, ceiling = content.length): { start: number; end: number } => {
  const lineStarts = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n" && index + 1 < content.length) {
      lineStarts.push(index + 1)
    }
  }
  const boundedAnchor = Math.min(Math.max(anchor, floor), Math.max(floor, ceiling - 1))
  const lineIndex = Math.max(0, findLineIndex(lineStarts, boundedAnchor))
  const startLine = Math.max(0, lineIndex - contextLines)
  const endLine = Math.min(lineStarts.length - 1, lineIndex + contextLines)
  const start = Math.max(floor, lineStarts[startLine] ?? 0)
  const end = Math.min(ceiling, endLine + 1 < lineStarts.length ? (lineStarts[endLine + 1] ?? content.length) : content.length)
  return { start, end }
}

const findLineIndex = (lineStarts: number[], offset: number): number => {
  let low = 0
  let high = lineStarts.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const start = lineStarts[mid] ?? 0
    const next = lineStarts[mid + 1] ?? Number.POSITIVE_INFINITY
    if (offset >= start && offset < next) {
      return mid
    }
    if (offset < start) {
      high = mid - 1
    } else {
      low = mid + 1
    }
  }
  return 0
}

const sourceKindsForInclude = (include: TraceRetrieveInclude[] | undefined): TraceRetrieveSourceKind[] => {
  if (!include || include.length === 0) {
    return []
  }
  const kinds = new Set<TraceRetrieveSourceKind>()
  for (const item of include) {
    if (item === "messages") {
      kinds.add("message")
      kinds.add("verbatim_anchor")
    }
    if (item === "summaries") {
      kinds.add("turn_summary")
      kinds.add("conversation_summary")
    }
    if (item === "tool_calls" || item === "decisions") {
      kinds.add("tool_call")
    }
    if (item === "shell") {
      kinds.add("shell")
    }
    if (item === "files") {
      kinds.add("file")
      kinds.add("patch")
    }
    if (item === "errors") {
      kinds.add("error")
    }
  }
  return [...kinds]
}

const normalSourceKindsForInclude = (include: TraceRetrieveInclude[] | undefined): TraceRetrieveSourceKind[] => {
  const requested = sourceKindsForInclude(include)
  const allowed = new Set<TraceRetrieveSourceKind>(["message", "verbatim_anchor", "turn_summary", "conversation_summary"])
  return requested.length === 0 ? [...allowed] : requested.filter((kind) => allowed.has(kind))
}

const runtimeIncludeItems = new Set<TraceRetrieveInclude>(["tool_calls", "shell", "files", "errors"])

const requiresAuditMode = (input: TraceRetrieveSearchInput): boolean =>
  Boolean(
    input.toolNames?.length ||
      input.command ||
      input.paths?.length ||
      input.include?.some((item) => runtimeIncludeItems.has(item)) ||
      (input.entryType !== undefined && runtimeEntryTypes.has(input.entryType)),
  )

const runtimeEntryTypes = new Set<TraceRetrieveEntryType>(["tool_call", "shell", "file", "patch", "error"])

const appendMessageFacetFilters = (
  where: string[],
  params: unknown[],
  input: {
    role: TraceRetrieveRole | undefined
    entryType: TraceRetrieveEntryType | undefined
    hasAttachment: boolean | undefined
  },
): void => {
  if (input.role === "user" || input.role === "assistant") {
    where.push("td.metadata_json LIKE ?")
    params.push(`%"role":"${input.role}"%`)
  }
  if (input.entryType === "user_query") {
    where.push("td.source_table = 'messages'")
    where.push("td.metadata_json LIKE ?")
    params.push(`%"role":"user"%`)
  } else if (input.entryType === "assistant_response") {
    where.push("td.source_table = 'messages'")
    where.push("td.metadata_json LIKE ?")
    params.push(`%"role":"assistant"%`)
  } else if (input.entryType === "continuation_summary") {
    where.push("(td.source_kind IN ('turn_summary', 'conversation_summary') OR (td.source_table = 'messages' AND td.metadata_json NOT LIKE ? AND td.metadata_json NOT LIKE ?))")
    params.push(`%"role":"user"%`, `%"role":"assistant"%`)
  } else if (input.entryType === "tool_call") {
    where.push("td.source_kind = 'tool_call'")
  } else if (input.entryType === "shell") {
    where.push("td.source_kind = 'shell'")
  } else if (input.entryType === "file") {
    where.push("td.source_kind = 'file'")
  } else if (input.entryType === "patch") {
    where.push("td.source_kind = 'patch'")
  } else if (input.entryType === "error") {
    where.push("td.source_kind = 'error'")
  }
  if (input.hasAttachment === true) {
    where.push("td.source_table = 'messages'")
    where.push("json_extract(td.metadata_json, '$.attachmentCount') > 0")
  } else if (input.hasAttachment === false) {
    where.push("(td.metadata_json IS NULL OR COALESCE(json_extract(td.metadata_json, '$.attachmentCount'), 0) = 0)")
  }
}

const parseMetadataRecord = (metadataJson: string | null): Record<string, unknown> => {
  const parsed = parseJson(metadataJson)
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

const isSecondaryMention = (row: Pick<TraceDocumentRow, "metadataJson" | "content">): boolean => {
  const metadata = parseMetadataRecord(row.metadataJson)
  const role = typeof metadata.role === "string" ? metadata.role : undefined
  if (role !== "assistant") {
    return false
  }
  return /\b(previous conversation|last conversation|conversation was titled|i found traces|i found trace|trace_retrieve|from earlier|you shared previously|screenshots you shared previously)\b/i.test(
    row.content,
  )
}

const provenanceQualityForMatchedRow = (
  row: Pick<TraceDocumentRow, "sourceKind" | "metadataJson" | "content">,
): "original_turn" | "attachment_origin" | "secondary_mention" | "continuation_summary" | "audit_event" => {
  if (row.sourceKind === "tool_call" || row.sourceKind === "shell" || row.sourceKind === "file" || row.sourceKind === "patch" || row.sourceKind === "error") {
    return "audit_event"
  }
  const metadata = parseMetadataRecord(row.metadataJson)
  if (typeof metadata.attachmentCount === "number" && metadata.attachmentCount > 0) {
    return "attachment_origin"
  }
  if (isSecondaryMention(row)) {
    return "secondary_mention"
  }
  if (row.sourceKind === "turn_summary" || row.sourceKind === "conversation_summary") {
    return "continuation_summary"
  }
  return "original_turn"
}

const provenanceKindForTraceDocument = (row: Pick<TraceDocumentRow, "sourceKind" | "metadataJson" | "sourceTable" | "content">): TraceRetrieveProvenanceKind =>
  provenanceQualityForMatchedRow(row)

const appendProvenanceWarnings = (warnings: string[], results: InternalTraceSearchResult[], query: string | undefined): void => {
  if (results.length === 0) {
    return
  }
  const provenanceKinds = new Set(results.map((result) => ("provenanceKind" in result ? result.provenanceKind : undefined)).filter(Boolean))
  const hasOriginalEvidence = provenanceKinds.has("original_turn") || provenanceKinds.has("attachment_origin")
  if (!hasOriginalEvidence) {
    warnings.push(
      "Only secondary mentions, summaries, or audit evidence matched. Do not treat these rows as original source provenance; if the user asked for an origin, report that no visible original conversation source was found.",
    )
  }
  if (looksLikeAttachmentProvenanceQuery(query) && !provenanceKinds.has("attachment_origin")) {
    warnings.push(
      "No original visible message attachment provenance matched this image/attachment query. Attachment files or later mentions can outlive deleted conversations and are not proof of the source conversation.",
    )
  }
}

const looksLikeAttachmentProvenanceQuery = (query: string | undefined): boolean =>
  Boolean(query && /\b(attachment|attachments|screenshot|screenshots|image|images|photo|png|jpe?g|webp|gif|\.socrates\/attachments)\b/i.test(query))

const provenanceQualityWeight = (quality: string | undefined): number => {
  if (quality === "attachment_origin") return 0
  if (quality === "original_turn") return 1
  if (quality === "continuation_summary") return 2
  if (quality === "secondary_mention") return 3
  if (quality === "audit_event") return 4
  return 5
}

type TraceRankInput = {
  query?: string | undefined
  command?: string | undefined
  paths?: string[] | undefined
}

const memoryRank = (row: SearchRow, input: TraceRankInput): number =>
  provenanceQualityWeight(provenanceQualityForMatchedRow(row)) * 1000 + scoreTraceRow(row, input)

const entryTypeForTraceDocument = (
  row: Pick<TraceDocumentRow, "sourceKind" | "sourceTable">,
  messageRole: "user" | "assistant" | "system" | "tool" | "developer" | undefined,
): TraceMessageEntryType => {
  if (row.sourceTable === "messages") {
    if (messageRole === "user") return "user_query"
    if (messageRole === "assistant") return "assistant_response"
    return "continuation_summary"
  }
  if (row.sourceKind === "tool_call") return "tool_call"
  if (row.sourceKind === "shell") return "shell"
  if (row.sourceKind === "file") return "file"
  if (row.sourceKind === "patch") return "patch"
  if (row.sourceKind === "error") return "error"
  return "continuation_summary"
}

const entryTypeWeight = (entryType: TraceRetrieveEntryType): number => {
  if (entryType === "qa_pair") return 0
  if (entryType === "user_query" || entryType === "assistant_response") return 0
  if (entryType === "continuation_summary") return 1
  return 2
}

const messageNoForMatchedMessage = (
  turnNo: number | undefined,
  messageRole: "user" | "assistant" | "system" | "tool" | "developer" | undefined,
): number | undefined => {
  return turnNo && (messageRole === "user" || messageRole === "assistant") ? turnNo : undefined
}

const publicTraceSearchResults = (results: Array<InternalTraceSearchResult & { resultNumber: number }>): TraceRetrieveToolOutput["results"] =>
  results.map(({ inspectArgs: _inspectArgs, rank: _rank, createdAt: _createdAt, ...result }) => result)

const messageRole = (value: string): "user" | "assistant" | "system" | "tool" | "developer" | undefined =>
  value === "user" || value === "assistant" || value === "system" || value === "tool" || value === "developer" ? value : undefined

const conversationStatus = (value: string): "active" | "archived" | "deleted" | undefined =>
  value === "active" || value === "archived" || value === "deleted" ? value : undefined

const inspectArgsForSource = (handle: string, sourceTable: string, sourceId: string, turnId: string | null) => {
  if (sourceTable === "messages") {
    return { operation: "inspect" as const, messageId: sourceId }
  }
  if (sourceTable === "tool_calls") {
    return { operation: "inspect" as const, toolCallId: sourceId }
  }
  if (sourceTable === "turns" && turnId) {
    return { operation: "inspect" as const, turnId }
  }
  return { operation: "inspect" as const, handle }
}

const traceSearchRefKey = (projectId: string, currentConversationId: string): string => `${projectId}:${currentConversationId}`

const scoreTraceRow = (row: SearchRow, input: TraceRankInput): number => {
  let score = row.score ?? 0
  if (row.preserveVerbatim) {
    score -= 2
  }
  if (input.command && JSON.stringify(row).includes(input.command)) {
    score -= 1
  }
  if (input.paths?.some((path) => JSON.stringify(row).includes(path))) {
    score -= 1
  }
  return Math.round(score * 1000) / 1000
}

const mergeSearchRows = (rows: SearchRow[], limit: number): SearchRow[] => {
  const bestById = new Map<string, SearchRow>()
  for (const row of rows) {
    const existing = bestById.get(row.id)
    if (!existing || (row.score ?? 0) < (existing.score ?? 0)) {
      bestById.set(row.id, row)
    }
  }
  return [...bestById.values()]
    .sort((left, right) => {
      const scoreDelta = (left.score ?? 0) - (right.score ?? 0)
      if (scoreDelta !== 0) {
        return scoreDelta
      }
      if (left.preserveVerbatim !== right.preserveVerbatim) {
        return left.preserveVerbatim ? -1 : 1
      }
      return right.createdAt.localeCompare(left.createdAt)
    })
    .slice(0, limit)
}

const parseNumberVector = (value: string): number[] | undefined => {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : undefined
  } catch {
    return undefined
  }
}

const cosineSimilarity = (left: number[], right: number[]): number => {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

const countBy = (values: string[]): Record<string, number> =>
  values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1
    return counts
  }, {})

const normalizeConversationTitle = (title: string): string =>
  title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const capitalize = (text: string): string => (text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`)

const appendMessageAttachmentReferences = (content: string, attachments: MessageAttachmentRow[]): string => {
  if (attachments.length === 0) {
    return content
  }
  const reference = [
    "Attached image files are stored in the workspace and can be reopened with the read tool:",
    ...attachments.map(
      (attachment) =>
        `- ${attachment.fileName}: ${attachmentReferencePath(attachment.uri)} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
    ),
  ].join("\n")
  return content.trim() ? `${content}\n\n${reference}` : reference
}

const attachmentReferencePath = (uri: string): string => {
  const normalized = uri.replaceAll("\\", "/")
  const marker = "/.socrates/"
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + 1)
  }
  const parts = normalized.split("/")
  return parts[parts.length - 1] ?? uri
}
