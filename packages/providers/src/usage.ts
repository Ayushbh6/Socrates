import type { ProviderAuthMode, ProviderId } from "@socrates/contracts"
import type { ModelUsage, PricingSnapshot } from "./types"

type UsageLike = {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  uncachedInputTokens?: number
}

type OpenRouterEndpointPricing = {
  provider: string
  promptUsdPerToken: number
  completionUsdPerToken: number
  inputCacheReadUsdPerToken?: number
  inputCacheWriteUsdPerToken?: number
}

const pricingCatalog: Record<string, PricingSnapshot> = {
  "openai:gpt-5.4-mini": {
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    source: "OpenAI API pricing, standard short-context rates",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    currency: "USD",
    unit: "per_1m_tokens",
    inputUsdPer1M: 0.75,
    cachedInputUsdPer1M: 0.075,
    outputUsdPer1M: 4.5,
    effectiveAt: "2026-06-05",
  },
  "openai:gpt-5.4": {
    providerId: "openai",
    modelId: "gpt-5.4",
    source: "OpenAI API pricing, standard short-context rates",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    currency: "USD",
    unit: "per_1m_tokens",
    inputUsdPer1M: 2.5,
    cachedInputUsdPer1M: 0.25,
    outputUsdPer1M: 15,
    effectiveAt: "2026-06-05",
  },
  "openai:gpt-5": {
    providerId: "openai",
    modelId: "gpt-5",
    source: "OpenAI API pricing, standard rates",
    sourceUrl: "https://openai.com/api/pricing/",
    currency: "USD",
    unit: "per_1m_tokens",
    inputUsdPer1M: 1.25,
    cachedInputUsdPer1M: 0.125,
    outputUsdPer1M: 10,
    effectiveAt: "2026-06-08",
  },
  "google:gemini-3-flash-preview": {
    providerId: "google",
    modelId: "gemini-3-flash-preview",
    source: "Gemini Developer API pricing, paid tier text/image/video rates",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    currency: "USD",
    unit: "per_1m_tokens",
    inputUsdPer1M: 0.5,
    cachedInputUsdPer1M: 0.05,
    outputUsdPer1M: 3,
    effectiveAt: "2026-06-05",
  },
  "google:gemini-3.5-flash": {
    providerId: "google",
    modelId: "gemini-3.5-flash",
    source: "Gemini Developer API pricing, Gemini 3.5 Flash standard paid tier text/image/video rates",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    currency: "USD",
    unit: "per_1m_tokens",
    inputUsdPer1M: 1.5,
    cachedInputUsdPer1M: 0.15,
    outputUsdPer1M: 9,
    effectiveAt: "2026-06-14",
  },
  "google:gemini-3.1-flash-lite-preview": {
    providerId: "google",
    modelId: "gemini-3.1-flash-lite-preview",
    source: "Gemini Developer API pricing, Gemini 3.1 Flash-Lite standard paid tier text/image/video rates",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    currency: "USD",
    unit: "per_1m_tokens",
    inputUsdPer1M: 0.25,
    cachedInputUsdPer1M: 0.025,
    outputUsdPer1M: 1.5,
    effectiveAt: "2026-06-08",
  },
  "google:gemini-3.1-pro-preview": {
    providerId: "google",
    modelId: "gemini-3.1-pro-preview",
    source: "Gemini Developer API pricing, Gemini 3.1 Pro Preview standard paid tier text/image/video rates",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    currency: "USD",
    unit: "per_1m_tokens",
    inputUsdPer1M: 2,
    cachedInputUsdPer1M: 0.2,
    outputUsdPer1M: 12,
    longContextThresholdInputTokens: 200_000,
    longContextInputUsdPer1M: 4,
    longContextCachedInputUsdPer1M: 0.4,
    longContextOutputUsdPer1M: 18,
    effectiveAt: "2026-06-08",
  },
  "google:gemini-3.1-pro-preview-customtools": {
    providerId: "google",
    modelId: "gemini-3.1-pro-preview-customtools",
    source: "Gemini Developer API pricing, Gemini 3.1 Pro Preview standard paid tier text/image/video rates",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    currency: "USD",
    unit: "per_1m_tokens",
    inputUsdPer1M: 2,
    cachedInputUsdPer1M: 0.2,
    outputUsdPer1M: 12,
    longContextThresholdInputTokens: 200_000,
    longContextInputUsdPer1M: 4,
    longContextCachedInputUsdPer1M: 0.4,
    longContextOutputUsdPer1M: 18,
    effectiveAt: "2026-06-08",
  },
}

