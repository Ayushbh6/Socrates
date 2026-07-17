import type {
  ConversationActivityStep,
  ConversationContextUsage,
  ConversationCostUsage,
  ConversationTokenUsage,
  ConversationToolRun,
  ProviderId,
  TurnUsageReport,
  UsageBreakdownItem,
} from "@socrates/contracts"
import { estimateTextTokens } from "@socrates/providers"
import { createId, nowIso } from "@socrates/shared"
import { and, eq } from "drizzle-orm"
import { aiUsageEvents, contextUsageSnapshots, modelCalls, modelStreamChunks, modelUsage } from "../../db/schema"
import { StoreBase } from "./shared"
import type { ConversationUsageReportBundle, StoredModelUsage } from "./types"

const DEFAULT_CONTEXT_BUDGET_TOKENS = 180_000

export class ModelTelemetryStore extends StoreBase {
  createModelCall(input: {
    conversationId: string
    sessionId: string
    turnId: string
    runtimeConfigId: string
    providerId: string
    modelId: string
    request: unknown
  }): string {
    const id = createId("mcall")
    this.handle.db
      .insert(modelCalls)
      .values({
        id,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        runtimeConfigId: input.runtimeConfigId,
        providerId: input.providerId,
        modelId: input.modelId,
        status: "streaming",
        requestJson: JSON.stringify(input.request),
        startedAt: nowIso(),
      })
      .run()
    return id
  }

  appendModelStreamChunk(input: {
    modelCallId: string
    turnId: string
    channel: "reasoning" | "answer" | "metadata"
    text?: string
    payload?: unknown
  }): void {
    const row = this.handle.sqlite
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM model_stream_chunks WHERE model_call_id = ?")
      .get(input.modelCallId) as { next_sequence: number }

    this.handle.db
      .insert(modelStreamChunks)
      .values({
        id: createId("chunk"),
        modelCallId: input.modelCallId,
        turnId: input.turnId,
        sequence: row.next_sequence,
        channel: input.channel,
        text: input.text,
        payloadJson: input.payload === undefined ? undefined : JSON.stringify(input.payload),
        createdAt: nowIso(),
      })
      .run()
  }

  getAnswerTextByTurnId(turnId: string): string {
    const rows = this.handle.sqlite
      .prepare(
        `SELECT mc.id AS modelCallId, msc.text AS text
         FROM model_stream_chunks msc
         INNER JOIN model_calls mc ON mc.id = msc.model_call_id
         WHERE msc.turn_id = ? AND msc.channel = 'answer'
         ORDER BY mc.started_at, msc.sequence`,
      )
      .all(turnId) as Array<{ modelCallId: string; text: string | null }>

    let text = ""
    let lastModelCallId: string | undefined
    for (const row of rows) {
      if (!row.text) {
        continue
      }
      if (
        lastModelCallId &&
        row.modelCallId !== lastModelCallId &&
        text.trim().length > 0 &&
        !startsWithParagraphBoundary(row.text)
      ) {
        text = ensureParagraphBoundary(text)
      }
      text += row.text
      lastModelCallId = row.modelCallId
    }
    return text.trim()
  }

  getReasoningTextByTurnIds(turnIds: string[]): Map<string, string> {
    const uniqueTurnIds = Array.from(new Set(turnIds))
    if (uniqueTurnIds.length === 0) {
      return new Map()
    }

    const placeholders = uniqueTurnIds.map(() => "?").join(", ")
    const rows = this.handle.sqlite
      .prepare(
        `SELECT turn_id, text
         FROM model_stream_chunks
         WHERE channel = 'reasoning' AND turn_id IN (${placeholders})
         ORDER BY turn_id, sequence`,
      )
      .all(...uniqueTurnIds) as Array<{ turn_id: string; text: string | null }>

    const reasoningByTurnId = new Map<string, string>()
    for (const row of rows) {
      if (!row.text) {
        continue
      }
      reasoningByTurnId.set(row.turn_id, `${reasoningByTurnId.get(row.turn_id) ?? ""}${row.text}`)
    }
    return reasoningByTurnId
  }

