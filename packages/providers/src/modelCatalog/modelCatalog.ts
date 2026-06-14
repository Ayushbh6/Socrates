import type { ListModelsResponse, ModelOption, ModelThinkingOption, ProviderId } from "@socrates/contracts"

const offOption: ModelThinkingOption = {
  id: "off",
  label: "Off",
  enabled: false,
}

const openAiNoneOption: ModelThinkingOption = {
  id: "none",
  label: "None",
  enabled: false,
  effort: "none",
}

const effortOption = (effort: Exclude<ModelThinkingOption["effort"], undefined>): ModelThinkingOption => ({
  id: effort,
  label: effort === "xhigh" ? "Extra High" : effort.charAt(0).toUpperCase() + effort.slice(1),
  enabled: effort !== "none",
  effort,
})

const providerLabel = (providerId: ProviderId): string => {
  switch (providerId) {
    case "openai":
      return "OpenAI"
    case "google":
      return "Google"
    case "openrouter":
      return "OpenRouter"
  }
}

const makeModel = (input: Omit<ModelOption, "providerLabel" | "isDefault"> & { isDefault?: boolean }): ModelOption => ({
  ...input,
  providerLabel: providerLabel(input.providerId),
  isDefault: input.isDefault ?? false,
  capabilities: input.capabilities ?? { vision: true },
})

export const modelCatalog = [
  makeModel({
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    contextWindowTokens: 258000,
    thinkingOptions: [openAiNoneOption, effortOption("low"), effortOption("medium"), effortOption("high"), effortOption("xhigh")],
    defaultThinkingOptionId: "none",
  }),
  makeModel({
    providerId: "openai",
    modelId: "gpt-5.4",
    label: "GPT-5.4",
    contextWindowTokens: 258000,
    thinkingOptions: [openAiNoneOption, effortOption("low"), effortOption("medium"), effortOption("high"), effortOption("xhigh")],
    defaultThinkingOptionId: "none",
  }),
  makeModel({
    providerId: "openai",
    modelId: "gpt-5",
    label: "GPT-5",
    contextWindowTokens: 258000,
    thinkingOptions: [openAiNoneOption, effortOption("low"), effortOption("medium"), effortOption("high"), effortOption("xhigh")],
    defaultThinkingOptionId: "none",
  }),
  makeModel({
    providerId: "google",
    modelId: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    contextWindowTokens: 1048576,
    thinkingOptions: [effortOption("low"), effortOption("medium"), effortOption("high")],
    defaultThinkingOptionId: "high",
  }),
  makeModel({
    providerId: "google",
    modelId: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    contextWindowTokens: 1048576,
    thinkingOptions: [effortOption("minimal"), effortOption("low"), effortOption("medium"), effortOption("high")],
    defaultThinkingOptionId: "medium",
  }),
  makeModel({
    providerId: "google",
    modelId: "gemini-3-flash-preview",
    label: "Gemini 3 Flash",
    contextWindowTokens: 1048576,
    thinkingOptions: [effortOption("minimal"), effortOption("low"), effortOption("medium"), effortOption("high")],
    defaultThinkingOptionId: "high",
  }),
  makeModel({
    providerId: "google",
    modelId: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash-Lite",
    contextWindowTokens: 1048576,
    thinkingOptions: [effortOption("minimal"), effortOption("low"), effortOption("medium"), effortOption("high")],
    defaultThinkingOptionId: "minimal",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    contextWindowTokens: 262144,
    thinkingOptions: [offOption, { id: "on", label: "On", enabled: true }],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "z-ai/glm-5.1",
    label: "GLM 5.1",
    contextWindowTokens: 202800,
    capabilities: { vision: false },
    thinkingOptions: [offOption, { id: "on", label: "On", enabled: true }],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "xiaomi/mimo-v2.5-pro",
    label: "MiMo-V2.5-Pro",
    contextWindowTokens: 1048576,
    thinkingOptions: [offOption, { id: "on", label: "On", enabled: true }],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "xiaomi/mimo-v2.5",
    label: "MiMo-V2.5",
    contextWindowTokens: 1048576,
    thinkingOptions: [offOption, { id: "on", label: "On", enabled: true }],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "x-ai/grok-build-0.1",
    label: "Grok Build 0.1",
    contextWindowTokens: 256000,
    thinkingOptions: [offOption, { id: "on", label: "On", enabled: true }],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "stepfun/step-3.7-flash",
    label: "Step 3.7 Flash",
    contextWindowTokens: 262144,
    thinkingOptions: [offOption, { id: "on", label: "On", enabled: true }],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    contextWindowTokens: 1048576,
    capabilities: { vision: false },
    thinkingOptions: [offOption, { id: "on", label: "On", enabled: true }],
    defaultThinkingOptionId: "off",
    isDefault: true,
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    contextWindowTokens: 1048576,
    capabilities: { vision: false },
    thinkingOptions: [offOption, { id: "on", label: "On", enabled: true }],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "google/gemma-4-31b-it",
    label: "Gemma 4 31B",
    contextWindowTokens: 262144,
    thinkingOptions: [offOption, { id: "on", label: "On", enabled: true }],
    defaultThinkingOptionId: "off",
  }),
] satisfies ModelOption[]

export const defaultModel = modelCatalog.find((model) => model.isDefault) ?? modelCatalog[0]

if (!defaultModel) {
  throw new Error("Model catalog must include at least one model")
}

export const listModels = (): ListModelsResponse => ({
  models: modelCatalog,
  defaultModel: {
    providerId: defaultModel.providerId,
    modelId: defaultModel.modelId,
    thinkingOptionId: defaultModel.defaultThinkingOptionId,
  },
})

export const findModelOption = (providerId: string, modelId: string): ModelOption | undefined =>
  modelCatalog.find((model) => model.providerId === providerId && model.modelId === modelId)