const openRouterPricingCatalog: Record<string, OpenRouterEndpointPricing[]> = {
  "moonshotai/kimi-k2.6": [
    { provider: "Baidu", promptUsdPerToken: 0.000000684, completionUsdPerToken: 0.00000342, inputCacheReadUsdPerToken: 0.000000144 },
    { provider: "DeepInfra", promptUsdPerToken: 0.00000075, completionUsdPerToken: 0.0000035, inputCacheReadUsdPerToken: 0.00000015 },
    { provider: "Moonshot AI", promptUsdPerToken: 0.00000095, completionUsdPerToken: 0.000004, inputCacheReadUsdPerToken: 0.00000016 },
    { provider: "Novita", promptUsdPerToken: 0.0000008, completionUsdPerToken: 0.0000034, inputCacheReadUsdPerToken: 0.00000016 },
    { provider: "Parasail", promptUsdPerToken: 0.00000075, completionUsdPerToken: 0.0000035, inputCacheReadUsdPerToken: 0.00000016 },
    { provider: "Io Net", promptUsdPerToken: 0.00000073, completionUsdPerToken: 0.00000349, inputCacheReadUsdPerToken: 0.00000025 },
    { provider: "Inceptron", promptUsdPerToken: 0.00000073, completionUsdPerToken: 0.0000035, inputCacheReadUsdPerToken: 0.00000025 },
  ],
  "z-ai/glm-5.2": [
    { provider: "Cloudflare", promptUsdPerToken: 0.0000014, completionUsdPerToken: 0.0000044, inputCacheReadUsdPerToken: 0.00000026 },
    { provider: "Z.AI", promptUsdPerToken: 0.0000014, completionUsdPerToken: 0.0000044, inputCacheReadUsdPerToken: 0.00000026 },
    { provider: "Novita", promptUsdPerToken: 0.0000014, completionUsdPerToken: 0.0000044, inputCacheReadUsdPerToken: 0.00000026 },
    { provider: "Friendli", promptUsdPerToken: 0.0000014, completionUsdPerToken: 0.0000044, inputCacheReadUsdPerToken: 0.00000026 },
    { provider: "DeepInfra", promptUsdPerToken: 0.0000014, completionUsdPerToken: 0.0000044, inputCacheReadUsdPerToken: 0.00000025 },
    { provider: "Parasail", promptUsdPerToken: 0.0000014, completionUsdPerToken: 0.0000044, inputCacheReadUsdPerToken: 0.00000026 },
    { provider: "AtlasCloud", promptUsdPerToken: 0.0000014, completionUsdPerToken: 0.0000044, inputCacheReadUsdPerToken: 0.00000026 },
    { provider: "Io Net", promptUsdPerToken: 0.00000168, completionUsdPerToken: 0.00000528, inputCacheReadUsdPerToken: 0.0000005 },
  ],
  "xiaomi/mimo-v2.5-pro": [
    { provider: "Xiaomi", promptUsdPerToken: 0.000000435, completionUsdPerToken: 0.00000087, inputCacheReadUsdPerToken: 0.0000000036 },
    { provider: "DeepInfra", promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000003, inputCacheReadUsdPerToken: 0.0000002 },
  ],
  "xiaomi/mimo-v2.5": [
    { provider: "Xiaomi", promptUsdPerToken: 0.00000014, completionUsdPerToken: 0.00000028, inputCacheReadUsdPerToken: 0.0000000028 },
  ],
  "x-ai/grok-build-0.1": [
    { provider: "xAI", promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002, inputCacheReadUsdPerToken: 0.0000002 },
  ],
  "stepfun/step-3.7-flash": [
    { provider: "StepFun", promptUsdPerToken: 0.0000002, completionUsdPerToken: 0.00000115, inputCacheReadUsdPerToken: 0.00000004 },
  ],
  "deepseek/deepseek-v4-pro": [
    { provider: "DeepSeek", promptUsdPerToken: 0.000000435, completionUsdPerToken: 0.00000087, inputCacheReadUsdPerToken: 0.000000003625 },
    { provider: "DeepInfra", promptUsdPerToken: 0.0000013, completionUsdPerToken: 0.0000026, inputCacheReadUsdPerToken: 0.0000001 },
    { provider: "Novita", promptUsdPerToken: 0.0000016, completionUsdPerToken: 0.0000032, inputCacheReadUsdPerToken: 0.000000135 },
    { provider: "SiliconFlow", promptUsdPerToken: 0.0000016, completionUsdPerToken: 0.00000348, inputCacheReadUsdPerToken: 0.000000145 },
    { provider: "Alibaba", promptUsdPerToken: 0.000001608, completionUsdPerToken: 0.000003216, inputCacheReadUsdPerToken: 0.000000134 },
    { provider: "AtlasCloud", promptUsdPerToken: 0.00000168, completionUsdPerToken: 0.00000338, inputCacheReadUsdPerToken: 0.00000013 },
  ],
  "deepseek/deepseek-v4-flash": [
    { provider: "Baidu", promptUsdPerToken: 0.0000000983, completionUsdPerToken: 0.0000001966, inputCacheReadUsdPerToken: 0.0000000197 },
    { provider: "DeepInfra", promptUsdPerToken: 0.0000001, completionUsdPerToken: 0.0000002, inputCacheReadUsdPerToken: 0.00000002 },
    { provider: "GMICloud", promptUsdPerToken: 0.000000112, completionUsdPerToken: 0.000000224, inputCacheReadUsdPerToken: 0.000000022 },
    { provider: "SiliconFlow", promptUsdPerToken: 0.00000013, completionUsdPerToken: 0.00000028, inputCacheReadUsdPerToken: 0.000000028 },
    { provider: "Alibaba", promptUsdPerToken: 0.000000134, completionUsdPerToken: 0.000000268, inputCacheReadUsdPerToken: 0.0000000268 },
    { provider: "DeepSeek", promptUsdPerToken: 0.00000014, completionUsdPerToken: 0.00000028, inputCacheReadUsdPerToken: 0.0000000028 },
    { provider: "Novita", promptUsdPerToken: 0.00000014, completionUsdPerToken: 0.00000028, inputCacheReadUsdPerToken: 0.000000028 },
    { provider: "AtlasCloud", promptUsdPerToken: 0.00000014, completionUsdPerToken: 0.00000028, inputCacheReadUsdPerToken: 0.000000028 },
  ],
  "google/gemma-4-31b-it": [
    { provider: "DeepInfra", promptUsdPerToken: 0.00000012, completionUsdPerToken: 0.00000037 },
    { provider: "SiliconFlow", promptUsdPerToken: 0.00000013, completionUsdPerToken: 0.0000004 },
    { provider: "Novita", promptUsdPerToken: 0.00000014, completionUsdPerToken: 0.0000004 },
    { provider: "Parasail", promptUsdPerToken: 0.00000015, completionUsdPerToken: 0.0000004, inputCacheReadUsdPerToken: 0.0000001 },
    { provider: "Venice", promptUsdPerToken: 0.000000155, completionUsdPerToken: 0.00000044 },
  ],
  "meta-llama/llama-4-maverick": [
    { provider: "DeepInfra", promptUsdPerToken: 0.00000015, completionUsdPerToken: 0.0000006 },
    { provider: "Novita", promptUsdPerToken: 0.00000027, completionUsdPerToken: 0.00000085 },
    { provider: "Parasail", promptUsdPerToken: 0.00000035, completionUsdPerToken: 0.000001, inputCacheReadUsdPerToken: 0.00000017 },
    { provider: "Google", promptUsdPerToken: 0.00000035, completionUsdPerToken: 0.00000115 },
  ],
  "qwen/qwen3.5-flash-02-23": [
    { provider: "Alibaba", promptUsdPerToken: 0.000000065, completionUsdPerToken: 0.00000026 },
  ],
}

