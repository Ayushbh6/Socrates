import { describe, expect, it } from "vitest"
import { AiSdkProvider } from "../ai-sdk/AiSdkProvider"
import type { ModelRequest, ModelUsage } from "../types"

const shouldRun = process.env.SOCRATES_OPENROUTER_CACHE_SMOKE === "1" && !!process.env.OPENROUTER_API_KEY

describe.skipIf(!shouldRun)("OpenRouter live cache smoke", () => {
  it(
    "keeps the same sticky routed provider and records cache metadata across repeated same-session DeepSeek calls",
    async () => {
      const provider = new AiSdkProvider({
        getApiKey: (providerId) => (providerId === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined),
      })
      const cacheKey = `cache-smoke:${Date.now()}`
      const request = (prompt: string): ModelRequest => ({
        providerId: "openrouter",
        modelId: "deepseek/deepseek-v4-flash",
        sessionId: cacheKey,
        cacheKey,
        system: stableCachePrefix(),
        messages: [{ role: "user", content: prompt }],
        runtimeConfig: {
          providerId: "openrouter",
          modelId: "deepseek/deepseek-v4-flash",
          thinkingEnabled: false,
          thinkingEffort: "none",
          approvalMode: "manual",
          sandboxMode: "read_only",
        },
      })

      const first = await drainUsage(provider, request("Reply with exactly: first"))
      const second = await drainUsage(provider, request("Reply with exactly: second"))
      const firstProvider = routedOpenRouterProvider(first)
      const secondProvider = routedOpenRouterProvider(second)
      console.info(
        "OpenRouter cache smoke usage:",
        JSON.stringify({
          first: usageSummary(first),
          second: usageSummary(second),
          totalCostUsd: roundCost((first.costUsd ?? 0) + (second.costUsd ?? 0)),
        }),
      )

      expect(firstProvider).toBeTruthy()
      expect(secondProvider).toBe(firstProvider)
      expect(second.cachedInputTokens ?? 0).toBeGreaterThan(0)
      expect(second.costSource).not.toBe("unknown")
    },
    60_000,
  )
})

const drainUsage = async (provider: AiSdkProvider, request: ModelRequest): Promise<ModelUsage> => {
  let usage: ModelUsage | undefined
  for await (const event of provider.stream(request)) {
    if (event.type === "model.usage" || event.type === "model.completed") {
      usage = event.usage ?? usage
    }
    if (event.type === "model.failed") {
      throw event.error
    }
  }
  if (!usage) {
    throw new Error("OpenRouter smoke call did not return usage.")
  }
  return usage
}

const routedOpenRouterProvider = (usage: ModelUsage): string | undefined => {
  const metadata = usage.providerMetadata
  if (!metadata || typeof metadata !== "object") {
    return undefined
  }
  const openrouter = (metadata as Record<string, unknown>).openrouter
  if (!openrouter || typeof openrouter !== "object") {
    return undefined
  }
  const provider = (openrouter as Record<string, unknown>).provider
  return typeof provider === "string" && provider.length > 0 ? provider : undefined
}

const usageSummary = (usage: ModelUsage) => ({
  provider: routedOpenRouterProvider(usage),
  inputTokens: usage.inputTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
  totalTokens: usage.totalTokens ?? 0,
  cachedInputTokens: usage.cachedInputTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  uncachedInputTokens: usage.uncachedInputTokens ?? 0,
  costUsd: roundCost(usage.costUsd),
  costSource: usage.costSource ?? "unknown",
})

const roundCost = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.round(value * 1_000_000_000) / 1_000_000_000

const stableCachePrefix = (): string =>
  [
    "You are Socrates cache smoke verifier.",
    "The following stable prefix is intentionally repeated to test provider prompt caching.",
    ...Array.from({ length: 80 }, (_, index) => `Stable cache line ${index + 1}: preserve this deterministic prefix exactly.`),
  ].join("\n")
