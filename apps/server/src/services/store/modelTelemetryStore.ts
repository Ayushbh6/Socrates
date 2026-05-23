import type { ConversationTokenUsage } from "@socrates/contracts"
import { createId, nowIso } from "@socrates/shared"
import { and, eq } from "drizzle-orm"
import { contextUsageSnapshots, modelCalls, modelStreamChunks, modelUsage } from "../../db/schema"
import { StoreBase } from "./shared"
import type { StoredModelUsage } from "./types"

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

  completeModelCall(input: { modelCallId: string; response: unknown; usage?: StoredModelUsage }): void {
    this.handle.db
      .update(modelCalls)
      .set({
        status: "completed",
        responseJson: JSON.stringify(input.response),
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
      turnId: call.turnId,
      providerId: call.providerId,
      modelId: call.modelId,
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
        createdAt: nowIso(),
      })
      .run()
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

  private recordModelUsage(input: {
    modelCallId: string
    turnId: string
    providerId: string
    modelId: string
    usage: StoredModelUsage
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
        totalTokens:
          input.usage.totalTokens ??
          (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0) + (input.usage.reasoningTokens ?? 0),
        rawUsageJson: input.usage.raw === undefined ? undefined : JSON.stringify(input.usage.raw),
        createdAt: nowIso(),
      })
      .run()
  }
}

const ensureParagraphBoundary = (text: string): string => (text.endsWith("\n\n") ? text : `${text.trimEnd()}\n\n`)

const startsWithParagraphBoundary = (text: string): boolean => /^\s*\n\s*\n/.test(text)
