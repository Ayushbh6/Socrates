import type {
  CompleteCompactionSnapshotInput,
  ContextCompactionSummary,
  ContextCompressionRuntime,
  ContextCompressionThresholds,
  FailCompactionSnapshotInput,
  StartCompactionSnapshotInput,
} from "@socrates/core"
import { deriveV2ContextBudget } from "@socrates/core"
import type { V2RuntimeConfig, WorkerModelSettings } from "@socrates/contracts"
import type { ModelUsage } from "@socrates/providers"
import type { SocratesStore } from "../store"
import type { V2FlowStore } from "./flowStore"

const SNAPSHOT_STARTED = "v2_within_turn_compaction_started"
const SNAPSHOT_COMPLETED = "v2_within_turn_compaction_completed"
const SNAPSHOT_FAILED = "v2_within_turn_compaction_failed"

type SharedCompressionSettingsStore = Pick<SocratesStore, "getWorkerModelSetting" | "listAvailableModels">

export type CreateV2ContextCompressionRuntimeInput = Readonly<{
  store: V2FlowStore
  sharedStore: SharedCompressionSettingsStore
  projectId: string
  flowId: string
  goalId: string
  turnId: string
  workspacePath: string
  runtimeConfig: V2RuntimeConfig
}>

/**
 * Adapts the shared core compactor to V2-only durable state. Exact tool output
 * remains in v2_evidence_items; snapshots only change the next model request.
 */
