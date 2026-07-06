import type { ListModelsResponse, ModelOption, ModelThinkingOption, ProviderAuthMode, ProviderId } from "@socrates/contracts"

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

const openAiLegacyGpt5MinimalOption: ModelThinkingOption = {
  id: "minimal",
  label: "Minimal",
  enabled: true,
  effort: "minimal",
}

const onOption: ModelThinkingOption = {
  id: "on",
  label: "On",
  enabled: true,
}

const effortOption = (effort: Exclude<ModelThinkingOption["effort"], undefined>): ModelThinkingOption => ({
  id: effort,
  label: effort === "xhigh" ? "Extra High" : effort.charAt(0).toUpperCase() + effort.slice(1),
  enabled: effort !== "none",
  effort,
})

const chatGptCodexThinkingOptions = [effortOption("low"), effortOption("medium"), effortOption("high"), effortOption("xhigh")]
const openAiGpt54ThinkingOptions = [openAiNoneOption, ...chatGptCodexThinkingOptions]

const providerLabel = (providerId: ProviderId, authMode: ProviderAuthMode = "api_key"): string => {
  switch (providerId) {
    case "openai":
      return authMode === "chatgpt_subscription" ? "ChatGPT Codex" : "OpenAI API"
    case "google":
      return "Google"
    case "openrouter":
      return "OpenRouter"
    case "ollama":
      return "Ollama Local"
  }
}

const makeModel = (input: Omit<ModelOption, "providerLabel" | "isDefault" | "authMode"> & { authMode?: ProviderAuthMode; isDefault?: boolean }): ModelOption => ({
  ...input,
  authMode: input.authMode ?? "api_key",
  providerLabel: providerLabel(input.providerId, input.authMode ?? "api_key"),
  isDefault: input.isDefault ?? false,
  capabilities: input.capabilities ?? { vision: true },
})

export const modelCatalog = [
  makeModel({
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    contextWindowTokens: 400000,
    thinkingOptions: openAiGpt54ThinkingOptions,
    defaultThinkingOptionId: "none",
  }),
  makeModel({
    providerId: "openai",
    modelId: "gpt-5.4",
    label: "GPT-5.4",
    contextWindowTokens: 1050000,
    thinkingOptions: openAiGpt54ThinkingOptions,
    defaultThinkingOptionId: "none",
  }),
  makeModel({
    providerId: "openai",
    modelId: "gpt-5",
    label: "GPT-5",
    contextWindowTokens: 258000,
    thinkingOptions: [openAiLegacyGpt5MinimalOption, effortOption("low"), effortOption("medium"), effortOption("high")],
    defaultThinkingOptionId: "minimal",
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
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "z-ai/glm-5.2",
    label: "GLM 5.2",
    contextWindowTokens: 1048576,
    capabilities: { vision: false },
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "xiaomi/mimo-v2.5-pro",
    label: "MiMo-V2.5-Pro",
    contextWindowTokens: 1048576,
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "xiaomi/mimo-v2.5",
    label: "MiMo-V2.5",
    contextWindowTokens: 1048576,
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "x-ai/grok-build-0.1",
    label: "Grok Build 0.1",
    contextWindowTokens: 256000,
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "stepfun/step-3.7-flash",
    label: "Step 3.7 Flash",
    contextWindowTokens: 262144,
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    contextWindowTokens: 1048576,
    capabilities: { vision: false },
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
    isDefault: true,
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    contextWindowTokens: 1048576,
    capabilities: { vision: false },
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "google/gemma-4-31b-it",
    label: "Gemma 4 31B",
    contextWindowTokens: 262144,
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "meta-llama/llama-4-maverick",
    label: "Llama 4 Maverick",
    contextWindowTokens: 1048576,
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  }),
  makeModel({
    providerId: "openrouter",
    modelId: "qwen/qwen3.5-flash-02-23",
    label: "Qwen 3.5 Flash",
    contextWindowTokens: 1048576,
    capabilities: { vision: false },
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  }),
] satisfies ModelOption[]

const makeChatGptCodexModel = (input: Omit<Parameters<typeof makeModel>[0], "providerId" | "authMode">): ModelOption =>
  makeModel({
    ...input,
    providerId: "openai",
    authMode: "chatgpt_subscription",
  })

export const chatGptCodexModelCatalog = [
  makeChatGptCodexModel({
    modelId: "gpt-5.5",
    label: "GPT-5.5",
    contextWindowTokens: 400000,
    thinkingOptions: chatGptCodexThinkingOptions,
    defaultThinkingOptionId: "xhigh",
  }),
  makeChatGptCodexModel({
    modelId: "gpt-5.4",
    label: "GPT-5.4",
    contextWindowTokens: 1050000,
    thinkingOptions: openAiGpt54ThinkingOptions,
    defaultThinkingOptionId: "none",
  }),
  makeChatGptCodexModel({
    modelId: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    contextWindowTokens: 400000,
    thinkingOptions: openAiGpt54ThinkingOptions,
    defaultThinkingOptionId: "low",
  }),
  makeChatGptCodexModel({
    modelId: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    contextWindowTokens: 128000,
    capabilities: { vision: false },
    thinkingOptions: chatGptCodexThinkingOptions,
    defaultThinkingOptionId: "low",
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
    authMode: defaultModel.authMode,
    modelId: defaultModel.modelId,
    thinkingOptionId: defaultModel.defaultThinkingOptionId,
  },
})

export type AvailableProviderAuth = {
  providerId: ProviderId
  authMode: ProviderAuthMode
}

export const listAvailableModels = (availableAuth: readonly AvailableProviderAuth[]): ListModelsResponse => {
  const models = availableAuth.flatMap((auth) => catalogForAuthMode(auth.providerId, auth.authMode))
  const defaultAvailableModel = models.find((model) => model.isDefault) ?? models[0]
  return {
    models,
    defaultModel: defaultAvailableModel
      ? {
          providerId: defaultAvailableModel.providerId,
          authMode: defaultAvailableModel.authMode,
          modelId: defaultAvailableModel.modelId,
          thinkingOptionId: defaultAvailableModel.defaultThinkingOptionId,
        }
      : null,
  }
}

export const catalogForAuthMode = (providerId: ProviderId, authMode: ProviderAuthMode = "api_key"): ModelOption[] => {
  if (providerId === "openai" && authMode === "chatgpt_subscription") {
    return chatGptCodexModelCatalog
  }
  if (providerId === "ollama") {
    return []
  }
  if (authMode !== "api_key") {
    return []
  }
  return modelCatalog.filter((model) => model.providerId === providerId)
}

export const findModelOption = (providerId: string, modelId: string, authMode: ProviderAuthMode = "api_key"): ModelOption | undefined =>
  [...modelCatalog, ...chatGptCodexModelCatalog].find(
    (model) => model.providerId === providerId && model.authMode === authMode && model.modelId === modelId,
  )

export const makeOllamaModelOption = (input: {
  modelId: string
  label?: string
  contextWindowTokens?: number
  vision?: boolean
}): ModelOption =>
  makeModel({
    providerId: "ollama",
    authMode: "api_key",
    modelId: input.modelId,
    label: input.label ?? input.modelId,
    contextWindowTokens: input.contextWindowTokens ?? 8192,
    capabilities: { vision: input.vision ?? false },
    thinkingOptions: [offOption, onOption],
    defaultThinkingOptionId: "off",
  })
