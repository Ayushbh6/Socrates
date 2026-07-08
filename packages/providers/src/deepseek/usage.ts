import type { ModelUsage } from "../types"
import { normalizeProviderUsage } from "../usage"
import type { DeepSeekUsage } from "./types"

export const usageFromDeepSeek = (
  modelId: string,
  usage: DeepSeekUsage | null | undefined,
  metadata?: Record<string, unknown>,
): ModelUsage | undefined => {
  if (!usage) {
    return undefined
  }
  const inputTokens = finiteNumber(usage.prompt_tokens)
  const outputTokens = finiteNumber(usage.completion_tokens)
  const totalTokens = finiteNumber(usage.total_tokens)
  const cachedInputTokens = finiteNumber(usage.prompt_cache_hit_tokens)
  const uncachedInputTokens = finiteNumber(usage.prompt_cache_miss_tokens)
  const reasoningTokens = finiteNumber(usage.completion_tokens_details?.reasoning_tokens)
  return normalizeProviderUsage({
    providerId: "deepseek",
    modelId,
    usage: {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      ...(metadata ? { providerMetadata: { deepseek: metadata } } : {}),
      raw: usage,
    },
  })
}

const finiteNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