export const createV2ContextCompressionRuntime = (
  input: CreateV2ContextCompressionRuntimeInput,
): ContextCompressionRuntime => {
  const compressor = input.sharedStore.getWorkerModelSetting("socrates_context_compactor")
  const fallback = contextCompressorFallback(input.sharedStore, compressor)
  const thresholds = v2WithinTurnCompressionThresholds(input.runtimeConfig.contextWindowTokens ?? 128_000)
  const modelCalls = new Map<string, string>()

  return {
    enabled: process.env.SOCRATES_CONTEXT_COMPRESSION_ENABLED !== "false",
    mode: "chat",
    projectId: input.projectId,
    // The core compactor uses this only as an exact trace handle. Flow is the
    // V2 conversation boundary; no Classic conversation row is created.
    conversationId: input.flowId,
    sessionId: input.flowId,
    turnId: input.turnId,
    workspacePath: input.workspacePath,
    thresholds,
    compressorProviderId: compressor.providerId,
    compressorAuthMode: compressor.authMode ?? "api_key",
    compressorModelId: compressor.modelId,
    compressorThinkingEnabled: compressor.thinkingEnabled,
    ...(compressor.thinkingEffort ? { compressorThinkingEffort: compressor.thinkingEffort } : {}),
    ...(fallback ? { compressorFallbacks: [fallback] } : {}),
    getLatestSnapshot: () => latestCompletedSnapshot(input.store, input.flowId, input.goalId),
    startSnapshot: (snapshot) => {
      const modelCallId = input.store.createModelCall({
        projectId: input.projectId,
        flowId: input.flowId,
        goalId: input.goalId,
        turnId: input.turnId,
        role: "context_compactor",
        providerId: snapshot.compressorProviderId,
        modelId: snapshot.compressorModelId,
        request: {
          phase: "within_turn_context_compaction",
          snapshotId: snapshot.snapshotId,
          reason: snapshot.reason,
          contextTokensEstimate: snapshot.contextTokensEstimate,
          targetTokens: snapshot.targetTokens,
          sourceMessageIds: snapshot.sourceMessageIds,
          sourceTurnIds: snapshot.sourceTurnIds,
          ...(snapshot.previousSnapshotId ? { previousSnapshotId: snapshot.previousSnapshotId } : {}),
        },
      })
      modelCalls.set(snapshot.snapshotId, modelCallId)
      input.store.recordEvidence({
        projectId: input.projectId,
        flowId: input.flowId,
        goalId: input.goalId,
        turnId: input.turnId,
        sourceKind: "system",
        sourceId: modelCallId,
        title: `Flow within-turn compaction ${snapshot.snapshotId} started`,
        content: JSON.stringify(snapshotAudit(snapshot)),
        locator: { kind: SNAPSHOT_STARTED, snapshotId: snapshot.snapshotId },
        metadata: {
          kind: SNAPSHOT_STARTED,
          snapshotId: snapshot.snapshotId,
          goalId: input.goalId,
          modelCallId,
        },
        includeInContext: false,
      })
    },
    completeSnapshot: (snapshot) => {
      const modelCallId = modelCalls.get(snapshot.snapshotId)
      const recorded = input.store.recordEvidence({
        projectId: input.projectId,
        flowId: input.flowId,
        goalId: input.goalId,
        turnId: input.turnId,
        sourceKind: "model_output",
        ...(modelCallId ? { sourceId: modelCallId } : {}),
        title: `Flow within-turn compaction ${snapshot.snapshotId}`,
        content: snapshot.renderedSummary,
        locator: {
          kind: SNAPSHOT_COMPLETED,
          snapshotId: snapshot.snapshotId,
          sourceHandles: snapshot.sourceHandles,
        },
        metadata: completedSnapshotMetadata(input.goalId, modelCallId, snapshot),
        includeInContext: false,
      })
      if (modelCallId) {
        input.store.completeModelCall({
          modelCallId,
          response: {
            snapshotId: snapshot.snapshotId,
            evidenceHandle: recorded.evidence.handle,
            inputTokensEstimate: snapshot.inputTokensEstimate,
            outputTokensEstimate: snapshot.outputTokensEstimate,
            contextTokensAfter: snapshot.contextTokensAfter,
            compressorProviderId: snapshot.compressorProviderId,
            compressorModelId: snapshot.compressorModelId,
          },
        })
        if (snapshot.usage) recordUsage(input.store, modelCallId, snapshot.usage)
        modelCalls.delete(snapshot.snapshotId)
      }
    },
    failSnapshot: (snapshot) => {
      const modelCallId = modelCalls.get(snapshot.snapshotId)
      const error = input.store.recordError({
        projectId: input.projectId,
        flowId: input.flowId,
        goalId: input.goalId,
        turnId: input.turnId,
        source: "context_compactor",
        code: snapshot.code,
        message: snapshot.message,
        details: snapshot.details,
        recoverable: true,
      })
      input.store.recordEvidence({
        projectId: input.projectId,
        flowId: input.flowId,
        goalId: input.goalId,
        turnId: input.turnId,
        sourceKind: "system",
        ...(modelCallId ? { sourceId: modelCallId } : {}),
        title: `Flow within-turn compaction ${snapshot.snapshotId} failed`,
        content: JSON.stringify({ snapshotId: snapshot.snapshotId, code: snapshot.code, message: snapshot.message }),
        locator: { kind: SNAPSHOT_FAILED, snapshotId: snapshot.snapshotId, errorId: error.id },
        metadata: {
          kind: SNAPSHOT_FAILED,
          snapshotId: snapshot.snapshotId,
          goalId: input.goalId,
          errorId: error.id,
          ...(modelCallId ? { modelCallId } : {}),
        },
        includeInContext: false,
      })
      if (modelCallId) {
        input.store.completeModelCall({ modelCallId, errorId: error.id })
        modelCalls.delete(snapshot.snapshotId)
      }
    },
  }
}

export const v2WithinTurnCompressionThresholds = (
  contextWindowTokens: number,
): ContextCompressionThresholds => {
  const budget = deriveV2ContextBudget({ contextWindowTokens: Math.max(2_048, Math.floor(contextWindowTokens)) })
  return {
    triggerTokens: budget.compactionTriggerTokens,
    excellentTargetTokens: budget.postCompactionTargetTokens,
    preferredTargetTokens: budget.postCompactionTargetTokens,
    postCompactionTargetTokens: budget.postCompactionTargetTokens,
    hardLimitTokens: budget.hardInputLimitTokens,
    minimumReductionTokens: Math.max(
      1_024,
      Math.min(20_000, budget.compactionTriggerTokens - budget.postCompactionTargetTokens),
    ),
    recentTailTargetTokens: budget.recentGoalTailTokens,
    currentTurnToolTailTargetTokens: Math.max(4_096, Math.min(50_000, budget.recentGoalTailTokens)),
    currentTurnToolResultFloor: 5,
  }
}