export const pricingSnapshotForModel = (providerId: ProviderId, modelId: string): PricingSnapshot | undefined =>
  pricingCatalog[`${providerId}:${modelId}`]

export const openRouterPricingSnapshotForModel = (modelId: string, routedProvider?: string): PricingSnapshot | undefined => {
  const endpoints = openRouterPricingCatalog[modelId]
  if (!endpoints?.length) {
    return undefined
  }
  const endpoint =
    (routedProvider ? endpoints.find((item) => sameProviderName(item.provider, routedProvider)) : undefined) ??
    endpoints
      .slice()
      .sort(
        (left, right) =>
          left.promptUsdPerToken + left.completionUsdPerToken - (right.promptUsdPerToken + right.completionUsdPerToken),
      )[0]
  if (!endpoint) {
    return undefined
  }

  return {
    providerId: "openrouter",
    modelId,
    routedProvider: endpoint.provider,
    source: "OpenRouter endpoint pricing snapshot",
    sourceUrl: `https://openrouter.ai/api/v1/models/${modelId}/endpoints`,
    currency: "USD",
    unit: "per_1m_tokens",
    inputUsdPer1M: endpoint.promptUsdPerToken * 1_000_000,
    ...(endpoint.inputCacheReadUsdPerToken === undefined
      ? {}
      : { cachedInputUsdPer1M: endpoint.inputCacheReadUsdPerToken * 1_000_000 }),
    ...(endpoint.inputCacheWriteUsdPerToken === undefined
      ? {}
      : { cacheWriteInputUsdPer1M: endpoint.inputCacheWriteUsdPerToken * 1_000_000 }),
    outputUsdPer1M: endpoint.completionUsdPerToken * 1_000_000,
    effectiveAt: modelId === "z-ai/glm-5.2" ? "2026-06-17" : "2026-06-05",
  }
}

