import { describe, expect, it } from "vitest"
import { listModelsResponseSchema } from "@socrates/contracts"
import { listModels, modelCatalog } from "../modelCatalog/modelCatalog"

describe("model catalog", () => {
  it("exposes the curated V1 models and default", () => {
    const response = listModelsResponseSchema.parse(listModels())

    expect(response.defaultModel).toEqual({
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
      thinkingOptionId: "off",
    })
    expect(response.models.map((model) => `${model.providerId}/${model.modelId}`)).toEqual([
      "openai/gpt-5.4-mini",
      "openai/gpt-5.4",
      "openai/gpt-5",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.5-flash",
      "google/gemini-3-flash-preview",
      "google/gemini-3.1-flash-lite-preview",
      "openrouter/moonshotai/kimi-k2.6",
      "openrouter/z-ai/glm-5.2",
      "openrouter/xiaomi/mimo-v2.5-pro",
      "openrouter/xiaomi/mimo-v2.5",
      "openrouter/x-ai/grok-build-0.1",
      "openrouter/stepfun/step-3.7-flash",
      "openrouter/deepseek/deepseek-v4-pro",
      "openrouter/deepseek/deepseek-v4-flash",
      "openrouter/google/gemma-4-31b-it",
    ])
  })

  it("does not expose non-thinking mode for Gemini 3.1 Pro", () => {
    const pro = modelCatalog.find((model) => model.modelId === "gemini-3.1-pro-preview")
    expect(pro?.thinkingOptions.map((option) => option.id)).toEqual(["low", "medium", "high"])
  })

  it("matches OpenAI GPT reasoning effort support by model", () => {
    const gpt54Mini = modelCatalog.find((model) => model.modelId === "gpt-5.4-mini")
    const gpt54 = modelCatalog.find((model) => model.modelId === "gpt-5.4")
    const gpt5 = modelCatalog.find((model) => model.modelId === "gpt-5")

    expect(gpt54Mini?.thinkingOptions.map((option) => option.id)).toEqual(["none", "low", "medium", "high", "xhigh"])
    expect(gpt54Mini?.defaultThinkingOptionId).toBe("none")
    expect(gpt54?.thinkingOptions.map((option) => option.id)).toEqual(["none", "low", "medium", "high", "xhigh"])
    expect(gpt54?.defaultThinkingOptionId).toBe("none")
    expect(gpt5?.thinkingOptions.map((option) => option.id)).toEqual(["minimal", "low", "medium", "high"])
    expect(gpt5?.defaultThinkingOptionId).toBe("minimal")
  })

  it("uses Google's Gemini 3.5 Flash default thinking level", () => {
    const flash = modelCatalog.find((model) => model.modelId === "gemini-3.5-flash")
    expect(flash?.defaultThinkingOptionId).toBe("medium")
    expect(flash?.thinkingOptions.map((option) => option.id)).toEqual(["minimal", "low", "medium", "high"])
  })

  it("marks only OpenRouter text-only models as non-vision models", () => {
    const nonVision = modelCatalog
      .filter((model) => model.capabilities?.vision === false)
      .map((model) => model.modelId)

    expect(nonVision).toEqual(["z-ai/glm-5.2", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"])
    expect(modelCatalog.find((model) => model.modelId === "xiaomi/mimo-v2.5-pro")?.capabilities?.vision).toBe(true)
  })
})