const latestCompletedSnapshot = (
  store: V2FlowStore,
  flowId: string,
  goalId: string,
): ContextCompactionSummary | undefined => {
  const latest = store.getLatestEvidenceByMetadata(flowId, { kind: SNAPSHOT_COMPLETED, goalId })
  if (!latest) return undefined
  const metadata = asRecord(latest.metadata)
  if (typeof metadata.snapshotId !== "string" || typeof metadata.outputTokensEstimate !== "number") return undefined
  if (!isRecord(metadata.summary) || !Array.isArray(metadata.sourceHandles)) return undefined
  return {
    snapshotId: metadata.snapshotId,
    ...(typeof metadata.previousSnapshotId === "string" ? { previousSnapshotId: metadata.previousSnapshotId } : {}),
    summary: metadata.summary as ContextCompactionSummary["summary"],
    renderedSummary: latest.exactContent,
    sourceHandles: metadata.sourceHandles.filter(isRecord),
    outputTokensEstimate: metadata.outputTokensEstimate,
  }
}

const completedSnapshotMetadata = (
  goalId: string,
  modelCallId: string | undefined,
  snapshot: CompleteCompactionSnapshotInput,
): Record<string, unknown> => ({
  kind: SNAPSHOT_COMPLETED,
  snapshotId: snapshot.snapshotId,
  goalId,
  ...(modelCallId ? { modelCallId } : {}),
  summary: snapshot.summary,
  sourceHandles: snapshot.sourceHandles,
  inputTokensEstimate: snapshot.inputTokensEstimate,
  outputTokensEstimate: snapshot.outputTokensEstimate,
  contextTokensAfter: snapshot.contextTokensAfter,
  ...(snapshot.compressorProviderId ? { compressorProviderId: snapshot.compressorProviderId } : {}),
  ...(snapshot.compressorModelId ? { compressorModelId: snapshot.compressorModelId } : {}),
})

const snapshotAudit = (snapshot: StartCompactionSnapshotInput): Record<string, unknown> => ({
  snapshotId: snapshot.snapshotId,
  reason: snapshot.reason,
  contextTokensEstimate: snapshot.contextTokensEstimate,
  targetTokens: snapshot.targetTokens,
  compressorProviderId: snapshot.compressorProviderId,
  compressorModelId: snapshot.compressorModelId,
  sourceMessageIds: snapshot.sourceMessageIds,
  sourceTurnIds: snapshot.sourceTurnIds,
  ...(snapshot.previousSnapshotId ? { previousSnapshotId: snapshot.previousSnapshotId } : {}),
})

const contextCompressorFallback = (
  sharedStore: SharedCompressionSettingsStore,
  primary: WorkerModelSettings,
): NonNullable<ContextCompressionRuntime["compressorFallbacks"]>[number] | undefined => {
  const available = sharedStore.listAvailableModels()
  const fallback = available.defaultModel
    ? available.models.find(
        (model) =>
          model.providerId === available.defaultModel?.providerId &&
          model.authMode === available.defaultModel?.authMode &&
          model.modelId === available.defaultModel?.modelId,
      )
    : undefined
  if (!fallback || (
    fallback.providerId === primary.providerId &&
    fallback.authMode === (primary.authMode ?? "api_key") &&
    fallback.modelId === primary.modelId
  )) return undefined
  const thinking = fallback.thinkingOptions.find((option) => option.id === fallback.defaultThinkingOptionId) ?? fallback.thinkingOptions[0]
  return {
    providerId: fallback.providerId,
    authMode: fallback.authMode,
    modelId: fallback.modelId,
    thinkingEnabled: thinking?.enabled ?? false,
    ...(thinking?.effort ? { thinkingEffort: thinking.effort } : {}),
  }
}

const recordUsage = (store: V2FlowStore, modelCallId: string, usage: ModelUsage): void => {
  store.recordUsage({
    modelCallId,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  })
}

const asRecord = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {}
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)

export type V2WithinTurnCompactionFailure = FailCompactionSnapshotInput