export const computeUsageCost = (providerId: ProviderId, modelId: string, usage: UsageLike): { costUsd?: number; pricingSnapshot?: PricingSnapshot } => {
  const pricing = pricingSnapshotForModel(providerId, modelId)
  if (!pricing) {
    return {}
  }
  const costUsd = computeCostFromPricing(pricing, usage)

  return {
    costUsd,
    pricingSnapshot: pricing,
  }
}

export const normalizeProviderUsage = (input: {
  providerId: ProviderId
  authMode?: ProviderAuthMode
  modelId: string
  usage: ModelUsage
}): ModelUsage => {
  const providerMetadata = input.usage.providerMetadata
  const isChatGptSubscription =
    input.providerId === "openai" && (input.authMode ?? "api_key") === "chatgpt_subscription"
  const routedOpenRouterProvider = firstString(
    getPath(providerMetadata, ["openrouter", "provider"]),
    getPath(input.usage.raw, ["provider"]),
  )
  // The upstream endpoint that served the request. For OpenRouter this comes
  // from provider metadata; for direct providers there is only one upstream, so
  // record the provider id so the usage ledger always has a routed provider.
  const routedProvider =
    input.usage.routedProvider ?? routedOpenRouterProvider ?? (input.providerId === "openrouter" ? undefined : input.providerId)
  const cachedInputTokens =
    input.usage.cachedInputTokens ??
    firstFiniteNumber(
      getPath(providerMetadata, ["openrouter", "usage", "promptTokensDetails", "cachedTokens"]),
      getPath(providerMetadata, ["openrouter", "usage", "prompt_tokens_details", "cached_tokens"]),
      getPath(input.usage.raw, ["prompt_tokens_details", "cached_tokens"]),
      getPath(input.usage.raw, ["usage", "prompt_tokens_details", "cached_tokens"]),
    )
  const cacheWriteTokens =
    input.usage.cacheWriteTokens ??
    firstFiniteNumber(
      getPath(providerMetadata, ["openrouter", "usage", "promptTokensDetails", "cacheWriteTokens"]),
      getPath(providerMetadata, ["openrouter", "usage", "prompt_tokens_details", "cache_write_tokens"]),
      getPath(input.usage.raw, ["prompt_tokens_details", "cache_write_tokens"]),
      getPath(input.usage.raw, ["usage", "prompt_tokens_details", "cache_write_tokens"]),
    )
  const usageWithCache: ModelUsage = {
    ...input.usage,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  }
  const inputTokens = usageWithCache.inputTokens ?? 0
  const normalizedUsage: ModelUsage = {
    ...usageWithCache,
    ...(usageWithCache.uncachedInputTokens === undefined && (cachedInputTokens !== undefined || cacheWriteTokens !== undefined)
      ? { uncachedInputTokens: Math.max(0, inputTokens - (cachedInputTokens ?? 0) - (cacheWriteTokens ?? 0)) }
      : {}),
  }
  const { costUsd: normalizedCostUsd, costSource: normalizedCostSource, pricingSnapshot: normalizedPricingSnapshot, ...usageForReturn } = normalizedUsage
  const providerCostUsd = isChatGptSubscription
    ? undefined
    : firstFiniteNumber(
        getPath(providerMetadata, ["openrouter", "usage", "cost"]),
        getPath(input.usage.raw, ["cost"]),
        getPath(input.usage.raw, ["usage", "cost"]),
      )
  const costUsd = isChatGptSubscription ? undefined : normalizedCostUsd ?? providerCostUsd
  const costSource =
    isChatGptSubscription
      ? ("unknown" as const)
      : costUsd === undefined
        ? undefined
        : normalizedCostSource ?? (providerCostUsd === undefined ? "computed" : "provider_reported")
  const computed =
    costUsd === undefined && !isChatGptSubscription
      ? input.providerId === "openrouter"
        ? computeOpenRouterUsageCost(input.modelId, normalizedUsage, routedOpenRouterProvider)
        : computeUsageCost(input.providerId, input.modelId, normalizedUsage)
      : {}

  return {
    ...usageForReturn,
    ...(routedProvider === undefined ? {} : { routedProvider }),
    ...(costUsd === undefined && computed.costUsd !== undefined ? { costUsd: computed.costUsd } : costUsd === undefined ? {} : { costUsd }),
    ...(costSource === undefined && computed.costUsd !== undefined
      ? { costSource: "computed" as const }
      : costSource === undefined
        ? { costSource: "unknown" as const }
        : { costSource }),
    ...(!isChatGptSubscription && normalizedPricingSnapshot
      ? { pricingSnapshot: normalizedPricingSnapshot }
      : computed.pricingSnapshot
        ? { pricingSnapshot: computed.pricingSnapshot }
        : {}),
  }
}

