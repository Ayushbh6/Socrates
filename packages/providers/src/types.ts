import type { ModelToolDefinition, NormalizedToolCall, ProviderId, ProviderMetadata, RuntimeConfig, ThinkingEffort } from "@socrates/contracts"

export type ModelMessage = {
  role: "user" | "assistant" | "system" | "developer" | "tool"
  content: ModelMessageContent
}

export type ModelMessageContent = string | ModelMessagePart[]

export type ModelMessagePart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown; providerMetadata?: ProviderMetadata }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }

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
  tools?: ModelToolDefinition[]
  modelCallId?: string
  abortSignal?: AbortSignal
}

export type ModelEvent =
  | { type: "model.started"; modelCallId?: string }
  | { type: "model.reasoning.delta"; text: string; modelCallId?: string }
  | { type: "model.answer.delta"; text: string; modelCallId?: string }
  | { type: "model.tool_call.completed"; toolCall: NormalizedToolCall; modelCallId?: string }
  | { type: "model.usage"; usage: ModelUsage; modelCallId?: string }
  | { type: "model.completed"; usage?: ModelUsage; finishReason?: string; modelCallId?: string }
  | { type: "model.failed"; error: Error; modelCallId?: string }

export interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
}

export type ProviderThinkingConfig =
  | { providerId: "openai"; effort: Exclude<ThinkingEffort, "minimal"> }
  | { providerId: "google"; effort: Extract<ThinkingEffort, "minimal" | "low" | "medium" | "high"> }
  | { providerId: "openrouter"; enabled: boolean }
