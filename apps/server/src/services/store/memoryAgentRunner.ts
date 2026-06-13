import type {
  ProviderId,
  RuntimeConfig,
  ThinkingEffort,
} from "@socrates/contracts"
import { buildMemoryAgentSystemPrompt, createMemoryToolRegistry, SocratesAgent, type SocratesAgentEvent } from "@socrates/core"
import type { ModelProvider } from "@socrates/providers"
import { createMemoryAgentToolExecutors, type MemoryAgentToolCallbacks } from "./memoryAgentToolExecutors"

const MEMORY_AGENT_RUNTIME_CONFIG = (input: MemoryAgentModelSettings): RuntimeConfig => ({
  providerId: input.providerId,
  modelId: input.modelId,
  thinkingEnabled: input.thinkingEnabled,
  ...(input.thinkingEffort ? { thinkingEffort: input.thinkingEffort } : {}),
  approvalMode: "read_only_auto",
  sandboxMode: "read_only",
})

export type MemoryAgentModelSettings = {
  providerId: ProviderId
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
  onEvent?: (event: SocratesAgentEvent) => void
}

export const runMemoryAgentTurn = async (input: MemoryAgentRunInput): Promise<string> => {
  const agent = new SocratesAgent(input.provider, createMemoryToolRegistry())
  const runtimeConfig = MEMORY_AGENT_RUNTIME_CONFIG(input.modelSettings)
  const systemPrompt = buildMemoryAgentSystemPrompt({
    socratesHome: input.socratesHome,
  })
  let text = ""
  for await (const event of agent.streamTurn({
    projectId: input.projectId,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    providerId: input.modelSettings.providerId,
    modelId: input.modelSettings.modelId,
    runtimeConfig,
    messages: [{ role: "user", content: input.evidence }],
    systemPromptOverride: systemPrompt,
    workspacePath: input.workspacePath ?? input.socratesHome,
    toolExecutors: createMemoryAgentToolExecutors(input.tools),
    requestApproval: async () => ({
      decision: "rejected",
      reason: "Backend memory agent writes only through scoped edit_files, which does not require external approval.",
    }),
    maxToolCallsPerTurn: 60,
    maxParallelToolCalls: 4,
    maxConfirmedToolErrorsPerTurn: 8,
  })) {
    input.onEvent?.(event)
    if (event.type === "model.answer.delta") {
      text += event.text
    }
    if (event.type === "model.failed") {
      throw event.error
    }
  }
  return text
}