const computeOpenRouterUsageCost = (
  modelId: string,
  usage: UsageLike,
  routedProvider?: string,
): { costUsd?: number; pricingSnapshot?: PricingSnapshot } => {
  const pricingSnapshot = openRouterPricingSnapshotForModel(modelId, routedProvider)
  if (!pricingSnapshot) {
    return {}
  }
  const computed = computeCostFromPricing(pricingSnapshot, usage)
  return { costUsd: computed, pricingSnapshot }
}

const computeCostFromPricing = (pricing: PricingSnapshot, usage: UsageLike): number => {
  const cachedInputTokens = usage.cachedInputTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const inputTokens = usage.inputTokens ?? 0
  const uncachedInputTokens = usage.uncachedInputTokens ?? Math.max(0, inputTokens - cachedInputTokens - cacheWriteTokens)
  const outputTokens = usage.outputTokens ?? 0
  const useLongContextRates =
    pricing.longContextThresholdInputTokens !== undefined && inputTokens > pricing.longContextThresholdInputTokens
  const inputUsdPer1M = useLongContextRates ? (pricing.longContextInputUsdPer1M ?? pricing.inputUsdPer1M) : pricing.inputUsdPer1M
  const cachedInputUsdPer1M = useLongContextRates
    ? (pricing.longContextCachedInputUsdPer1M ?? pricing.cachedInputUsdPer1M ?? inputUsdPer1M)
    : (pricing.cachedInputUsdPer1M ?? inputUsdPer1M)
  const cacheWriteInputUsdPer1M = useLongContextRates
    ? (pricing.longContextCacheWriteInputUsdPer1M ?? pricing.cacheWriteInputUsdPer1M ?? inputUsdPer1M)
    : (pricing.cacheWriteInputUsdPer1M ?? inputUsdPer1M)
  const outputUsdPer1M = useLongContextRates ? (pricing.longContextOutputUsdPer1M ?? pricing.outputUsdPer1M) : pricing.outputUsdPer1M
  return (
    (uncachedInputTokens * inputUsdPer1M +
      cachedInputTokens * cachedInputUsdPer1M +
      cacheWriteTokens * cacheWriteInputUsdPer1M +
      outputTokens * outputUsdPer1M) /
    1_000_000
  )
}

const firstFiniteNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }
  return undefined
}

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

const sameProviderName = (left: string, right: string): boolean =>
  left.toLowerCase().replace(/[^a-z0-9]/g, "") === right.toLowerCase().replace(/[^a-z0-9]/g, "")

const getPath = (value: unknown, path: string[]): unknown => {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