  getConversationActivitySteps(conversationId: string, toolRuns: ConversationToolRun[] = []): ConversationActivityStep[] {
    const calls = this.handle.db
      .select()
      .from(modelCalls)
      .where(eq(modelCalls.conversationId, conversationId))
      .orderBy(modelCalls.startedAt)
      .all()
    if (calls.length === 0) {
      return []
    }

    const callIds = calls.map((call) => call.id)
    const placeholders = callIds.map(() => "?").join(", ")
    const chunks = this.handle.sqlite
      .prepare(
        `SELECT model_call_id AS modelCallId, channel, text
         FROM model_stream_chunks
         WHERE model_call_id IN (${placeholders}) AND channel IN ('reasoning', 'answer')
         ORDER BY model_call_id, sequence`,
      )
      .all(...callIds) as Array<{ modelCallId: string; channel: "reasoning" | "answer"; text: string | null }>

    const textByCall = new Map<string, { reasoning: string; answer: string }>()
    for (const chunk of chunks) {
      if (!chunk.text) {
        continue
      }
      const current = textByCall.get(chunk.modelCallId) ?? { reasoning: "", answer: "" }
      if (chunk.channel === "reasoning") {
        current.reasoning += chunk.text
      } else {
        current.answer += chunk.text
      }
      textByCall.set(chunk.modelCallId, current)
    }

    const toolsByCall = new Map<string, string[]>()
    for (const run of toolRuns) {
      if (!run.modelCallId) {
        continue
      }
      toolsByCall.set(run.modelCallId, [...(toolsByCall.get(run.modelCallId) ?? []), run.toolCallId])
    }

    const stepByTurn = new Map<string, number>()
    return calls
      .map((call) => {
        const stepIndex = stepByTurn.get(call.turnId) ?? 0
        stepByTurn.set(call.turnId, stepIndex + 1)
        const text = textByCall.get(call.id)
        return {
          turnId: call.turnId,
          modelCallId: call.id,
          stepIndex,
          ...(text?.reasoning.trim() ? { reasoning: text.reasoning } : {}),
          ...(text?.answer.trim() ? { answer: text.answer } : {}),
          toolCallIds: toolsByCall.get(call.id) ?? [],
        }
      })
      .filter((step) => step.reasoning || step.answer || step.toolCallIds.length > 0)
  }

  completeModelCall(input: { modelCallId: string; response: unknown; providerResponse?: unknown; usage?: StoredModelUsage }): void {
    this.handle.db
      .update(modelCalls)
      .set({
        status: "completed",
        responseJson: JSON.stringify(input.response),
        providerResponseJson: input.providerResponse === undefined ? undefined : JSON.stringify(input.providerResponse),
        completedAt: nowIso(),
      })
      .where(eq(modelCalls.id, input.modelCallId))
      .run()

    if (!input.usage) {
      return
    }

    const call = this.handle.db.select().from(modelCalls).where(eq(modelCalls.id, input.modelCallId)).get()
    if (!call) {
      return
    }

    this.recordModelUsage({
      modelCallId: input.modelCallId,
      conversationId: call.conversationId,
      sessionId: call.sessionId,
      turnId: call.turnId,
      providerId: call.providerId,
      modelId: call.modelId,
      status: call.status,
      startedAt: call.startedAt,
      completedAt: call.completedAt ?? nowIso(),
      usage: input.usage,
    })
  }

  failModelCall(modelCallId: string, errorId?: string): void {
    this.handle.db
      .update(modelCalls)
      .set({
        status: "failed",
        errorId,
        completedAt: nowIso(),
      })
      .where(eq(modelCalls.id, modelCallId))
      .run()
  }

  cancelOpenModelCallsForTurn(turnId: string): void {
    this.handle.db
      .update(modelCalls)
      .set({
        status: "cancelled",
        completedAt: nowIso(),
      })
      .where(and(eq(modelCalls.turnId, turnId), eq(modelCalls.status, "streaming")))
      .run()
  }

