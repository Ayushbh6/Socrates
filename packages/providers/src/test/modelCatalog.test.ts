import { describe, expect, it } from "vitest"
import { listModelsResponseSchema } from "@socrates/contracts"
import { listAvailableModels, listModels, modelCatalog } from "../modelCatalog/modelCatalog"

describe("model catalog", () => {
  it("exposes the curated V1 models and default", () => {
    const response = listModelsResponseSchema.parse(listModels())

    expect(response.defaultModel).toEqual({
      providerId: "openrouter",
      authMode: "api_key",
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
      "openrouter/meta-llama/llama-4-maverick",
      "openrouter/qwen/qwen3.5-flash-02-23",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
    ])
  })

  it("filters models by configured auth modes", () => {
    expect(listAvailableModels([])).toEqual({ models: [], defaultModel: null })

    const openRouterOnly = listAvailableModels([{ providerId: "openrouter", authMode: "api_key" }])
    expect(openRouterOnly.models.every((model) => model.providerId === "openrouter")).toBe(true)
    expect(openRouterOnly.defaultModel).toMatchObject({
      providerId: "openrouter",
      authMode: "api_key",
      modelId: "deepseek/deepseek-v4-pro",
    })

    const deepSeekOnly = listAvailableModels([{ providerId: "deepseek", authMode: "api_key" }])
    expect(deepSeekOnly.models.map((model) => `${model.providerLabel}:${model.modelId}`)).toEqual([
      "DeepSeek API:deepseek-v4-pro",
      "DeepSeek API:deepseek-v4-flash",
    ])
    expect(deepSeekOnly.defaultModel).toMatchObject({
      providerId: "deepseek",
      authMode: "api_key",
      modelId: "deepseek-v4-pro",
      thinkingOptionId: "high",
    })

    const openAiModes = listAvailableModels([
      { providerId: "openai", authMode: "api_key" },
      { providerId: "openai", authMode: "chatgpt_subscription" },
    ])
    expect(openAiModes.models.map((model) => `${model.providerLabel}:${model.authMode}:${model.modelId}`)).toEqual([
      "OpenAI API:api_key:gpt-5.4-mini",
      "OpenAI API:api_key:gpt-5.4",
      "OpenAI API:api_key:gpt-5",
      "ChatGPT Codex:chatgpt_subscription:gpt-5.5",
      "ChatGPT Codex:chatgpt_subscription:gpt-5.4",
      "ChatGPT Codex:chatgpt_subscription:gpt-5.4-mini",
      "ChatGPT Codex:chatgpt_subscription:gpt-5.3-codex-spark",
    ])
  })

  it("exposes the ChatGPT Codex subscription model set", () => {
    const response = listAvailableModels([{ providerId: "openai", authMode: "chatgpt_subscription" }])

    expect(response.models.map((model) => model.modelId)).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"])
    expect(response.defaultModel).toMatchObject({
      providerId: "openai",
      authMode: "chatgpt_subscription",
      modelId: "gpt-5.5",
      thinkingOptionId: "xhigh",
    })
    const modelsById = new Map(response.models.map((model) => [model.modelId, model]))
    expect(modelsById.get("gpt-5.5")?.thinkingOptions.map((option) => option.id)).toEqual(["low", "medium", "high", "xhigh"])
    expect(modelsById.get("gpt-5.4")?.thinkingOptions.map((option) => option.id)).toEqual(["none", "low", "medium", "high", "xhigh"])
    expect(modelsById.get("gpt-5.4-mini")?.thinkingOptions.map((option) => option.id)).toEqual(["none", "low", "medium", "high", "xhigh"])
    expect(modelsById.get("gpt-5.3-codex-spark")?.thinkingOptions.map((option) => option.id)).toEqual(["low", "medium", "high", "xhigh"])
    expect(response.models.find((model) => model.modelId === "gpt-5.5")?.defaultThinkingOptionId).toBe("xhigh")
    expect(response.models.find((model) => model.modelId === "gpt-5.4")?.defaultThinkingOptionId).toBe("none")
    expect(response.models.find((model) => model.modelId === "gpt-5.4-mini")?.defaultThinkingOptionId).toBe("low")
    expect(response.models.find((model) => model.modelId === "gpt-5.3-codex-spark")?.defaultThinkingOptionId).toBe("low")
    expect(response.models.find((model) => model.modelId === "gpt-5.4")?.contextWindowTokens).toBe(1050000)
    expect(response.models.find((model) => model.modelId === "gpt-5.4-mini")?.contextWindowTokens).toBe(400000)
    expect(response.models.find((model) => model.modelId === "gpt-5.3-codex-spark")?.contextWindowTokens).toBe(128000)
    expect(response.models.find((model) => model.modelId === "gpt-5.3-codex-spark")?.capabilities?.vision).toBe(false)
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
    expect(gpt54Mini?.contextWindowTokens).toBe(400000)
    expect(gpt54?.thinkingOptions.map((option) => option.id)).toEqual(["none", "low", "medium", "high", "xhigh"])
    expect(gpt54?.defaultThinkingOptionId).toBe("none")
    expect(gpt54?.contextWindowTokens).toBe(1050000)
    expect(gpt5?.thinkingOptions.map((option) => option.id)).toEqual(["minimal", "low", "medium", "high"])
    expect(gpt5?.defaultThinkingOptionId).toBe("minimal")
  })

  it("uses Google's Gemini 3.5 Flash default thinking level", () => {
    const flash = modelCatalog.find((model) => model.modelId === "gemini-3.5-flash")
    expect(flash?.defaultThinkingOptionId).toBe("medium")
    expect(flash?.thinkingOptions.map((option) => option.id)).toEqual(["minimal", "low", "medium", "high"])
  })

  it("exposes official DeepSeek models with only supported direct thinking options", () => {
    const pro = modelCatalog.find((model) => model.providerId === "deepseek" && model.modelId === "deepseek-v4-pro")
    const flash = modelCatalog.find((model) => model.providerId === "deepseek" && model.modelId === "deepseek-v4-flash")

    expect(pro?.thinkingOptions.map((option) => option.id)).toEqual(["off", "high", "xhigh"])
    expect(pro?.thinkingOptions.find((option) => option.id === "xhigh")?.label).toBe("Max")
    expect(pro?.defaultThinkingOptionId).toBe("high")
    expect(pro?.capabilities?.vision).toBe(false)
    expect(flash?.thinkingOptions.map((option) => option.id)).toEqual(["off", "high", "xhigh"])
    expect(flash?.defaultThinkingOptionId).toBe("high")
  })

  it("marks OpenRouter and direct DeepSeek text-only models as non-vision models", () => {
    const nonVision = modelCatalog
      .filter((model) => model.capabilities?.vision === false)
      .map((model) => model.modelId)

    expect(nonVision).toEqual([
      "z-ai/glm-5.2",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "qwen/qwen3.5-flash-02-23",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ])
    expect(modelCatalog.find((model) => model.modelId === "xiaomi/mimo-v2.5-pro")?.capabilities?.vision).toBe(true)
  })
})
