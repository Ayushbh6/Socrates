import {
  memoryAgentJournalOutputSchema,
  type MemoryAgentJournalOutput,
  type ProviderId,
  type RuntimeConfig,
  type ThinkingEffort,
  type WorkerModelSettings,
} from "@socrates/contracts"
import { buildMemoryAgentSystemPrompt, createMemoryToolRegistry, StructuredToolAgentRunner } from "@socrates/core"
import type { ModelEvent, ModelProvider, ModelUsage } from "@socrates/providers"
import { createMemoryAgentToolExecutors, type MemoryAgentToolCallbacks } from "./memoryAgentToolExecutors"

const MEMORY_AGENT_RUNTIME_CONFIG = (input: MemoryAgentModelSettings): RuntimeConfig => ({
  providerId: input.providerId,
  authMode: input.authMode ?? "api_key",
  modelId: input.modelId,
  thinkingEnabled: input.thinkingEnabled,
  ...(input.thinkingEffort ? { thinkingEffort: input.thinkingEffort } : {}),
  approvalMode: "read_only_auto",
  sandboxMode: "read_only",
})

export type MemoryAgentModelSettings = {
  providerId: ProviderId
  authMode?: RuntimeConfig["authMode"]
  modelId: string
  thinkingEnabled: boolean
  thinkingEffort?: ThinkingEffort
}

export type MemoryAgentRunInput = {
  provider: ModelProvider
  modelSettings: MemoryAgentModelSettings
  evidence: string
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  workspacePath?: string
  socratesHome: string
  tools: MemoryAgentToolCallbacks
  contextCompressorSettings?: WorkerModelSettings
  onModelEvent?: (event: ModelEvent) => void
  onToolResult?: (result: { toolCallId: string; toolName: string; input: unknown; output: unknown }) => void
}

export type MemoryAgentRunResult = {
  output: MemoryAgentJournalOutput
  toolCalls: number
  usages: ModelUsage[]
}

export const runMemoryAgentTurn = async (input: MemoryAgentRunInput): Promise<MemoryAgentRunResult> => {
  const runtimeConfig = MEMORY_AGENT_RUNTIME_CONFIG(input.modelSettings)
  return new StructuredToolAgentRunner().run({
    provider: input.provider,
    providerId: input.modelSettings.providerId,
    modelId: input.modelSettings.modelId,
    runtimeConfig,
    system: buildMemoryAgentSystemPrompt({ socratesHome: input.socratesHome }),
    userContent: input.evidence,
    schema: memoryAgentJournalOutputSchema,
    toolRegistry: createMemoryToolRegistry(),
    toolExecutors: createMemoryAgentToolExecutors(input.tools),
    maxToolCalls: 60,
    projectId: input.projectId,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    workspacePath: input.workspacePath ?? input.socratesHome,
    contextCompression: {
      enabled: true,
      mode: "memory",
      ...(input.contextCompressorSettings
        ? {
            compressorProviderId: input.contextCompressorSettings.providerId,
            compressorAuthMode: input.contextCompressorSettings.authMode ?? "api_key",
            compressorModelId: input.contextCompressorSettings.modelId,
            compressorThinkingEnabled: input.contextCompressorSettings.thinkingEnabled,
            ...(input.contextCompressorSettings.thinkingEffort
              ? { compressorThinkingEffort: input.contextCompressorSettings.thinkingEffort }
              : {}),
          }
        : {}),
    },
    ...(input.onModelEvent ? { onModelEvent: input.onModelEvent } : {}),
    ...(input.onToolResult ? { onToolResult: input.onToolResult } : {}),
  })
}
