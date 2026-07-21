import path from "node:path"
import type {
  MemoryDocIndex,
  MemorySearchInput,
  MemorySearchOutput,
  TraceRetrieveMainResult,
  TraceRetrieveMainToolInput,
  TraceRetrieveMainToolOutput,
  TraceRetrieveVisibleStatus,
} from "@socrates/contracts"
import type { RankedRetrievalParent } from "@socrates/core"
import { sha256Hex } from "@socrates/core"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { eq } from "drizzle-orm"
import type { DatabaseHandle } from "../../db/client"
import {
  retrievalIndexStates,
  retrievalJobs,
  retrievalResultDiagnostics,
  retrievalRuns,
} from "../../db/schema"
import type { EmbeddingStore } from "../store/embeddingStore"
import type { StoreContext } from "../store/shared"
import { canonicalMemoryParentId, loadCanonicalGoalRows, loadCanonicalMemoryRows, loadCanonicalTraceRows } from "./canonicalSources"
import { LanceDbIndex } from "./lanceDbIndex"
import type { RetrievalIndexRow, RetrievalSearchFilters, RetrievalSearchMode } from "./types"

const RETRIEVAL_INDEX_VERSION = 3
const EMBEDDING_BATCH_SIZE = 16

type RetrievalStateRow = typeof retrievalIndexStates.$inferSelect

export class RetrievalStore {
  private readonly lance: LanceDbIndex
  private readonly projectQueues = new Map<string, Promise<void>>()
  private readonly scheduledRebuilds = new Map<string, Set<string>>()
  private readonly recentTraceResults = new Map<string, TraceRetrieveMainResult[]>()
  private disposed = false

  constructor(
    private readonly context: StoreContext,
    private readonly embeddings: EmbeddingStore,
    socratesHome: string,
  ) {
    this.lance = new LanceDbIndex(path.join(socratesHome, "retrieval", "lance"))
  }

