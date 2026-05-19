import type { ProviderId, RuntimeConfig, ThinkingEffort } from "@socrates/contracts"

export type ModelMessage = {
  role: "user" | "assistant" | "system" | "developer"
  content: string
}

export type ModelUsage = {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  totalTokens?: number
  raw?: unknown
}

export type ModelRequest = {
  providerId: ProviderId
  modelId: string
  system: string
  messages: ModelMessage[]
  runtimeConfig: RuntimeConfig
  abortSignal?: AbortSignal
}

export type ModelEvent =
  | { type: "model.started"; modelCallId?: string }
  | { type: "model.reasoning.delta"; text: string }
  | { type: "model.answer.delta"; text: string }
  | { type: "model.usage"; usage: ModelUsage }
  | { type: "model.completed"; usage?: ModelUsage; finishReason?: string }
  | { type: "model.failed"; error: Error }

export interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
}

export type ProviderThinkingConfig =
  | { providerId: "openai"; effort: Exclude<ThinkingEffort, "minimal"> }
  | { providerId: "google"; effort: Extract<ThinkingEffort, "minimal" | "low" | "medium" | "high"> }
  | { providerId: "openrouter"; enabled: boolean }
