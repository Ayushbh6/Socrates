/**
 * Cost-efficiency evaluation for a single turn.
 *
 * This is the harness eval used to catch the two failure modes found in the
 * Socrates-vs-OpenCode benchmark:
 *   1. Expensive OpenRouter routing (same model billed at a much higher rate
 *      because requests landed on a pricey upstream endpoint).
 *   2. Token-volume / round-trip inefficiency (too many model calls and poor
 *      prompt-cache reuse, so the same context is re-billed uncached).
 *
 * It is intentionally provider/model agnostic: it operates on the per-call usage
 * records that already exist in `ai_usage_events`, so it can run as a unit eval
 * over fixtures and as an operational report over the live DB.
 */

export type TurnEfficiencyCall = {
  sourceKind: string
  modelId: string
  routedProvider?: string
  uncachedInputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd?: number
}

export type TurnEfficiencyThresholds = {
  /** Max main model calls (round-trips) before a turn is flagged. */
  maxModelCalls: number
  /** Min cache-read ratio for multi-call turns. */
  minCacheReadRatio: number
  /** Number of main calls before cache reuse is expected at all. */
  cacheRatioMinCalls: number
  /** Max blended provider-reported cost per 1M prompt tokens (cached+uncached). */
  maxBlendedInputRatePerMTokens: number
  /** Upstream providers known to be expensive / not price-optimal. */
  blockedRoutedProviders: string[]
}

export const DEFAULT_TURN_EFFICIENCY_THRESHOLDS: TurnEfficiencyThresholds = {
  maxModelCalls: 15,
  minCacheReadRatio: 0.3,
  cacheRatioMinCalls: 3,
  maxBlendedInputRatePerMTokens: 0.6,
  blockedRoutedProviders: [],
}

export type TurnEfficiencyReport = {
  modelCallCount: number
  totalUncachedInputTokens: number
  totalCachedInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  totalPromptTokens: number
  cacheReadRatio: number
  costUsd?: number
  blendedInputRatePerMTokens?: number
  routedProviders: string[]
  flags: TurnEfficiencyFlag[]
  passed: boolean
}

export type TurnEfficiencyFlag =
  | "too_many_model_calls"
  | "low_cache_read_ratio"
  | "missing_routed_provider"
  | "blocked_routed_provider"
  | "expensive_blended_rate"

const normalizeProviderName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "")

export const evaluateTurnEfficiency = (
  calls: TurnEfficiencyCall[],
  overrides: Partial<TurnEfficiencyThresholds> = {},
): TurnEfficiencyReport => {
  const thresholds = { ...DEFAULT_TURN_EFFICIENCY_THRESHOLDS, ...overrides }
  const mainCalls = calls.filter((call) => call.sourceKind === "main_model_call")

  const totalUncachedInputTokens = sum(mainCalls, (call) => call.uncachedInputTokens)
  const totalCachedInputTokens = sum(mainCalls, (call) => call.cachedInputTokens)
  const totalOutputTokens = sum(mainCalls, (call) => call.outputTokens)
  const totalReasoningTokens = sum(mainCalls, (call) => call.reasoningTokens)
  const totalPromptTokens = totalUncachedInputTokens + totalCachedInputTokens
  const cacheReadRatio = totalPromptTokens > 0 ? totalCachedInputTokens / totalPromptTokens : 0

  const costValues = mainCalls.map((call) => call.costUsd).filter((cost): cost is number => typeof cost === "number")
  const costUsd = costValues.length > 0 ? costValues.reduce((acc, cost) => acc + cost, 0) : undefined
  const blendedInputRatePerMTokens =
    costUsd !== undefined && totalPromptTokens > 0 ? (costUsd / totalPromptTokens) * 1_000_000 : undefined

  const routedProviders = [...new Set(mainCalls.map((call) => call.routedProvider).filter((p): p is string => !!p))]
  const blocked = new Set(thresholds.blockedRoutedProviders.map(normalizeProviderName))

  const flags: TurnEfficiencyFlag[] = []
  if (mainCalls.length > thresholds.maxModelCalls) {
    flags.push("too_many_model_calls")
  }
  if (mainCalls.length >= thresholds.cacheRatioMinCalls && cacheReadRatio < thresholds.minCacheReadRatio) {
    flags.push("low_cache_read_ratio")
  }
  if (mainCalls.some((call) => !call.routedProvider)) {
    flags.push("missing_routed_provider")
  }
  if (routedProviders.some((provider) => blocked.has(normalizeProviderName(provider)))) {
    flags.push("blocked_routed_provider")
  }
  if (blendedInputRatePerMTokens !== undefined && blendedInputRatePerMTokens > thresholds.maxBlendedInputRatePerMTokens) {
    flags.push("expensive_blended_rate")
  }

  return {
    modelCallCount: mainCalls.length,
    totalUncachedInputTokens,
    totalCachedInputTokens,
    totalOutputTokens,
    totalReasoningTokens,
    totalPromptTokens,
    cacheReadRatio,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(blendedInputRatePerMTokens === undefined ? {} : { blendedInputRatePerMTokens }),
    routedProviders,
    flags,
    passed: flags.length === 0,
  }
}

const sum = <T>(items: T[], pick: (item: T) => number): number => items.reduce((acc, item) => acc + pick(item), 0)
