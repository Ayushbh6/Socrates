import type {
  CompleteCompactionSnapshotInput,
  ContextCompactionSummary,
  FailCompactionSnapshotInput,
  StartCompactionSnapshotInput,
} from "@socrates/core"
import { nowIso } from "@socrates/shared"
import { and, desc, eq } from "drizzle-orm"
import { contextCompactionSnapshots } from "../../db/schema"
import { StoreBase } from "./shared"
import type { ErrorStore } from "./errorStore"

export type CompletedCompactionSnapshotRecord = {
  projectId: string
  conversationId: string
  sessionId: string
  turnId?: string
  snapshotId: string
  renderedSummary: string
  sourceHandles: Array<Record<string, unknown>>
}

export class ContextCompactionStore extends StoreBase {
  constructor(
    context: ConstructorParameters<typeof StoreBase>[0],
    private readonly errors: ErrorStore,
  ) {
    super(context)
  }

  getLatestActive(conversationId: string): ContextCompactionSummary | undefined {
    const row = this.handle.db
      .select()
      .from(contextCompactionSnapshots)
      .where(and(eq(contextCompactionSnapshots.conversationId, conversationId), eq(contextCompactionSnapshots.active, true)))
      .orderBy(desc(contextCompactionSnapshots.completedAt))
      .limit(1)
      .get()

    if (!row || !row.renderedSummary || !row.summaryJson) {
      return undefined
    }

    return {
      snapshotId: row.id,
      ...(row.previousSnapshotId ? { previousSnapshotId: row.previousSnapshotId } : {}),
      summary: parseJson(row.summaryJson),
      renderedSummary: row.renderedSummary,
      sourceHandles: parseArray(row.sourceHandlesJson),
      outputTokensEstimate: row.outputTokensEstimate ?? 0,
    }
  }

  start(input: StartCompactionSnapshotInput & { projectId: string; conversationId: string; sessionId: string; turnId: string }): void {
    this.handle.db
      .insert(contextCompactionSnapshots)
      .values({
        id: input.snapshotId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        previousSnapshotId: input.previousSnapshotId,
        status: "running",
        active: false,
        reason: input.reason,
        sourceMessageIdsJson: JSON.stringify(input.sourceMessageIds),
        sourceTurnIdsJson: JSON.stringify(input.sourceTurnIds),
        contextTokensBefore: input.contextTokensEstimate,
        targetTokens: input.targetTokens,
        compressorProviderId: input.compressorProviderId,
        compressorModelId: input.compressorModelId,
        startedAt: nowIso(),
      })
      .run()
  }

  complete(input: CompleteCompactionSnapshotInput): CompletedCompactionSnapshotRecord | undefined {
    const row = this.handle.db.select().from(contextCompactionSnapshots).where(eq(contextCompactionSnapshots.id, input.snapshotId)).get()
    if (!row) {
      return
    }

    const now = nowIso()
    this.handle.db
      .update(contextCompactionSnapshots)
      .set({ active: false })
      .where(eq(contextCompactionSnapshots.conversationId, row.conversationId))
      .run()
    this.handle.db
      .update(contextCompactionSnapshots)
      .set({
        status: "completed",
        active: true,
        summaryJson: JSON.stringify(input.summary),
        renderedSummary: input.renderedSummary,
        sourceHandlesJson: JSON.stringify(input.sourceHandles),
        inputTokensEstimate: input.inputTokensEstimate,
        outputTokensEstimate: input.outputTokensEstimate,
        contextTokensAfter: input.contextTokensAfter,
        usageJson: input.usage === undefined ? undefined : JSON.stringify(input.usage),
        ...(input.compressorProviderId ? { compressorProviderId: input.compressorProviderId } : {}),
        ...(input.compressorModelId ? { compressorModelId: input.compressorModelId } : {}),
        completedAt: now,
      })
      .where(eq(contextCompactionSnapshots.id, input.snapshotId))
      .run()

    return {
      projectId: row.projectId,
      conversationId: row.conversationId,
      sessionId: row.sessionId,
      ...(row.turnId ? { turnId: row.turnId } : {}),
      snapshotId: input.snapshotId,
      renderedSummary: input.renderedSummary,
      sourceHandles: input.sourceHandles,
    }
  }

  fail(input: FailCompactionSnapshotInput): string {
    const row = this.handle.db.select().from(contextCompactionSnapshots).where(eq(contextCompactionSnapshots.id, input.snapshotId)).get()
    const errorId = this.errors.recordError({
      ...(row?.conversationId ? { conversationId: row.conversationId } : {}),
      ...(row?.sessionId ? { sessionId: row.sessionId } : {}),
      ...(row?.turnId ? { turnId: row.turnId } : {}),
      source: "core",
      code: input.code,
      message: input.message,
      details: input.details,
      recoverable: true,
    })
    this.handle.db
      .update(contextCompactionSnapshots)
      .set({
        status: "failed",
        active: false,
        errorId,
        completedAt: nowIso(),
      })
      .where(eq(contextCompactionSnapshots.id, input.snapshotId))
      .run()
    return errorId
  }
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const parseArray = (value: string | null): Array<Record<string, unknown>> => {
  if (!value) {
    return []
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : []
  } catch {
    return []
  }
}
