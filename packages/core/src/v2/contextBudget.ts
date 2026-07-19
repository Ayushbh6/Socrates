import { DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS } from "../context/contextCompression"
import type { V2ContextBudget } from "./types"

/**
 * Flow is another view of Socrates, not another agent runtime. Keep the V2
 * projection budget pinned to the exact Classic chat-compression constants.
 * The selected model's advertised window remains metadata for telemetry and
 * provider compatibility; it never changes Socrates' compaction policy.
 */
export const deriveV2ContextBudget = (): V2ContextBudget => {
  const thresholds = DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS
  return {
    softPruneTriggerTokens: thresholds.triggerTokens,
    compactionTriggerTokens: thresholds.triggerTokens,
    postPruneTargetTokens: thresholds.preferredTargetTokens,
    postCompactionTargetTokens: thresholds.postCompactionTargetTokens,
    hardInputLimitTokens: thresholds.hardLimitTokens,
    recentGoalTailTokens: thresholds.recentTailTargetTokens,
  }
}

export type V2ContextPressure = "comfortable" | "prune" | "compact" | "hard_limit"

export const classifyV2ContextPressure = (usedInputTokens: number, budget: V2ContextBudget): V2ContextPressure => {
  const used = Math.max(0, Math.floor(Number.isFinite(usedInputTokens) ? usedInputTokens : 0))
  if (used >= budget.hardInputLimitTokens) return "hard_limit"
  if (used >= budget.compactionTriggerTokens) return "compact"
  if (used >= budget.softPruneTriggerTokens) return "prune"
  return "comfortable"
}