  recordContextUsageSnapshot(input: {
    conversationId: string
    sessionId: string
    turnId: string
    modelCallId: string
    providerId: string
    modelId: string
    contextWindowTokens: number
    contextUsedTokens: number
    metadata?: Record<string, unknown>
  }): void {
    const contextLeftTokens = Math.max(input.contextWindowTokens - input.contextUsedTokens, 0)
    const contextUsedPercent =
      input.contextWindowTokens > 0
        ? Math.min(100, Math.round((input.contextUsedTokens / input.contextWindowTokens) * 1000) / 10)
        : 0

    this.handle.db
      .insert(contextUsageSnapshots)
      .values({
        id: createId("ctxuse"),
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        modelCallId: input.modelCallId,
        providerId: input.providerId,
        modelId: input.modelId,
        contextWindowTokens: input.contextWindowTokens,
        contextUsedTokens: input.contextUsedTokens,
        contextLeftTokens,
        contextUsedPercent,
        metadataJson: input.metadata === undefined ? undefined : JSON.stringify(input.metadata),
        createdAt: nowIso(),
      })
      .run()
  }

  getLatestConversationContextUsage(conversationId: string): ConversationContextUsage | undefined {
    const row = this.handle.sqlite
      .prepare(
        `SELECT provider_id, model_id, context_window_tokens, context_used_tokens, context_left_tokens, context_used_percent
         FROM context_usage_snapshots
         WHERE conversation_id = ?
           AND json_extract(COALESCE(metadata_json, '{}'), '$.source') = 'model_context_estimate'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(conversationId) as
      | {
          provider_id: string
          model_id: string
          context_window_tokens: number | bigint
          context_used_tokens: number | bigint
          context_left_tokens: number | bigint
          context_used_percent: number
        }
      | undefined

    if (!row) {
      return this.estimateLatestConversationContextUsage(conversationId)
    }

    return {
      providerId: row.provider_id,
      modelId: row.model_id,
      contextWindowTokens: Number(row.context_window_tokens),
      contextUsedTokens: Number(row.context_used_tokens),
      contextLeftTokens: Number(row.context_left_tokens),
      contextUsedPercent: row.context_used_percent,
    }
  }

  private estimateLatestConversationContextUsage(conversationId: string): ConversationContextUsage | undefined {
    const row = this.handle.sqlite
      .prepare(
        `SELECT provider_id, model_id, request_json
         FROM model_calls
         WHERE conversation_id = ?
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(conversationId) as { provider_id: string; model_id: string; request_json: string } | undefined

    if (!row) {
      return undefined
    }

    const estimate = estimateRequestTokens(row.request_json)
    const contextWindowTokens = estimate.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS
    const contextUsedTokens = Math.min(estimate.estimatedTokens, contextWindowTokens)
    const contextLeftTokens = Math.max(contextWindowTokens - contextUsedTokens, 0)
    const contextUsedPercent =
      contextWindowTokens > 0 ? Math.min(100, Math.round((contextUsedTokens / contextWindowTokens) * 1000) / 10) : 0

    return {
      providerId: row.provider_id,
      modelId: row.model_id,
      contextWindowTokens,
      contextUsedTokens,
      contextLeftTokens,
      contextUsedPercent,
    }
  }

  getConversationTokenUsage(conversationId: string): ConversationTokenUsage {
    const row = this.handle.sqlite
      .prepare(
        `SELECT
          COALESCE(SUM(COALESCE(mu.total_tokens, COALESCE(mu.input_tokens, 0) + COALESCE(mu.output_tokens, 0) + COALESCE(mu.reasoning_tokens, 0))), 0) AS total_tokens,
          COALESCE(SUM(COALESCE(mu.input_tokens, 0)), 0) AS input_tokens,
          COALESCE(SUM(COALESCE(mu.output_tokens, 0)), 0) AS output_tokens,
          COALESCE(SUM(COALESCE(mu.reasoning_tokens, 0)), 0) AS reasoning_tokens
        FROM model_usage mu
        INNER JOIN turns t ON t.id = mu.turn_id
        WHERE t.conversation_id = ?`,
      )
      .get(conversationId) as {
      total_tokens: number | bigint
      input_tokens: number | bigint
      output_tokens: number | bigint
      reasoning_tokens: number | bigint
    }

    return {
      totalTokens: Number(row.total_tokens),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      reasoningTokens: Number(row.reasoning_tokens),
    }
  }

  recordContextCompactionUsage(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId?: string
    snapshotId: string
    providerId: string
    modelId: string
    status: string
    startedAt?: string
    completedAt?: string
    usage?: StoredModelUsage
  }): void {
    if (!input.turnId || !input.usage) {
      return
    }
    this.recordAiUsageEvent({
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceKind: "context_compaction",
      sourceId: input.snapshotId,
      providerId: input.providerId,
      modelId: input.modelId,
      status: input.status,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      usage: input.usage,
    })
  }

