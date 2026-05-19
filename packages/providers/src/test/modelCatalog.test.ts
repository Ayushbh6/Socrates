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
      "google/gemini-3-flash-preview",
      "google/gemini-3.1-flash-lite-preview",
      "openrouter/moonshotai/kimi-k2.6",
      "openrouter/z-ai/glm-5.1",
      "openrouter/qwen/qwen3.6-plus",
      "openrouter/deepseek/deepseek-v4-pro",
      "openrouter/deepseek/deepseek-v4-flash",
      "openrouter/google/gemma-4-31b-it",
    ])
  })

  it("does not expose non-thinking mode for Gemini 3.1 Pro", () => {
    const pro = modelCatalog.find((model) => model.modelId === "gemini-3.1-pro-preview")
    expect(pro?.thinkingOptions.map((option) => option.id)).toEqual(["low", "medium", "high"])
  })
})
