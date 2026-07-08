import { describe, expect, it } from "vitest"
import { modelCatalog } from "../modelCatalog/modelCatalog"
import { normalizeProviderUsage, pricingSnapshotForModel } from "../usage"

describe("provider usage normalization", () => {
  it("keeps OpenRouter provider-reported cost and cache fields", () => {
    const usage = normalizeProviderUsage({
      providerId: "openrouter",
      modelId: "z-ai/glm-5.2",
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        providerMetadata: {
          openrouter: {
            provider: "Z.AI",
            usage: {
              cost: 0.0123,
              promptTokensDetails: {
                cachedTokens: 800,
                cacheWriteTokens: 150,
              },
            },
          },
        },
        raw: { usage: { cost: 0.0123 } },
      },
    })

    expect(usage.costUsd).toBe(0.0123)
    expect(usage.costSource).toBe("provider_reported")
    expect(usage.cachedInputTokens).toBe(800)
    expect(usage.cacheWriteTokens).toBe(150)
    expect(usage.uncachedInputTokens).toBe(50)
  })

  it("computes OpenRouter fallback cost from endpoint pricing when provider cost is absent", () => {
    const usage = normalizeProviderUsage({
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      usage: {
        inputTokens: 10_000,
        outputTokens: 500,
        cachedInputTokens: 4_000,
        cacheWriteTokens: 1_000,
        providerMetadata: {
          openrouter: {
            provider: "DeepSeek",
            usage: {
              promptTokens: 10_000,
              completionTokens: 500,
              totalTokens: 10_500,
            },
          },
        },
      },
    })

    const expected = (5_000 * 0.14 + 4_000 * 0.0028 + 1_000 * 0.14 + 500 * 0.28) / 1_000_000
    expect(usage.costSource).toBe("computed")
    expect(usage.costUsd).toBeCloseTo(expected)
    expect(usage.pricingSnapshot).toMatchObject({
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      routedProvider: "DeepSeek",
    })
  })

  it("computes OpenAI cost from the local pricing snapshot when provider cost is absent", () => {
    const usage = normalizeProviderUsage({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 400,
      },
    })

    expect(usage.costSource).toBe("computed")
    expect(usage.costUsd).toBeCloseTo((600 * 0.75 + 400 * 0.075 + 100 * 4.5) / 1_000_000)
    expect(usage.pricingSnapshot?.providerId).toBe("openai")
  })

  it("does not compute API dollar cost for ChatGPT Codex subscription usage", () => {
    const apiPricingSnapshot = pricingSnapshotForModel("openai", "gpt-5.4-mini")
    expect(apiPricingSnapshot).toBeDefined()

    const usage = normalizeProviderUsage({
      providerId: "openai",
      authMode: "chatgpt_subscription",
      modelId: "gpt-5.4-mini",
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 400,
        costUsd: 123,
        costSource: "provider_reported",
        pricingSnapshot: apiPricingSnapshot!,
        raw: { usage: { cost: 321 } },
      },
    })

    expect(usage.costSource).toBe("unknown")
    expect(usage.costUsd).toBeUndefined()
    expect(usage.pricingSnapshot).toBeUndefined()
    expect(usage.inputTokens).toBe(1000)
    expect(usage.outputTokens).toBe(100)
    expect(usage.cachedInputTokens).toBe(400)
    expect(usage.routedProvider).toBe("openai")
  })

  it("computes Google Gemini 3 Flash cost from the local pricing snapshot when provider cost is absent", () => {
    const usage = normalizeProviderUsage({
      providerId: "google",
      modelId: "gemini-3-flash-preview",
      usage: {
        inputTokens: 2000,
        outputTokens: 300,
        cachedInputTokens: 1000,
      },
    })

    expect(usage.costSource).toBe("computed")
    expect(usage.costUsd).toBeCloseTo((1000 * 0.5 + 1000 * 0.05 + 300 * 3) / 1_000_000)
    expect(usage.pricingSnapshot?.providerId).toBe("google")
  })

  it("computes Google Gemini 3.5 Flash cost from the local pricing snapshot", () => {
    const usage = normalizeProviderUsage({
      providerId: "google",
      modelId: "gemini-3.5-flash",
      usage: {
        inputTokens: 2000,
        outputTokens: 300,
        cachedInputTokens: 1000,
      },
    })

    expect(usage.costSource).toBe("computed")
    expect(usage.costUsd).toBeCloseTo((1000 * 1.5 + 1000 * 0.15 + 300 * 9) / 1_000_000)
    expect(usage.pricingSnapshot?.providerId).toBe("google")
  })

  it("computes Google Gemini 3.1 Pro cost with standard and long-context pricing", () => {
    const standard = normalizeProviderUsage({
      providerId: "google",
      modelId: "gemini-3.1-pro-preview",
      usage: {
        inputTokens: 10_000,
        outputTokens: 500,
        cachedInputTokens: 4_000,
      },
    })

    expect(standard.costSource).toBe("computed")
    expect(standard.costUsd).toBeCloseTo((6_000 * 2 + 4_000 * 0.2 + 500 * 12) / 1_000_000)
    expect(standard.pricingSnapshot?.providerId).toBe("google")

    const longContext = normalizeProviderUsage({
      providerId: "google",
      modelId: "gemini-3.1-pro-preview",
      usage: {
        inputTokens: 250_000,
        outputTokens: 1_000,
        cachedInputTokens: 100_000,
      },
    })

    expect(longContext.costSource).toBe("computed")
    expect(longContext.costUsd).toBeCloseTo((150_000 * 4 + 100_000 * 0.4 + 1_000 * 18) / 1_000_000)
  })

  it("computes Google Gemini 3.1 Flash-Lite cost from the local pricing snapshot", () => {
    const usage = normalizeProviderUsage({
      providerId: "google",
      modelId: "gemini-3.1-flash-lite-preview",
      usage: {
        inputTokens: 2000,
        outputTokens: 300,
        cachedInputTokens: 1000,
      },
    })

    expect(usage.costSource).toBe("computed")
    expect(usage.costUsd).toBeCloseTo((1000 * 0.25 + 1000 * 0.025 + 300 * 1.5) / 1_000_000)
    expect(usage.pricingSnapshot?.providerId).toBe("google")
  })

  it("computes direct DeepSeek cost from cache hit and miss usage fields", () => {
    const usage = normalizeProviderUsage({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      usage: {
        inputTokens: 10_000,
        outputTokens: 500,
        cachedInputTokens: 4_000,
        uncachedInputTokens: 6_000,
        reasoningTokens: 250,
      },
    })

    const expected = (6_000 * 0.435 + 4_000 * 0.003625 + 500 * 0.87) / 1_000_000
    expect(usage.costSource).toBe("computed")
    expect(usage.costUsd).toBeCloseTo(expected)
    expect(usage.routedProvider).toBe("deepseek")
    expect(usage.pricingSnapshot).toMatchObject({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    })
  })

  it("derives direct DeepSeek cache hit and miss fields from raw usage when present", () => {
    const usage = normalizeProviderUsage({
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      usage: {
        inputTokens: 2000,
        outputTokens: 100,
        raw: {
          prompt_cache_hit_tokens: 1200,
          prompt_cache_miss_tokens: 800,
        },
      },
    })

    expect(usage.cachedInputTokens).toBe(1200)
    expect(usage.uncachedInputTokens).toBe(800)
    expect(usage.costSource).toBe("computed")
  })

  it("has local pricing for all direct provider catalog models", () => {
    const missing = modelCatalog
      .filter(
        (model) =>
          (model.providerId === "openai" && (model.authMode ?? "api_key") === "api_key") ||
          model.providerId === "google" ||
          model.providerId === "deepseek",
      )
      .filter((model) => pricingSnapshotForModel(model.providerId, model.modelId) === undefined)
      .map((model) => `${model.providerId}:${model.modelId}`)

    expect(missing).toEqual([])
  })

  it("marks unknown provider and model costs without dropping token usage", () => {
    const usage = normalizeProviderUsage({
      providerId: "openrouter",
      modelId: "unknown/model",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
      },
    })

    expect(usage.costSource).toBe("unknown")
    expect(usage.costUsd).toBeUndefined()
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(25)
  })
})
