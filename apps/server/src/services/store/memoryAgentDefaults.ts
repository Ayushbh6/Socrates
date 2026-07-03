import type { ProviderAuthMode, ProviderId, ThinkingEffort } from "@socrates/contracts"

export const DEFAULT_MEMORY_AGENT_PROVIDER_ID: ProviderId = "openrouter"
export const DEFAULT_MEMORY_AGENT_AUTH_MODE: ProviderAuthMode = "api_key"
export const DEFAULT_MEMORY_AGENT_MODEL_ID = "xiaomi/mimo-v2.5-pro"
export const DEFAULT_MEMORY_AGENT_THINKING_ENABLED = false
export const DEFAULT_MEMORY_AGENT_THINKING_EFFORT: ThinkingEffort | undefined = undefined
