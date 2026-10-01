import type { V2ContextBudget } from "./types"

export const DEFAULT_V2_CONTEXT_BUDGET_RATIOS = {
  reservedOutput: 0.1,
  systemAndTools: 0.05,
  softPruneTrigger: 0.65,
  compactionTrigger: 0.8,
  postPruneTarget: 0.55,
  postCompactionTarget: 0.4,
  recentGoalTail: 0.25,
} as const

export type V2ContextBudgetRatios = Readonly<{
  reservedOutput: number
  systemAndTools: number
  softPruneTrigger: number
  compactionTrigger: number
  postPruneTarget: number
  postCompactionTarget: number
  recentGoalTail: number
}>

export const deriveV2ContextBudget = (input: {
  contextWindowTokens: number
  reservedOutputTokens?: number
  systemAndToolReserveTokens?: number
  ratios?: Partial<V2ContextBudgetRatios>
}): V2ContextBudget => {
  const contextWindowTokens = positiveInteger(input.contextWindowTokens, "contextWindowTokens")
  if (contextWindowTokens < 2_048) throw new Error("V2 contextWindowTokens must be at least 2048.")
  const ratios = { ...DEFAULT_V2_CONTEXT_BUDGET_RATIOS, ...input.ratios }
  validateRatios(ratios)
  const reservedOutputTokens = input.reservedOutputTokens === undefined
    ? boundedRatioReserve(contextWindowTokens, ratios.reservedOutput, 512, 16_384)
    : nonNegativeInteger(input.reservedOutputTokens, "reservedOutputTokens")
  const systemAndToolReserveTokens = input.systemAndToolReserveTokens === undefined
    ? boundedRatioReserve(contextWindowTokens, ratios.systemAndTools, 256, 8_192)
    : nonNegativeInteger(input.systemAndToolReserveTokens, "systemAndToolReserveTokens")
  const usableInputTokens = contextWindowTokens - reservedOutputTokens - systemAndToolReserveTokens
  if (usableInputTokens < 1_024) {
    throw new Error("V2 context reserves leave fewer than 1024 usable input tokens.")
  }
  return {
    contextWindowTokens,
    reservedOutputTokens,
    systemAndToolReserveTokens,
    usableInputTokens,
    softPruneTriggerTokens: Math.floor(usableInputTokens * ratios.softPruneTrigger),
    compactionTriggerTokens: Math.floor(usableInputTokens * ratios.compactionTrigger),
    postPruneTargetTokens: Math.floor(usableInputTokens * ratios.postPruneTarget),
    postCompactionTargetTokens: Math.floor(usableInputTokens * ratios.postCompactionTarget),
    hardInputLimitTokens: usableInputTokens,
    recentGoalTailTokens: Math.max(256, Math.floor(usableInputTokens * ratios.recentGoalTail)),
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

const validateRatios = (ratios: V2ContextBudgetRatios): void => {
  for (const [name, ratio] of Object.entries(ratios)) {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new Error(`${name} must be between 0 and 1.`)
  }
  if (ratios.reservedOutput + ratios.systemAndTools >= 0.5) throw new Error("V2 context reserve ratios must leave at least half the model window for input.")
  if (!(ratios.postCompactionTarget < ratios.postPruneTarget && ratios.postPruneTarget < ratios.softPruneTrigger && ratios.softPruneTrigger < ratios.compactionTrigger)) {
    throw new Error("V2 context pressure ratios must increase from compaction target through compaction trigger.")
  }
}

const boundedRatioReserve = (window: number, ratio: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.floor(window * ratio)))

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`)
  return value
}

const nonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`)
  return value
}
