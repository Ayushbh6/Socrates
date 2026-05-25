import { createHash } from "node:crypto"
import type {
  TraceRetrieveInclude,
  TraceRetrieveInspectInput,
  TraceRetrieveMode,
  TraceRetrieveSearchInput,
  TraceRetrieveScope,
  TraceRetrieveSourceKind,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
} from "@socrates/contracts"
import { createId, nowIso } from "@socrates/shared"
import { and, desc, eq, inArray } from "drizzle-orm"
import {
  approvals,
  conversations,
  errors,
  fileOperations,
  messages,
  patches,
  shellCommands,
  shellOutputChunks,
  toolCalls,
  traceDocuments,
  traceIndexJobs,
} from "../../db/schema"
import { StoreBase } from "./shared"

const DEFAULT_LIMIT = 8
const DEFAULT_CHAR_LIMIT = 20_000
const DEFAULT_CONVERSATION_LIMIT = 10
const DEFAULT_DATE_WINDOW_DAYS = 3
const CHUNK_SIZE = 6_000
const CHUNK_OVERLAP = 300

type TraceDocumentInsert = typeof traceDocuments.$inferInsert
type TraceDocumentRow = typeof traceDocuments.$inferSelect

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

  retrieve(projectId: string, currentConversationId: string, input: TraceRetrieveToolInput): TraceRetrieveToolOutput {
    if (input.operation === "inspect") {
      return this.inspect(projectId, currentConversationId, input)
    }
    return this.search(projectId, currentConversationId, input)
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

  private search(
    projectId: string,
    currentConversationId: string,
    input: TraceRetrieveSearchInput,
  ): TraceRetrieveToolOutput {
    const scope = input.scope ?? "current_conversation"
    const mode = input.mode ?? "combined"
    const limit = input.limit ?? DEFAULT_LIMIT
    const conversationLimit = input.conversationLimit ?? DEFAULT_CONVERSATION_LIMIT
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const include = input.include
    const warnings: string[] = []
    const defaultDateWindowApplied = !input.conversationHint && !input.createdAfter && !input.createdBefore
    const createdAfter = input.createdAfter ?? (defaultDateWindowApplied ? daysAgoIso(DEFAULT_DATE_WINDOW_DAYS) : undefined)
    const createdBefore = input.createdBefore

    if (scope === "current_conversation" && defaultDateWindowApplied) {
      warnings.push(
        `Only viewing the current chat from the past 3 days. Use scope="recent_conversations" or "project", conversationHint, or date filters to widen.`,
      )
    } else if (scope === "current_conversation") {
      warnings.push(`Only viewing the current chat. Use scope="recent_conversations" or "project" to widen.`)
    } else if (defaultDateWindowApplied) {
      warnings.push(`Only viewing trace evidence from the past 3 days. Use conversationHint or date filters to widen.`)
    }
    if (mode === "semantic") {
      warnings.push(`Semantic trace retrieval is not indexed yet; using lexical/exact retrieval instead.`)
    }
    if (input.includeRaw) {
      warnings.push(`Search returns compact snippets only. Use operation="inspect" with a returned handle for exact source text.`)
    }

    const conversationIds = this.resolveConversationIds(projectId, currentConversationId, scope, conversationLimit, input.conversationHint)
    const rows = this.searchTraceDocuments(projectId, {
      query: input.query,
      mode,
      conversationIds,
      include,
      toolNames: input.toolNames,
      paths: input.paths,
      command: input.command,
      createdAfter,
      createdBefore,
      limit,
    })

    const results = rows.map((row) => ({
      handle: row.handle,
      kind: normalizeResultKind(row.sourceKind),
      projectId: row.projectId,
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      ...(row.turnId ? { turnId: row.turnId } : {}),
      sourceId: row.sourceId,
      title: row.title,
      snippet: makeSnippet(row.content, input.query),
      ...(row.summary ? { summary: row.summary } : {}),
      score: scoreTraceRow(row, { query: input.query, command: input.command, paths: input.paths }),
      ...(row.preserveVerbatim ? { preserveVerbatim: true } : {}),
      createdAt: row.createdAt,
      ...(row.metadataJson ? { metadata: parseJson(row.metadataJson) } : {}),
    }))

    const text = JSON.stringify(results)
    return {
      results,
      totalMatches: results.length,
      truncation: truncationFor(text, charLimit),
      appliedFilters: {
        operation: "search",
        scope,
        mode,
        conversationLimit,
        conversationIds,
        ...(createdAfter ? { createdAfter } : {}),
        ...(createdBefore ? { createdBefore } : {}),
        ...(defaultDateWindowApplied ? { defaultDateWindowApplied: true } : {}),
        ...(include ? { include } : {}),
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    }
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
      const content = input.turnId && !input.handle ? this.buildTurnBundle(projectId, input.turnId, include) : doc.content
      const truncated = truncateText(content, charLimit)
      return {
        handle: doc.handle,
        kind: "exact_source" as const,
        projectId: doc.projectId,
        ...(doc.conversationId ? { conversationId: doc.conversationId } : {}),
        ...(doc.turnId ? { turnId: doc.turnId } : {}),
        sourceId: doc.sourceId,
        title: doc.title,
        content: truncated.text,
        source: { table: doc.sourceTable, id: doc.sourceId },
        truncation: {
          truncated: truncated.truncated,
          charLimit,
          originalLength: content.length,
          returnedLength: truncated.text.length,
          ...(truncated.truncated ? { nextOffset: truncated.text.length } : {}),
        },
        ...(doc.metadataJson ? { metadata: parseJson(doc.metadataJson) } : {}),
      }
    })
    const text = JSON.stringify(results)
    return {
      results,
      totalMatches: results.length,
      truncation: truncationFor(text, charLimit),
      appliedFilters: {
        operation: "inspect",
        ...(include ? { include } : {}),
      },
      warnings: results.length === 0 ? [`No trace source matched the inspect handle or id in this project.`] : undefined,
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
    const docs: TraceDocumentInsert[] = []
    for (const row of rows) {
      const chunks = chunkText(row.content)
      chunks.forEach((chunk, index) => {
        docs.push(
          makeTraceDocument({
            context,
            sourceKind: "message",
            sourceTable: "messages",
            sourceId: row.id,
            title: `${capitalize(row.role)} message${chunks.length > 1 ? ` chunk ${index + 1}` : ""}`,
            summary: summarizeText(row.content, 240),
            content: chunk,
            importance: row.role === "user" ? "normal" : "low",
            chunkIndex: index,
            metadata: { role: row.role, status: row.status },
          }),
        )
      })
      if (shouldCreateVerbatimAnchor(row.content)) {
        chunkText(row.content).forEach((chunk, index) => {
          docs.push(
            makeTraceDocument({
              context,
              sourceKind: "verbatim_anchor",
              sourceTable: "messages",
              sourceId: row.id,
              title: `Verbatim anchor: ${summarizeText(row.content, 80)}`,
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
    return rows.map((row) =>
      makeTraceDocument({
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
          row.errorId ? `Error id: ${row.errorId}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        importance: row.status === "failed" ? "high" : "normal",
        metadata: { path: row.path, oldPath: row.oldPath, operation: row.operation, status: row.status },
      }),
    )
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
    conversationHint?: string,
  ): string[] {
    if (conversationHint) {
      const hinted = this.resolveConversationHint(projectId, currentConversationId, conversationHint, conversationLimit)
      if (hinted.length > 0) {
        return hinted
      }
    }
    if (scope === "current_conversation") {
      return [currentConversationId]
    }
    const rows = this.handle.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.projectId, projectId), inArray(conversations.status, ["active", "archived"])))
      .orderBy(desc(conversations.updatedAt))
      .limit(scope === "recent_conversations" ? conversationLimit : Math.max(conversationLimit, DEFAULT_CONVERSATION_LIMIT))
      .all()
    return rows.map((row) => row.id)
  }

  private resolveConversationHint(projectId: string, currentConversationId: string, hint: string, limit: number): string[] {
    const normalized = hint.toLowerCase()
    const rows = this.handle.db
      .select({ id: conversations.id, title: conversations.title })
      .from(conversations)
      .where(and(eq(conversations.projectId, projectId), inArray(conversations.status, ["active", "archived"])))
      .orderBy(desc(conversations.updatedAt))
      .limit(Math.max(limit, DEFAULT_CONVERSATION_LIMIT))
      .all()
    const currentIndex = rows.findIndex((row) => row.id === currentConversationId)
    const offset = conversationOffset(normalized)
    if (offset !== undefined && currentIndex >= 0 && rows[currentIndex + offset]) {
      const row = rows[currentIndex + offset]
      return row ? [row.id] : []
    }
    const titleMatches = rows.filter((row) => row.title && normalized.includes(row.title.toLowerCase()))
    if (titleMatches.length > 0) {
      return titleMatches.map((row) => row.id)
    }
    const fuzzy = rows.filter((row) => row.title && row.title.toLowerCase().includes(normalized))
    return fuzzy.map((row) => row.id)
  }

  private searchTraceDocuments(
    projectId: string,
    input: {
      query: string
      mode: TraceRetrieveMode
      conversationIds: string[]
      include: TraceRetrieveInclude[] | undefined
      toolNames: string[] | undefined
      paths: string[] | undefined
      command: string | undefined
      createdAfter: string | undefined
      createdBefore: string | undefined
      limit: number
    },
  ): SearchRow[] {
    const params: unknown[] = [projectId]
    const where = ["td.project_id = ?"]
    if (input.conversationIds.length > 0) {
      where.push(`td.conversation_id IN (${input.conversationIds.map(() => "?").join(", ")})`)
      params.push(...input.conversationIds)
    }
    const sourceKinds = sourceKindsForInclude(input.include)
    if (sourceKinds.length > 0) {
      where.push(`td.source_kind IN (${sourceKinds.map(() => "?").join(", ")})`)
      params.push(...sourceKinds)
    }
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
    if (input.handle) {
      return this.handle.db
        .select()
        .from(traceDocuments)
        .where(and(eq(traceDocuments.projectId, projectId), eq(traceDocuments.handle, input.handle)))
        .limit(1)
        .all()
    }
    if (input.messageId) {
      return this.handle.db
        .select()
        .from(traceDocuments)
        .where(and(eq(traceDocuments.projectId, projectId), eq(traceDocuments.sourceTable, "messages"), eq(traceDocuments.sourceId, input.messageId)))
        .all()
    }
    if (input.toolCallId) {
      return this.handle.db
        .select()
        .from(traceDocuments)
        .where(and(eq(traceDocuments.projectId, projectId), eq(traceDocuments.sourceTable, "tool_calls"), eq(traceDocuments.sourceId, input.toolCallId)))
        .all()
    }
    if (input.turnId) {
      const docs = this.handle.db
        .select()
        .from(traceDocuments)
        .where(and(eq(traceDocuments.projectId, projectId), eq(traceDocuments.turnId, input.turnId)))
        .orderBy(traceDocuments.createdAt)
        .limit(1)
        .all()
      if (docs.length > 0) {
        return docs
      }
      return [
        makeSyntheticInspectDocument(projectId, currentConversationId, input.turnId, "Turn bundle", this.buildTurnBundle(projectId, input.turnId, input.include)),
      ]
    }
    if (input.conversationId) {
      return this.handle.db
        .select()
        .from(traceDocuments)
        .where(and(eq(traceDocuments.projectId, projectId), eq(traceDocuments.conversationId, input.conversationId)))
        .orderBy(desc(traceDocuments.createdAt))
        .limit(1)
        .all()
    }
    return []
  }

  private buildTurnBundle(projectId: string, turnId: string, include?: TraceRetrieveInclude[]): string {
    const parts: string[] = []
    const sourceKinds = sourceKindsForInclude(include)
    const includeKind = (kind: TraceRetrieveSourceKind): boolean => sourceKinds.length === 0 || sourceKinds.includes(kind)
    const messageRows = includeKind("message")
      ? (this.handle.sqlite
          .prepare(
            `SELECT m.role, m.status, m.content, m.created_at
             FROM messages m
             INNER JOIN conversations c ON c.id = m.conversation_id
             WHERE c.project_id = ? AND m.turn_id = ?
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
             WHERE c.project_id = ? AND tc.turn_id = ?
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
             WHERE c.project_id = ? AND e.turn_id = ?
             ORDER BY e.created_at`,
          )
          .all(projectId, turnId) as Array<{ code: string; message: string; details_json: string | null; created_at: string }>)
      : []
    for (const row of errorRows) {
      parts.push(`[error ${row.code} ${row.created_at}]\n${row.message}\n${row.details_json ?? ""}`)
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

const makeSyntheticInspectDocument = (projectId: string, conversationId: string, turnId: string, title: string, content: string): TraceDocumentRow => {
  const now = nowIso()
  return {
    id: `synthetic_${turnId}`,
    projectId,
    conversationId,
    turnId,
    sourceKind: "turn_summary",
    sourceTable: "turns",
    sourceId: turnId,
    handle: `turn:${turnId}`,
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

const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

const daysAgoIso = (days: number): string => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

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

const makeSnippet = (content: string, query: string): string => {
  const terms = query.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? []
  const lower = content.toLowerCase()
  const index = terms.map((term) => lower.indexOf(term)).find((position) => position >= 0) ?? 0
  const start = Math.max(index - 160, 0)
  const end = Math.min(start + 420, content.length)
  const prefix = start > 0 ? "..." : ""
  const suffix = end < content.length ? "..." : ""
  return `${prefix}${content.slice(start, end)}${suffix}`
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

const normalizeResultKind = (value: string): TraceRetrieveSourceKind => {
  if (
    value === "message" ||
    value === "tool_call" ||
    value === "shell" ||
    value === "file" ||
    value === "patch" ||
    value === "error" ||
    value === "turn_summary" ||
    value === "conversation_summary" ||
    value === "verbatim_anchor"
  ) {
    return value
  }
  return "message"
}

const scoreTraceRow = (row: SearchRow, input: { query: string; command: string | undefined; paths: string[] | undefined }): number => {
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

const countBy = (values: string[]): Record<string, number> =>
  values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1
    return counts
  }, {})

const conversationOffset = (hint: string): number | undefined => {
  if (/\btwo conversations ago\b|\b2 conversations ago\b/.test(hint)) {
    return 2
  }
  if (/\bprevious conversation\b|\blast conversation\b|\bone conversation ago\b|\b1 conversation ago\b/.test(hint)) {
    return 1
  }
  return undefined
}

const capitalize = (text: string): string => (text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`)