  async initialize(): Promise<void> {
    this.context.handle.sqlite
      .prepare("UPDATE retrieval_jobs SET status = 'failed', error = 'Interrupted by process restart.', completed_at = ? WHERE status IN ('queued', 'running')")
      .run(nowIso())
    for (const projectId of this.projectIds()) {
      this.enqueueRebuild(projectId, "startup_rebuild")
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.projectQueues.values()])
    await this.lance.close()
  }

  async waitForIdle(projectId?: string): Promise<void> {
    while (true) {
      const pending = projectId ? this.projectQueues.get(projectId) : undefined
      const all = projectId ? (pending ? [pending] : []) : [...this.projectQueues.values()]
      if (all.length === 0) return
      await Promise.allSettled(all)
    }
  }

  enqueueRebuild(projectId: string, reason: string): void {
    const rebuildKey = this.activeEmbeddingFingerprint(projectId) ?? "lexical-only"
    const scheduled = this.scheduledRebuilds.get(projectId) ?? new Set<string>()
    if (scheduled.has(rebuildKey)) return
    scheduled.add(rebuildKey)
    this.scheduledRebuilds.set(projectId, scheduled)
    const existing = this.state(projectId)
    this.writeState(projectId, { status: "rebuilding", lexicalReady: existing?.lexicalReady ?? false, vectorReady: false, lastError: null })
    this.enqueue(projectId, async () => {
      try {
        await this.rebuildProject(projectId, reason)
      } finally {
        const current = this.scheduledRebuilds.get(projectId)
        current?.delete(rebuildKey)
        if (current?.size === 0) this.scheduledRebuilds.delete(projectId)
      }
    })
  }

  enqueueTurn(projectId: string, turnId: string): void {
    this.enqueue(projectId, () => this.upsertTurn(projectId, turnId))
  }

  enqueueV2Turn(projectId: string, turnId: string): void {
    this.enqueue(projectId, () => this.upsertTurn(projectId, turnId))
  }

  enqueueGoal(projectId: string, goalId: string): void {
    this.enqueue(projectId, () => this.upsertGoal(projectId, goalId))
  }

  onMemoryDocIndexed(index: MemoryDocIndex, changedSectionIds: string[], removedSectionIds: string[]): void {
    if (changedSectionIds.length === 0 && removedSectionIds.length === 0) return
    const projectIds = index.scope === "global" ? this.projectIds() : index.projectId ? [index.projectId] : []
    for (const projectId of projectIds) {
      this.enqueue(projectId, () => this.upsertMemorySections(projectId, index, changedSectionIds, removedSectionIds))
    }
  }

  async search(input: {
    projectId: string
    conversationId?: string
    query: string
    mode: RetrievalSearchMode
    filters: RetrievalSearchFilters
    limit?: number
    automaticFallback?: boolean
  }): Promise<RankedRetrievalParent<RetrievalIndexRow>[]> {
    const started = Date.now()
    const runId = createId("retrun")
    let mode = input.mode
    const warnings: string[] = []
    try {
      const state = this.state(input.projectId)
      if (!state?.tableName || !state.lexicalReady) {
        throw new SocratesError("retrieval_rebuilding", "Retrieval is rebuilding for this project. Exact inspect and audit remain available.", {
          recoverable: true,
        })
      }
      if (mode !== "lexical" && !state.vectorReady) {
        if (input.automaticFallback) {
          warnings.push("Semantic retrieval is unavailable; automatic memory recall used lexical search.")
          mode = "lexical"
        } else {
          throw new SocratesError("semantic_retrieval_unavailable", "Semantic retrieval is not ready for this project. Retry lexical mode or wait for the rebuild.", {
            recoverable: true,
          })
        }
      }
      const conversationIds = input.filters.scope === "recent_conversations" ? this.recentConversationIds(input.projectId, 10) : undefined
      const queryVector = mode === "lexical" ? undefined : (await this.embeddings.embedValues(input.projectId, [input.query])).embeddings[0]
      const ranked = await this.lance.search({
        tableName: state.tableName,
        query: input.query,
        ...(queryVector ? { queryVector } : {}),
        mode,
        filters: {
          ...input.filters,
          ...(input.filters.scope === "current_conversation" && input.conversationId ? { conversationId: input.conversationId } : {}),
          ...(conversationIds ? { conversationIds } : {}),
        },
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
      this.recordRun({
        runId,
        input,
        mode,
        ranked,
        warnings,
        latencyMs: Date.now() - started,
        status: "completed",
        ...(state.embeddingFingerprint ? { embeddingFingerprint: state.embeddingFingerprint } : {}),
      })
      return ranked
    } catch (error) {
      this.recordRun({ runId, input, mode, ranked: [], warnings, latencyMs: Date.now() - started, status: "failed", error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async retrieveMainTrace(
    projectId: string,
    conversationId: string,
    input: TraceRetrieveMainToolInput,
    exactConversationId?: string,
  ): Promise<TraceRetrieveMainToolOutput> {
    if (input.operation === "inspect") {
      return this.inspectMainTrace(projectId, conversationId, input)
    }
    if (input.mode === "audit") {
      const results = this.auditTrace(projectId, conversationId, input, exactConversationId)
      this.recentTraceResults.set(traceResultKey(projectId, conversationId), results)
      return { results, totalMatches: results.length }
    }
    if (!input.query) {
      const results = this.rawTraceParents(projectId, conversationId, {
        ...(exactConversationId ? { conversationId: exactConversationId } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
        ...("turnNo" in input && input.turnNo ? { turnNumber: input.turnNo } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      })
      this.recentTraceResults.set(traceResultKey(projectId, conversationId), results)
      return { results, totalMatches: results.length }
    }
    const mode = input.mode ?? "lexical"
    const ranked = await this.search({
      projectId,
      conversationId,
      query: input.query,
      mode,
      filters: {
        corpusKind: "trace_turn",
        ...(input.scope ? { scope: input.scope } : { scope: "project" }),
        ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
        ...(exactConversationId ? { conversationId: exactConversationId } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.createdAfter ? { createdAfter: input.createdAfter } : {}),
        ...(input.createdBefore ? { createdBefore: input.createdBefore } : {}),
      },
      ...(input.limit ? { limit: input.limit } : {}),
    })
    const results = ranked.map((result) => ({
      resultNumber: result.rank,
      content: result.content,
      turnId: result.metadata.turnId,
      conversationTitle: result.metadata.conversationTitle,
      turnNumber: result.metadata.turnNumber,
      matchedRole: result.metadata.matchedRole as "user" | "assistant",
      status: result.metadata.status as TraceRetrieveVisibleStatus,
      occurredAt: result.metadata.occurredAt,
    }))
    this.recentTraceResults.set(traceResultKey(projectId, conversationId), results)
    return { results, totalMatches: results.length }
  }

  async retrieveV2FlowTrace(
    projectId: string,
    flowId: string,
    input: TraceRetrieveMainToolInput,
  ): Promise<TraceRetrieveMainToolOutput> {
    if (input.operation === "inspect" || input.mode === "audit" || !input.query) {
      throw new SocratesError("v2_trace_local_operation_required", "This Seamless trace operation must use the V2 evidence store.", { recoverable: true })
    }
    const mode = input.mode ?? "lexical"
    const ranked = await this.search({
      projectId,
      query: input.query,
      mode,
      filters: {
        corpusKind: "trace_turn",
        runtimeKind: "v2_flow",
        flowId,
        ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.createdAfter ? { createdAfter: input.createdAfter } : {}),
        ...(input.createdBefore ? { createdBefore: input.createdBefore } : {}),
      },
      ...(input.limit ? { limit: input.limit } : {}),
    })
    const results = ranked.map((result) => ({
      resultNumber: result.rank,
      content: result.content,
      turnId: result.metadata.turnId,
      conversationTitle: result.metadata.conversationTitle,
      turnNumber: result.metadata.turnNumber,
      matchedRole: result.metadata.matchedRole as "user" | "assistant",
      status: result.metadata.status as TraceRetrieveVisibleStatus,
      occurredAt: result.metadata.occurredAt,
    }))
    return { results, totalMatches: results.length }
  }

  async searchMemory(projectId: string, input: MemorySearchInput, automaticFallback = false): Promise<MemorySearchOutput> {
    const ranked = await this.search({
      projectId,
      query: input.query,
      mode: input.mode,
      filters: { corpusKind: "memory_section", scope: input.scope },
      limit: input.limit,
      automaticFallback,
    })
    return {
      results: ranked.map((result) => ({
        resultNumber: result.rank,
        content: result.content,
        surface: result.metadata.surface as Exclude<RetrievalIndexRow["surface"], "">,
        fileName: result.metadata.fileName as Exclude<RetrievalIndexRow["fileName"], "">,
        sectionId: result.metadata.sectionId as Exclude<RetrievalIndexRow["sectionId"], "">,
        sectionHeading: result.metadata.sectionHeading,
        scope: result.metadata.scope,
      })),
      totalMatches: ranked.length,
    }
  }

  async searchGoalCards(projectId: string, query: string, limit = 4): Promise<string[]> {
    const ranked = await this.search({
      projectId,
      query,
      mode: "combined",
      filters: { corpusKind: "goal_card", scope: "project" },
      limit: Math.max(1, Math.min(4, limit)),
      automaticFallback: true,
    })
    return ranked.map((result) => result.parentId)
  }

  status(projectId: string): RetrievalStateRow | undefined {
    return this.state(projectId)
  }

  deleteConversation(projectId: string, conversationId: string): void {
    this.enqueue(projectId, () => this.deleteConversationNow(projectId, conversationId))
  }

  deleteV2Flow(projectId: string, flowId: string): void {
    this.enqueue(projectId, async () => {
      const state = this.state(projectId)
      if (state?.tableName) await this.lance.deleteFlow(state.tableName, flowId)
      this.context.handle.sqlite.prepare("DELETE FROM retrieval_result_diagnostics WHERE run_id IN (SELECT id FROM retrieval_runs WHERE project_id = ? AND json_extract(filters_json, '$.flowId') = ?)").run(projectId, flowId)
      this.context.handle.sqlite.prepare("DELETE FROM retrieval_runs WHERE project_id = ? AND json_extract(filters_json, '$.flowId') = ?").run(projectId, flowId)
    })
  }

  deleteV2Turn(projectId: string, turnId: string): void {
    this.enqueue(projectId, () => this.deleteParentsNow(projectId, [turnId]))
  }

  deleteV2Goal(projectId: string, goalId: string): void {
    this.enqueue(projectId, () => this.deleteParentsNow(projectId, [goalId]))
  }

  private async deleteParentsNow(projectId: string, parentIds: string[]): Promise<void> {
    const state = this.state(projectId)
    if (state?.tableName) {
      await this.lance.upsertParents(state.tableName, parentIds, [])
      await this.refreshCounts(projectId, state.tableName)
    }
    for (const key of this.recentTraceResults.keys()) {
      if (key.startsWith(`${projectId}:`)) this.recentTraceResults.delete(key)
    }
  }

  private async deleteConversationNow(projectId: string, conversationId: string): Promise<void> {
    const state = this.state(projectId)
    if (state?.tableName) await this.lance.deleteConversation(state.tableName, conversationId)
    this.context.handle.sqlite.prepare("DELETE FROM retrieval_result_diagnostics WHERE run_id IN (SELECT id FROM retrieval_runs WHERE conversation_id = ?)").run(conversationId)
    this.context.handle.sqlite.prepare("DELETE FROM retrieval_runs WHERE conversation_id = ?").run(conversationId)
  }

  deleteProject(projectId: string): void {
    this.enqueue(projectId, () => this.deleteProjectNow(projectId))
  }

  private async deleteProjectNow(projectId: string): Promise<void> {
    const state = this.state(projectId)
    if (state?.tableName) await this.lance.dropTableIfExists(state.tableName)
    this.context.handle.sqlite.prepare("DELETE FROM retrieval_result_diagnostics WHERE run_id IN (SELECT id FROM retrieval_runs WHERE project_id = ?)").run(projectId)
    this.context.handle.sqlite.prepare("DELETE FROM retrieval_runs WHERE project_id = ?").run(projectId)
    this.context.handle.sqlite.prepare("DELETE FROM retrieval_jobs WHERE project_id = ?").run(projectId)
    this.context.handle.sqlite.prepare("DELETE FROM retrieval_index_states WHERE project_id = ?").run(projectId)
  }

  private async rebuildProject(projectId: string, reason: string): Promise<void> {
    if (this.disposed) return
    const existing = this.state(projectId)
    const jobId = createId("retjob")
    const startedAt = nowIso()
    this.context.handle.db.insert(retrievalJobs).values({ id: jobId, projectId, kind: "rebuild", reason, status: "running", attempts: 1, startedAt, createdAt: startedAt }).run()
    this.writeState(projectId, {
      status: "rebuilding",
      lexicalReady: existing?.lexicalReady ?? false,
      vectorReady: false,
      rebuildStartedAt: startedAt,
      lastError: null,
    })
    try {
      const traceRows = loadCanonicalTraceRows(this.context.handle, projectId)
      const memoryRows = loadCanonicalMemoryRows(this.context.handle, projectId)
      const goalRows = loadCanonicalGoalRows(this.context.handle, projectId)
      const embedded = await this.attachVectors(projectId, [...traceRows, ...memoryRows, ...goalRows])
      if (embedded.configFingerprint !== this.activeEmbeddingFingerprint(projectId)) {
        const completedAt = nowIso()
        this.writeState(projectId, { status: "rebuilding", vectorReady: false, lastError: null })
        this.context.handle.db.update(retrievalJobs).set({ status: "completed", error: "Superseded by a newer embedding configuration.", completedAt }).where(eq(retrievalJobs.id, jobId)).run()
        return
      }
      const replaced = await this.lance.replaceProject({
        projectId,
        rows: embedded.rows,
        ...(existing?.tableName ? { previousTableName: existing.tableName } : {}),
      })
      const completedAt = nowIso()
      this.writeState(projectId, {
        tableName: replaced.tableName ?? null,
        status: "ready",
        embeddingFingerprint: embedded.configFingerprint ?? null,
        lexicalReady: embedded.rows.length > 0,
        vectorReady: Boolean(embedded.configFingerprint && embedded.rows.length > 0),
        traceParents: new Set(traceRows.map((row) => row.parentId)).size,
        traceChunks: traceRows.length,
        memoryParents: new Set(memoryRows.map((row) => row.parentId)).size,
        memoryChunks: memoryRows.length,
        rebuildCompletedAt: completedAt,
        lastError: null,
      })
      this.context.handle.db.update(retrievalJobs).set({ status: "completed", completedAt }).where(eq(retrievalJobs.id, jobId)).run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.writeState(projectId, { status: "failed", vectorReady: false, lastError: message })
      this.context.handle.sqlite.prepare("UPDATE retrieval_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").run(message, nowIso(), jobId)
      throw error
    }
  }

  private inspectMainTrace(
    projectId: string,
    conversationId: string,
    input: Extract<TraceRetrieveMainToolInput, { operation: "inspect" }>,
  ): TraceRetrieveMainToolOutput {
    const previous = input.resultNumber ? this.recentTraceResults.get(traceResultKey(projectId, conversationId))?.[input.resultNumber - 1] : undefined
    const turnId = input.turnId ?? previous?.turnId
    const results = this.rawTraceParents(projectId, conversationId, {
      ...(turnId ? { turnId } : {}),
      ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
      ...(input.turnNo ? { turnNumber: input.turnNo } : {}),
      limit: 1,
      fullParent: true,
      ...(previous?.matchedRole ? { matchedRole: previous.matchedRole } : {}),
    })
    if (results.length === 0) {
      throw new SocratesError("trace_result_not_found", "The requested trace result is no longer available in the active project.", { recoverable: true })
    }
    return { results, totalMatches: results.length }
  }

  private rawTraceParents(
    projectId: string,
    currentConversationId: string,
    options: {
      scope?: "current_conversation" | "recent_conversations" | "project"
      conversationTitle?: string
      conversationId?: string
      turnId?: string
      turnNumber?: number
      limit?: number
      fullParent?: boolean
      matchedRole?: "user" | "assistant"
    },
  ): TraceRetrieveMainResult[] {
    const where = ["c.project_id = ?", "c.status IN ('active','archived')", "t.status IN ('completed','failed','cancelled')"]
    const params: unknown[] = [projectId]
    if (options.turnId) {
      where.push("t.id = ?")
      params.push(options.turnId)
    }
    if (options.conversationId) {
      where.push("t.conversation_id = ?")
      params.push(options.conversationId)
    }
    if (options.scope === "current_conversation") {
      where.push("t.conversation_id = ?")
      params.push(currentConversationId)
    } else if (options.scope === "recent_conversations") {
      const ids = this.recentConversationIds(projectId, 10)
      if (ids.length === 0) return []
      where.push(`t.conversation_id IN (${ids.map(() => "?").join(",")})`)
      params.push(...ids)
    }
    if (options.conversationTitle) {
      where.push("LOWER(c.title) = LOWER(?)")
      params.push(options.conversationTitle)
    }
    if (options.turnNumber) {
      where.push("(SELECT COUNT(*) FROM turns prior WHERE prior.conversation_id = t.conversation_id AND (prior.started_at < t.started_at OR (prior.started_at = t.started_at AND prior.id <= t.id))) = ?")
      params.push(options.turnNumber)
    }
    const limit = Math.min(8, Math.max(1, options.limit ?? 8))
    params.push(limit)
    const rows = this.context.handle.sqlite.prepare(
      `SELECT t.id AS turnId,
              t.status AS turnStatus,
              t.started_at AS startedAt,
              t.completed_at AS completedAt,
              t.failed_at AS failedAt,
              t.cancelled_at AS cancelledAt,
              c.title AS conversationTitle,
              (SELECT COUNT(*) FROM turns prior WHERE prior.conversation_id = t.conversation_id AND (prior.started_at < t.started_at OR (prior.started_at = t.started_at AND prior.id <= t.id))) AS turnNumber,
              um.content AS userContent,
              am.content AS assistantContent
       FROM turns t
       INNER JOIN conversations c ON c.id = t.conversation_id
       LEFT JOIN messages um ON um.id = t.user_message_id AND um.role = 'user'
       LEFT JOIN messages am ON am.id = t.assistant_message_id AND am.role = 'assistant'
       WHERE ${where.join(" AND ")}
       ORDER BY t.started_at DESC, t.id DESC
       LIMIT ?`,
    ).all(...params) as Array<{
      turnId: string; turnStatus: string; startedAt: string; completedAt: string | null; failedAt: string | null; cancelledAt: string | null;
      conversationTitle: string | null; turnNumber: number; userContent: string | null; assistantContent: string | null
    }>
    return rows.map((row, index) => {
      const matchedRole = options.matchedRole ?? (row.assistantContent?.trim() ? "assistant" : "user")
      const matchedContent = matchedRole === "assistant" ? row.assistantContent : row.userContent
      const content = options.fullParent
        ? [row.userContent?.trim() ? `User:\n${row.userContent.trim()}` : "", row.assistantContent?.trim() ? `Assistant:\n${row.assistantContent.trim()}` : ""].filter(Boolean).join("\n\n")
        : matchedContent?.trim() || row.userContent?.trim() || row.assistantContent?.trim() || ""
      return {
        resultNumber: index + 1,
        content,
        turnId: row.turnId,
        conversationTitle: row.conversationTitle?.trim() || "Untitled conversation",
        turnNumber: row.turnNumber,
        matchedRole,
        status: mapVisibleStatus(row.turnStatus, Boolean(row.assistantContent?.trim())),
        occurredAt: row.completedAt ?? row.cancelledAt ?? row.failedAt ?? row.startedAt,
      }
    })
  }

  private auditTrace(
    projectId: string,
    currentConversationId: string,
    input: Extract<TraceRetrieveMainToolInput, { mode: "audit" }>,
    exactConversationId?: string,
  ): TraceRetrieveMainResult[] {
    const sourceKinds = auditSourceKinds(input.include)
    const where = ["td.project_id = ?", "c.status IN ('active','archived')", `td.source_kind IN (${sourceKinds.map(() => "?").join(",")})`, "trace_documents_fts MATCH ?"]
    const params: unknown[] = [projectId, ...sourceKinds, input.query]
    if (exactConversationId) {
      where.push("td.conversation_id = ?")
      params.push(exactConversationId)
    }
    if (input.scope === "current_conversation") {
      where.push("td.conversation_id = ?")
      params.push(currentConversationId)
    } else if (input.scope === "recent_conversations") {
      const ids = this.recentConversationIds(projectId, 10)
      if (ids.length === 0) return []
      where.push(`td.conversation_id IN (${ids.map(() => "?").join(",")})`)
      params.push(...ids)
    }
    if (input.conversationTitle) {
      where.push("LOWER(c.title) = LOWER(?)")
      params.push(input.conversationTitle)
    }
    for (const pathValue of input.paths ?? []) {
      where.push("(td.content LIKE ? OR td.metadata_json LIKE ?)")
      params.push(`%${pathValue}%`, `%${pathValue}%`)
    }
    if (input.command) {
      where.push("td.content LIKE ?")
      params.push(`%${input.command}%`)
    }
    for (const toolName of input.toolNames ?? []) {
      where.push("td.metadata_json LIKE ?")
      params.push(`%${toolName}%`)
    }
    params.push(Math.min(8, input.limit ?? 8))
    const rows = this.context.handle.sqlite.prepare(
      `SELECT td.content,
              td.turn_id AS turnId,
              td.created_at AS occurredAt,
              c.title AS conversationTitle,
              t.status AS turnStatus,
              (SELECT COUNT(*) FROM turns prior WHERE prior.conversation_id = t.conversation_id AND (prior.started_at < t.started_at OR (prior.started_at = t.started_at AND prior.id <= t.id))) AS turnNumber
       FROM trace_documents_fts
       INNER JOIN trace_documents td ON td.id = trace_documents_fts.trace_document_id
       INNER JOIN conversations c ON c.id = td.conversation_id
       INNER JOIN turns t ON t.id = td.turn_id
       WHERE ${where.join(" AND ")}
       ORDER BY bm25(trace_documents_fts), td.created_at DESC
       LIMIT ?`,
    ).all(...params) as Array<{ content: string; turnId: string; occurredAt: string; conversationTitle: string | null; turnStatus: string; turnNumber: number }>
    return rows.map((row, index) => ({
      resultNumber: index + 1,
      content: row.content,
      turnId: row.turnId,
      conversationTitle: row.conversationTitle?.trim() || "Untitled conversation",
      turnNumber: row.turnNumber,
      matchedRole: "assistant",
      status: mapVisibleStatus(row.turnStatus, false),
      occurredAt: row.occurredAt,
    }))
  }

  private async upsertTurn(projectId: string, turnId: string): Promise<void> {
    const state = this.state(projectId)
    if (!state?.tableName || state.status !== "ready") {
      if (!state || (state.status !== "rebuilding" && state.status !== "pending")) {
        this.enqueueRebuild(projectId, "turn_without_ready_index")
      }
      return
    }
    const rows = loadCanonicalTraceRows(this.context.handle, projectId, turnId)
    const embedded = await this.attachVectors(projectId, rows)
    if ((state.embeddingFingerprint ?? undefined) !== embedded.configFingerprint) {
      this.enqueueRebuild(projectId, "embedding_configuration_changed")
      return
    }
    await this.lance.upsertParents(state.tableName, [turnId], embedded.rows)
    await this.refreshCounts(projectId, state.tableName)
  }

  private async upsertGoal(projectId: string, goalId: string): Promise<void> {
    const state = this.state(projectId)
    if (!state?.tableName || state.status !== "ready") {
      if (!state || (state.status !== "rebuilding" && state.status !== "pending")) {
        this.enqueueRebuild(projectId, "goal_without_ready_index")
      }
      return
    }
    const rows = loadCanonicalGoalRows(this.context.handle, projectId, goalId)
    const embedded = await this.attachVectors(projectId, rows)
    if ((state.embeddingFingerprint ?? undefined) !== embedded.configFingerprint) {
      this.enqueueRebuild(projectId, "embedding_configuration_changed")
      return
    }
    await this.lance.upsertParents(state.tableName, [goalId], embedded.rows)
    await this.refreshCounts(projectId, state.tableName)
  }

  private async upsertMemorySections(
    projectId: string,
    index: MemoryDocIndex,
    changedSectionIds: string[],
    removedSectionIds: string[],
  ): Promise<void> {
    const state = this.state(projectId)
    if (!state?.tableName || state.status !== "ready") return
    const indexProjectId = index.projectId ?? "global"
    const parentIds = [...changedSectionIds, ...removedSectionIds].map((sectionId) =>
      canonicalMemoryParentId({ scope: index.scope, projectId: indexProjectId, path: index.path, sectionId }),
    )
    const matching = loadCanonicalMemoryRows(this.context.handle, projectId).filter((row) => parentIds.includes(row.parentId))
    if (matching.length === 0) {
      await this.lance.upsertParents(state.tableName, parentIds, [])
      await this.refreshCounts(projectId, state.tableName)
      return
    }
    const embedded = await this.attachVectors(projectId, matching)
    if ((state.embeddingFingerprint ?? undefined) !== embedded.configFingerprint) {
      this.enqueueRebuild(projectId, "embedding_configuration_changed")
      return
    }
    await this.lance.upsertParents(state.tableName, parentIds, embedded.rows)
    await this.refreshCounts(projectId, state.tableName)
  }

  private async attachVectors(projectId: string, rows: RetrievalIndexRow[]): Promise<{ rows: RetrievalIndexRow[]; configFingerprint?: string }> {
    const config = this.embeddings.getActiveConfiguration(projectId)
    if (!config || rows.length === 0) return { rows }
    const configFingerprint = sha256Hex([config.providerId, config.modelId, config.dimensions].join("\0"))
    const uniqueByHash = new Map(rows.map((row) => [row.contentHash, row.content]))
    const cached = await this.lance.cachedVectors({ configFingerprint, contentHashes: [...uniqueByHash.keys()] })
    const missing = [...uniqueByHash.entries()].filter(([contentHash]) => !cached.has(contentHash))
    for (let offset = 0; offset < missing.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + EMBEDDING_BATCH_SIZE)
      const generated = await this.embeddings.embedValues(projectId, batch.map(([, content]) => content))
      const cacheRows = batch.map(([contentHash], index) => ({ contentHash, vector: generated.embeddings[index] ?? [] })).filter((row) => row.vector.length === config.dimensions)
      await this.lance.storeCachedVectors({ configFingerprint, rows: cacheRows })
      for (const row of cacheRows) cached.set(row.contentHash, row.vector)
    }
    return {
      configFingerprint,
      rows: rows.map((row) => ({ ...row, vector: cached.get(row.contentHash) ?? new Array(config.dimensions).fill(0) })),
    }
  }

  private activeEmbeddingFingerprint(projectId: string): string | undefined {
    const config = this.embeddings.getActiveConfiguration(projectId)
    return config ? sha256Hex([config.providerId, config.modelId, config.dimensions].join("\0")) : undefined
  }

  private async refreshCounts(projectId: string, tableName: string): Promise<void> {
    const counts = await this.lance.counts(tableName)
    const traceParents = this.context.handle.sqlite.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT id) FROM turns WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ? AND status IN ('active','archived')) AND status IN ('completed','failed','cancelled'))
         +
         (SELECT COUNT(DISTINCT id) FROM v2_turns WHERE project_id = ? AND status IN ('completed','failed','cancelled')) AS count`,
    ).get(projectId, projectId) as { count: number }
    const memoryParents = new Set(loadCanonicalMemoryRows(this.context.handle, projectId).map((row) => row.parentId)).size
    this.writeState(projectId, { traceParents: traceParents.count, traceChunks: counts.traceChunks, memoryParents, memoryChunks: counts.memoryChunks })
  }

  private writeState(projectId: string, patch: Partial<Omit<RetrievalStateRow, "id" | "projectId" | "indexVersion" | "createdAt" | "updatedAt">>): void {
    const existing = this.state(projectId)
    const now = nowIso()
    if (!existing) {
      this.context.handle.db.insert(retrievalIndexStates).values({
        id: createId("retstate"), projectId, indexVersion: RETRIEVAL_INDEX_VERSION, status: "pending", lexicalReady: false, vectorReady: false,
        traceParents: 0, traceChunks: 0, memoryParents: 0, memoryChunks: 0, createdAt: now, updatedAt: now, ...patch,
      }).run()
      return
    }
    this.context.handle.sqlite.prepare(
      `UPDATE retrieval_index_states SET
        index_version = ?, table_name = ?, status = ?, embedding_fingerprint = ?, lexical_ready = ?, vector_ready = ?,
        trace_parents = ?, trace_chunks = ?, memory_parents = ?, memory_chunks = ?, last_error = ?,
        rebuild_started_at = ?, rebuild_completed_at = ?, updated_at = ? WHERE project_id = ?`,
    ).run(
      RETRIEVAL_INDEX_VERSION,
      patch.tableName === undefined ? existing.tableName : patch.tableName,
      patch.status ?? existing.status,
      patch.embeddingFingerprint === undefined ? existing.embeddingFingerprint : patch.embeddingFingerprint,
      Number(patch.lexicalReady ?? existing.lexicalReady), Number(patch.vectorReady ?? existing.vectorReady),
      patch.traceParents ?? existing.traceParents, patch.traceChunks ?? existing.traceChunks,
      patch.memoryParents ?? existing.memoryParents, patch.memoryChunks ?? existing.memoryChunks,
      patch.lastError === undefined ? existing.lastError : patch.lastError,
      patch.rebuildStartedAt === undefined ? existing.rebuildStartedAt : patch.rebuildStartedAt,
      patch.rebuildCompletedAt === undefined ? existing.rebuildCompletedAt : patch.rebuildCompletedAt,
      now, projectId,
    )
  }

  private recordRun(input: {
    runId: string
    input: { projectId: string; conversationId?: string; query: string; mode: RetrievalSearchMode; filters: RetrievalSearchFilters }
    mode: RetrievalSearchMode
    ranked: RankedRetrievalParent<RetrievalIndexRow>[]
    warnings: string[]
    latencyMs: number
    status: "completed" | "failed"
    embeddingFingerprint?: string
    error?: string
  }): void {
    const createdAt = nowIso()
    this.context.handle.db.insert(retrievalRuns).values({
      id: input.runId, projectId: input.input.projectId, conversationId: input.input.conversationId,
      corpusKind: input.input.filters.corpusKind, query: input.input.query, mode: input.mode,
      filtersJson: JSON.stringify(input.input.filters), embeddingFingerprint: input.embeddingFingerprint,
      status: input.status, latencyMs: input.latencyMs, warningsJson: JSON.stringify(input.warnings), error: input.error, createdAt,
    }).run()
    for (const result of input.ranked) {
      const { vector: _vector, ...sourceRef } = result.metadata
      this.context.handle.db.insert(retrievalResultDiagnostics).values({
        id: createId("retres"), runId: input.runId, rank: result.rank, chunkId: result.chunkId, parentId: result.parentId,
        rawScore: result.rawScore, normalizedScore: result.normalizedScore, recencyReordered: result.recencyReordered,
        selected: true, sourceRefJson: JSON.stringify(sourceRef), createdAt,
      }).run()
    }
  }

  private state(projectId: string): RetrievalStateRow | undefined {
    return this.context.handle.db.select().from(retrievalIndexStates).where(eq(retrievalIndexStates.projectId, projectId)).get()
  }

  private projectIds(): string[] {
    return (this.context.handle.sqlite.prepare("SELECT id FROM projects WHERE status <> 'deleted' ORDER BY created_at").all() as Array<{ id: string }>).map((row) => row.id)
  }

  private recentConversationIds(projectId: string, limit: number): string[] {
    return (this.context.handle.sqlite.prepare("SELECT id FROM conversations WHERE project_id = ? AND status IN ('active','archived') ORDER BY updated_at DESC LIMIT ?").all(projectId, limit) as Array<{ id: string }>).map((row) => row.id)
  }

  private enqueue(projectId: string, work: () => Promise<void>): void {
    const previous = this.projectQueues.get(projectId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work).catch(() => undefined).finally(() => {
      if (this.projectQueues.get(projectId) === next) this.projectQueues.delete(projectId)
    })
    this.projectQueues.set(projectId, next)
  }
}

const traceResultKey = (projectId: string, conversationId: string): string => `${projectId}:${conversationId}`

const mapVisibleStatus = (status: string, hasAssistantContent: boolean): TraceRetrieveVisibleStatus => {
  if (status === "completed") return "complete"
  if (status === "cancelled") return hasAssistantContent ? "cancelled_partial" : "cancelled_user_only"
  return "failed_user_only"
}

const auditSourceKinds = (include: Array<"tool_calls" | "shell" | "files" | "errors"> | undefined): string[] => {
  const selected = include?.length ? include : ["tool_calls", "shell", "files", "errors"]
  const kinds = new Set<string>()
  for (const item of selected) {
    if (item === "tool_calls") kinds.add("tool_call")
    if (item === "shell") kinds.add("shell")
    if (item === "files") {
      kinds.add("file")
      kinds.add("patch")
    }
    if (item === "errors") kinds.add("error")
  }
  return [...kinds]
}
