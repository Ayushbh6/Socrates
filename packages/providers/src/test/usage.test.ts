import { describe, expect, it } from "vitest"
import { normalizeProviderUsage } from "../usage"

describe("provider usage normalization", () => {
  it("keeps OpenRouter provider-reported cost and cache fields", () => {
    const usage = normalizeProviderUsage({
      providerId: "openrouter",
      modelId: "z-ai/glm-5.1",
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