  recordConversationTitleUsage(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    sourceId: string
    providerId: string
    modelId: string
    status: string
    startedAt?: string
    completedAt?: string
    usage?: StoredModelUsage
  }): void {
    if (!input.usage) {
      return
    }
    this.recordAiUsageEvent({
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceKind: "conversation_title",
      sourceId: input.sourceId,
      providerId: input.providerId,
      modelId: input.modelId,
      status: input.status,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      usage: input.usage,
    })
  }

  recordMemoryRouterUsage(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    sourceId: string
    providerId: string
    modelId: string
    status: string
    startedAt?: string
    completedAt?: string
    usage?: StoredModelUsage
    metadata?: Record<string, unknown>
  }): void {
    if (!input.usage) {
      return
    }
    this.recordAiUsageEvent({
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceKind: "memory_router",
      sourceId: input.sourceId,
      providerId: input.providerId,
      modelId: input.modelId,
      status: input.status,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      usage: input.usage,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
  }

  buildTurnUsageReport(turnId: string): TurnUsageReport | undefined {
    const rows = this.getAiUsageEventRowsByTurn(turnId)
    if (rows.length === 0) {
      return
    }

    const totals = aggregateUsage(rows)
    const costSource = aggregateCostSource(rows.map((row) => row.cost_source))
    const qualityFlags = usageQualityFlags(rows)
    const report: TurnUsageReport = {
      turnId,
      ...(totals.costUsd === undefined ? {} : { totalCostUsd: totals.costUsd }),
      totalTokens: totals.totalTokens,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens,
      cachedInputTokens: totals.cachedInputTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      uncachedInputTokens: totals.uncachedInputTokens,
      costSource,
      providerBreakdown: groupUsageBreakdown(rows, (row) => row.provider_id, (key) => ({ key, providerId: key as ProviderId })),
      modelBreakdown: groupUsageBreakdown(rows, (row) => `${row.provider_id}:${row.model_id}`, (key, row) => ({
        key,
        providerId: row.provider_id as ProviderId,
        modelId: row.model_id,
      })),
      callBreakdown: rows
        .filter((row) => row.source_kind === "main_model_call")
        .map((row) => eventBreakdownItem(row)),
      compactionBreakdown: rows
        .filter((row) => row.source_kind === "context_compaction")
        .map((row) => eventBreakdownItem(row)),
      qualityFlags,
    }

    const first = rows[0] as AiUsageEventRow
    const now = nowIso()
    this.handle.sqlite
      .prepare(
        `INSERT INTO turn_usage_reports (
          turn_id, project_id, conversation_id, session_id, status, total_cost_usd, total_tokens,
          input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, cache_write_tokens,
          uncached_input_tokens, cost_source, provider_breakdown_json, model_breakdown_json,
          call_breakdown_json, compaction_breakdown_json, quality_flags_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          status = excluded.status,
          total_cost_usd = excluded.total_cost_usd,
          total_tokens = excluded.total_tokens,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          uncached_input_tokens = excluded.uncached_input_tokens,
          cost_source = excluded.cost_source,
          provider_breakdown_json = excluded.provider_breakdown_json,
          model_breakdown_json = excluded.model_breakdown_json,
          call_breakdown_json = excluded.call_breakdown_json,
          compaction_breakdown_json = excluded.compaction_breakdown_json,
          quality_flags_json = excluded.quality_flags_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        report.turnId,
        first.project_id,
        first.conversation_id,
        first.session_id,
        "completed",
        report.totalCostUsd,
        report.totalTokens,
        report.inputTokens,
        report.outputTokens,
        report.reasoningTokens,
        report.cachedInputTokens,
        report.cacheWriteTokens,
        report.uncachedInputTokens,
        report.costSource,
        JSON.stringify(report.providerBreakdown),
        JSON.stringify(report.modelBreakdown),
        JSON.stringify(report.callBreakdown),
        JSON.stringify(report.compactionBreakdown),
        JSON.stringify(report.qualityFlags),
        now,
        now,
      )

    return report
  }

  getConversationUsageReportBundle(conversationId: string): ConversationUsageReportBundle {
    const rows = this.handle.sqlite
      .prepare(
        `SELECT turn_id, total_cost_usd, total_tokens, input_tokens, output_tokens, reasoning_tokens,
          cached_input_tokens, cache_write_tokens, uncached_input_tokens, cost_source,
          provider_breakdown_json, model_breakdown_json, call_breakdown_json, compaction_breakdown_json,
          quality_flags_json
         FROM turn_usage_reports
         WHERE conversation_id = ?
         ORDER BY updated_at`,
      )
      .all(conversationId) as TurnUsageReportRow[]

    const reports = rows.map(mapTurnUsageReportRow)
    const costUsage = aggregateConversationCostUsage(reports)
    return {
      costUsage,
      ...(reports.length > 0 ? { turnUsageReports: reports } : { turnUsageReports: [] }),
    }
  }

  private recordModelUsage(input: {
    modelCallId: string
    conversationId: string
    sessionId: string
    turnId: string
    providerId: string
    modelId: string
    status: string
    startedAt?: string
    completedAt?: string
    usage: StoredModelUsage
    metadata?: Record<string, unknown>
  }): void {
    this.handle.db
      .insert(modelUsage)
      .values({
        id: createId("usage"),
        modelCallId: input.modelCallId,
        turnId: input.turnId,
        providerId: input.providerId,
        modelId: input.modelId,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        reasoningTokens: input.usage.reasoningTokens,
        cachedInputTokens: input.usage.cachedInputTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        uncachedInputTokens: input.usage.uncachedInputTokens,
        totalTokens:
          input.usage.totalTokens ??
          (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0) + (input.usage.reasoningTokens ?? 0),
        costUsd: input.usage.costUsd,
        costSource: input.usage.costSource,
        routedProvider: input.usage.routedProvider,
        pricingSnapshotJson: input.usage.pricingSnapshot === undefined ? undefined : JSON.stringify(input.usage.pricingSnapshot),
        rawUsageJson: input.usage.raw === undefined ? undefined : JSON.stringify(input.usage.raw),
        metadataJson: usageMetadataJson(input.usage, input.metadata),
        createdAt: nowIso(),
      })
      .run()

    const project = this.handle.sqlite.prepare("SELECT project_id AS projectId FROM conversations WHERE id = ?").get(input.conversationId) as
      | { projectId: string }
      | undefined
    if (!project) {
      return
    }
    this.recordAiUsageEvent({
      projectId: project.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceKind: "main_model_call",
      sourceId: input.modelCallId,
      providerId: input.providerId,
      modelId: input.modelId,
      status: input.status,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      usage: input.usage,
    })
  }

  private recordAiUsageEvent(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    sourceKind: "main_model_call" | "context_compaction" | "conversation_title" | "memory_router"
    sourceId: string
    providerId: string
    modelId: string
    status: string
    startedAt?: string
    completedAt?: string
    usage: StoredModelUsage
    metadata?: Record<string, unknown>
  }): void {
    const totalTokens =
      input.usage.totalTokens ??
      (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0) + (input.usage.reasoningTokens ?? 0)
    this.handle.db
      .insert(aiUsageEvents)
      .values({
        id: createId("usage"),
        projectId: input.projectId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        providerId: input.providerId,
        modelId: input.modelId,
        status: input.status,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        reasoningTokens: input.usage.reasoningTokens,
        cachedInputTokens: input.usage.cachedInputTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        uncachedInputTokens: input.usage.uncachedInputTokens,
        totalTokens,
        costUsd: input.usage.costUsd,
        costSource: input.usage.costSource ?? "unknown",
        routedProvider: input.usage.routedProvider,
        pricingSnapshotJson: input.usage.pricingSnapshot === undefined ? undefined : JSON.stringify(input.usage.pricingSnapshot),
        rawUsageJson: input.usage.raw === undefined ? undefined : JSON.stringify(input.usage.raw),
        metadataJson: usageMetadataJson(input.usage, input.metadata),
        createdAt: nowIso(),
      })
      .onConflictDoUpdate({
        target: [aiUsageEvents.sourceKind, aiUsageEvents.sourceId],
        set: {
          status: input.status,
          completedAt: input.completedAt,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          reasoningTokens: input.usage.reasoningTokens,
          cachedInputTokens: input.usage.cachedInputTokens,
          cacheWriteTokens: input.usage.cacheWriteTokens,
          uncachedInputTokens: input.usage.uncachedInputTokens,
          totalTokens,
          costUsd: input.usage.costUsd,
          costSource: input.usage.costSource ?? "unknown",
          routedProvider: input.usage.routedProvider,
          pricingSnapshotJson: input.usage.pricingSnapshot === undefined ? undefined : JSON.stringify(input.usage.pricingSnapshot),
          rawUsageJson: input.usage.raw === undefined ? undefined : JSON.stringify(input.usage.raw),
          metadataJson: usageMetadataJson(input.usage, input.metadata),
        },
      })
      .run()
  }

  private getAiUsageEventRowsByTurn(turnId: string): AiUsageEventRow[] {
    return this.handle.sqlite
      .prepare(
        `SELECT project_id, conversation_id, session_id, turn_id, source_kind, source_id, provider_id, model_id,
          status, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, cache_write_tokens,
          uncached_input_tokens, total_tokens, cost_usd, cost_source, routed_provider
         FROM ai_usage_events
         WHERE turn_id = ?
         ORDER BY created_at`,
      )
      .all(turnId) as AiUsageEventRow[]
  }
}

const usageMetadataJson = (usage: StoredModelUsage, metadata?: Record<string, unknown>): string | undefined => {
  const value = {
    ...(usage.providerMetadata === undefined ? {} : { providerMetadata: usage.providerMetadata }),
    ...(metadata ?? {}),
  }
  return Object.keys(value).length > 0 ? JSON.stringify(value) : undefined
}

type CostSource = "provider_reported" | "computed" | "unknown" | "mixed"

type AiUsageEventRow = {
  project_id: string
  conversation_id: string
  session_id: string
  turn_id: string
  source_kind: "main_model_call" | "context_compaction" | "conversation_title" | "memory_router"
  source_id: string
  provider_id: string
  model_id: string
  status: string
  input_tokens: number | bigint | null
  output_tokens: number | bigint | null
  reasoning_tokens: number | bigint | null
  cached_input_tokens: number | bigint | null
  cache_write_tokens: number | bigint | null
  uncached_input_tokens: number | bigint | null
  total_tokens: number | bigint | null
  cost_usd: number | null
  cost_source: CostSource
  routed_provider: string | null
}

type TurnUsageReportRow = {
  turn_id: string
  total_cost_usd: number | null
  total_tokens: number | bigint
  input_tokens: number | bigint
  output_tokens: number | bigint
  reasoning_tokens: number | bigint
  cached_input_tokens: number | bigint
  cache_write_tokens: number | bigint
  uncached_input_tokens: number | bigint
  cost_source: CostSource
  provider_breakdown_json: string
  model_breakdown_json: string
  call_breakdown_json: string
  compaction_breakdown_json: string
  quality_flags_json: string
}

const zeroTotals = () => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  uncachedInputTokens: 0,
  totalTokens: 0,
  costUsd: undefined as number | undefined,
})

const aggregateUsage = (rows: AiUsageEventRow[]) => {
  const totals = zeroTotals()
  for (const row of rows) {
    totals.inputTokens += toNumber(row.input_tokens)
    totals.outputTokens += toNumber(row.output_tokens)
    totals.reasoningTokens += toNumber(row.reasoning_tokens)
    totals.cachedInputTokens += toNumber(row.cached_input_tokens)
    totals.cacheWriteTokens += toNumber(row.cache_write_tokens)
    totals.uncachedInputTokens += toNumber(row.uncached_input_tokens)
    totals.totalTokens += toNumber(row.total_tokens)
    if (row.cost_usd !== null && row.cost_usd !== undefined) {
      totals.costUsd = (totals.costUsd ?? 0) + row.cost_usd
    }
  }
  return totals
}

const aggregateCostSource = (sources: CostSource[]): CostSource => {
  const unique = new Set(sources)
  if (unique.size === 0) {
    return "unknown"
  }
  if (unique.size === 1) {
    return unique.values().next().value ?? "unknown"
  }
  return "mixed"
}

const usageQualityFlags = (rows: AiUsageEventRow[]): string[] => {
  const flags = new Set<string>()
  if (rows.some((row) => row.cost_source === "computed")) {
    flags.add("computed_cost_present")
  }
  if (rows.some((row) => row.cost_source === "unknown" || row.cost_usd === null || row.cost_usd === undefined)) {
    flags.add("unknown_cost_present")
  }
  if (aggregateCostSource(rows.map((row) => row.cost_source)) === "mixed") {
    flags.add("mixed_cost_sources")
  }
  return [...flags]
}

const groupUsageBreakdown = (
  rows: AiUsageEventRow[],
  keyFor: (row: AiUsageEventRow) => string,
  baseFor: (key: string, row: AiUsageEventRow) => Pick<UsageBreakdownItem, "key" | "providerId" | "modelId">,
): UsageBreakdownItem[] => {
  const grouped = new Map<string, AiUsageEventRow[]>()
  for (const row of rows) {
    const key = keyFor(row)
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  return [...grouped.entries()].map(([key, group]) => {
    const totals = aggregateUsage(group)
    const base = baseFor(key, group[0] as AiUsageEventRow)
    return {
      ...base,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens,
      cachedInputTokens: totals.cachedInputTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      uncachedInputTokens: totals.uncachedInputTokens,
      totalTokens: totals.totalTokens,
      ...(totals.costUsd === undefined ? {} : { costUsd: totals.costUsd }),
      costSource: aggregateCostSource(group.map((row) => row.cost_source)),
    }
  })
}

const eventBreakdownItem = (row: AiUsageEventRow): UsageBreakdownItem => ({
  key: row.source_id,
  providerId: row.provider_id as ProviderId,
  modelId: row.model_id,
  sourceKind: row.source_kind,
  sourceId: row.source_id,
  status: row.status,
  inputTokens: toNumber(row.input_tokens),
  outputTokens: toNumber(row.output_tokens),
  reasoningTokens: toNumber(row.reasoning_tokens),
  cachedInputTokens: toNumber(row.cached_input_tokens),
  cacheWriteTokens: toNumber(row.cache_write_tokens),
  uncachedInputTokens: toNumber(row.uncached_input_tokens),
  totalTokens: toNumber(row.total_tokens),
  ...(row.cost_usd === null || row.cost_usd === undefined ? {} : { costUsd: row.cost_usd }),
  costSource: row.cost_source,
  ...(row.routed_provider ? { routedProvider: row.routed_provider } : {}),
})

const mapTurnUsageReportRow = (row: TurnUsageReportRow): TurnUsageReport => ({
  turnId: row.turn_id,
  ...(row.total_cost_usd === null || row.total_cost_usd === undefined ? {} : { totalCostUsd: row.total_cost_usd }),
  totalTokens: toNumber(row.total_tokens),
  inputTokens: toNumber(row.input_tokens),
  outputTokens: toNumber(row.output_tokens),
  reasoningTokens: toNumber(row.reasoning_tokens),
  cachedInputTokens: toNumber(row.cached_input_tokens),
  cacheWriteTokens: toNumber(row.cache_write_tokens),
  uncachedInputTokens: toNumber(row.uncached_input_tokens),
  costSource: row.cost_source,
  providerBreakdown: parseJsonArray(row.provider_breakdown_json),
  modelBreakdown: parseJsonArray(row.model_breakdown_json),
  callBreakdown: parseJsonArray(row.call_breakdown_json),
  compactionBreakdown: parseJsonArray(row.compaction_breakdown_json),
  qualityFlags: parseJsonArray(row.quality_flags_json),
})

const aggregateConversationCostUsage = (reports: TurnUsageReport[]): ConversationCostUsage => {
  const knownCostReports = reports.filter((report) => report.totalCostUsd !== undefined)
  const totalCostUsd = knownCostReports.length > 0 ? knownCostReports.reduce((sum, report) => sum + (report.totalCostUsd ?? 0), 0) : undefined
  const sources = reports.map((report) => report.costSource)
  const hasComputedCost = reports.some((report) => report.costSource === "computed" || report.costSource === "mixed" || report.qualityFlags.includes("computed_cost_present"))
  const hasUnknownCost = reports.some((report) => report.costSource === "unknown" || report.costSource === "mixed" || report.qualityFlags.includes("unknown_cost_present"))
  return {
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    totalTokens: reports.reduce((sum, report) => sum + report.totalTokens, 0),
    cachedInputTokens: reports.reduce((sum, report) => sum + report.cachedInputTokens, 0),
    cacheWriteTokens: reports.reduce((sum, report) => sum + report.cacheWriteTokens, 0),
    turnCount: reports.length,
    costSource: aggregateCostSource(sources),
    hasComputedCost,
    hasUnknownCost,
  }
}

const parseJsonArray = <T>(value: string): T[] => {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

const toNumber = (value: number | bigint | null | undefined): number => (value === null || value === undefined ? 0 : Number(value))

const estimateRequestTokens = (requestJson: string): { estimatedTokens: number; contextBudgetTokens?: number } => {
  try {
    const parsed = JSON.parse(requestJson) as {
      estimatedTokens?: unknown
      contextBudgetTokens?: unknown
    }
    const estimatedTokens =
      typeof parsed.estimatedTokens === "number" && Number.isFinite(parsed.estimatedTokens)
        ? Math.max(0, Math.ceil(parsed.estimatedTokens))
        : estimateTextTokens(requestJson).inputTokens
    return {
      estimatedTokens,
      ...(typeof parsed.contextBudgetTokens === "number" && Number.isFinite(parsed.contextBudgetTokens)
        ? { contextBudgetTokens: Math.max(1, Math.ceil(parsed.contextBudgetTokens)) }
        : {}),
    }
  } catch {
    return { estimatedTokens: estimateTextTokens(requestJson).inputTokens }
  }
}

const ensureParagraphBoundary = (text: string): string => (text.endsWith("\n\n") ? text : `${text.trimEnd()}\n\n`)

const startsWithParagraphBoundary = (text: string): boolean => /^\s*\n\s*\n/.test(text)
