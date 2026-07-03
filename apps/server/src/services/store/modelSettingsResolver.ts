import type {
  ListModelsResponse,
  ModelOption,
  ModelSettingsResolution,
  ModelSettingsSelection,
  WorkerModelRole,
} from "@socrates/contracts"
import {
  DEFAULT_MEMORY_AGENT_AUTH_MODE,
  DEFAULT_MEMORY_AGENT_MODEL_ID,
  DEFAULT_MEMORY_AGENT_PROVIDER_ID,
  DEFAULT_MEMORY_AGENT_THINKING_EFFORT,
  DEFAULT_MEMORY_AGENT_THINKING_ENABLED,
} from "./memoryAgentDefaults"
import { DEFAULT_WORKER_MODEL_SETTINGS } from "./workerModelSettingsStore"

export type ModelSettingsRole = "chat" | "memory_agent" | WorkerModelRole

const modelSettingsFromOption = (model: ModelOption): ModelSettingsSelection => {
  const thinkingOption = model.thinkingOptions.find((option) => option.id === model.defaultThinkingOptionId) ?? model.thinkingOptions[0]
  return {
    providerId: model.providerId,
    authMode: model.authMode,
    modelId: model.modelId,
    thinkingEnabled: thinkingOption?.enabled ?? false,
    ...(thinkingOption?.enabled && thinkingOption.effort ? { thinkingEffort: thinkingOption.effort } : {}),
  }
}

const CHATGPT_CODEX_ROLE_DEFAULTS: Record<"memory_agent" | WorkerModelRole, Omit<ModelSettingsSelection, "providerId" | "authMode">> = {
  skill_writer: {
    modelId: "gpt-5.4-mini",
    thinkingEnabled: true,
    thinkingEffort: "low",
  },
  context_compactor: {
    modelId: "gpt-5.4-mini",
    thinkingEnabled: true,
    thinkingEffort: "low",
  },
  title_generator: {
    modelId: "gpt-5.4-mini",
    thinkingEnabled: true,
    thinkingEffort: "low",
  },
  memory_router: {
    modelId: "gpt-5.4-mini",
    thinkingEnabled: true,
    thinkingEffort: "low",
  },
  memory_agent: {
    modelId: "gpt-5.5",
    thinkingEnabled: true,
    thinkingEffort: "low",
  },
}

const chatGptCodexPreferredSettings = (
  role: ModelSettingsRole,
  models: readonly ModelOption[],
): ModelSettingsSelection | undefined => {
  if (role === "chat") {
    return undefined
  }
  const preferred = CHATGPT_CODEX_ROLE_DEFAULTS[role]
  const model = models.find(
    (candidate) =>
      candidate.providerId === "openai" &&
      candidate.authMode === "chatgpt_subscription" &&
      candidate.modelId === preferred.modelId,
  )
  if (!model) {
    return undefined
  }
  return {
    providerId: "openai",
    authMode: "chatgpt_subscription",
    modelId: model.modelId,
    thinkingEnabled: preferred.thinkingEnabled,
    ...(preferred.thinkingEffort ? { thinkingEffort: preferred.thinkingEffort } : {}),
  }
}

const isBuiltInDefaultModelSelection = (saved: ModelSettingsSelection, role: ModelSettingsRole): boolean => {
  if (role === "chat") {
    return false
  }
  const defaults =
    role === "memory_agent"
      ? {
          providerId: DEFAULT_MEMORY_AGENT_PROVIDER_ID,
          authMode: DEFAULT_MEMORY_AGENT_AUTH_MODE,
          modelId: DEFAULT_MEMORY_AGENT_MODEL_ID,
          thinkingEnabled: DEFAULT_MEMORY_AGENT_THINKING_ENABLED,
          thinkingEffort: DEFAULT_MEMORY_AGENT_THINKING_EFFORT,
        }
      : DEFAULT_WORKER_MODEL_SETTINGS[role]

  return (
    saved.providerId === defaults.providerId &&
    (saved.authMode ?? "api_key") === (defaults.authMode ?? "api_key") &&
    saved.modelId === defaults.modelId &&
    saved.thinkingEnabled === defaults.thinkingEnabled &&
    (saved.thinkingEffort ?? undefined) === (defaults.thinkingEffort ?? undefined)
  )
}

const modelRoleLabel = (role: ModelSettingsRole): string => {
  switch (role) {
    case "chat":
      return "Chat"
    case "memory_agent":
      return "Memory agent"
    case "skill_writer":
      return "Skill writer"
    case "context_compactor":
      return "Context compressor"
    case "title_generator":
      return "Title generator"
    case "memory_router":
      return "Memory router"
  }
}

export const resolveModelSettingsForAvailableModels = (
  saved: ModelSettingsSelection,
  role: ModelSettingsRole,
  available: ListModelsResponse,
): ModelSettingsResolution => {
  const savedSelection: ModelSettingsSelection = {
    providerId: saved.providerId,
    authMode: saved.authMode ?? "api_key",
    modelId: saved.modelId,
    thinkingEnabled: saved.thinkingEnabled,
    ...(saved.thinkingEffort ? { thinkingEffort: saved.thinkingEffort } : {}),
  }
  const selected = available.models.find(
    (model) =>
      model.providerId === savedSelection.providerId &&
      model.authMode === savedSelection.authMode &&
      model.modelId === savedSelection.modelId,
  )
  const preferred = chatGptCodexPreferredSettings(role, available.models)
  if (
    preferred &&
    (savedSelection.authMode !== "chatgpt_subscription" || !selected || isBuiltInDefaultModelSelection(savedSelection, role))
  ) {
    return {
      status: "resolved_fallback",
      reason: `${modelRoleLabel(role)} is using the ChatGPT Codex default (${preferred.modelId}).`,
      saved: savedSelection,
      effective: preferred,
    }
  }
  if (selected) {
    return {
      status: "selected",
      saved: savedSelection,
      effective: savedSelection,
    }
  }

  const fallback = available.defaultModel
    ? available.models.find(
        (model) =>
          model.providerId === available.defaultModel?.providerId &&
          model.authMode === available.defaultModel?.authMode &&
          model.modelId === available.defaultModel?.modelId,
      )
    : undefined
  if (fallback) {
    return {
      status: "resolved_fallback",
      reason: `${modelRoleLabel(role)} model is unavailable; using ${fallback.label} from ${fallback.providerLabel}.`,
      saved: savedSelection,
      effective: modelSettingsFromOption(fallback),
    }
  }

  return {
    status: "unavailable",
    reason: "No model provider credential is configured.",
    saved: savedSelection,
  }
}
