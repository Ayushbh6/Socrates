import type {
  ProviderId,
  RuntimeConfig,
  SkillScope,
  ThinkingEffort,
  WorkerModelSettings,
} from "@socrates/contracts"
import { buildSkillWriterSystemPrompt, createSkillWriterToolRegistry, SocratesAgent, type SocratesAgentEvent } from "@socrates/core"
import type { ModelProvider } from "@socrates/providers"
import { createSkillWriterToolExecutors, type SkillWriterToolCallbacks } from "./skillWriterToolExecutors"

const SKILL_WRITER_RUNTIME_CONFIG = (input: SkillWriterModelSettings): RuntimeConfig => ({
  providerId: input.providerId,
  authMode: input.authMode ?? "api_key",
  modelId: input.modelId,
  thinkingEnabled: input.thinkingEnabled,
  ...(input.thinkingEffort ? { thinkingEffort: input.thinkingEffort } : {}),
  approvalMode: "read_only_auto",
  sandboxMode: "read_only",
})

export type SkillWriterModelSettings = {
  providerId: ProviderId
  authMode?: RuntimeConfig["authMode"]
  modelId: string
  thinkingEnabled: boolean
  thinkingEffort?: ThinkingEffort
}

export type SkillWriterRunInput = {
  provider: ModelProvider
  modelSettings: SkillWriterModelSettings
  scope: SkillScope
  operation: "create" | "update"
  name: string
  request: string
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  workspacePath?: string
  socratesHome: string
  tools: SkillWriterToolCallbacks
  contextCompressorSettings?: WorkerModelSettings
  onEvent?: (event: SocratesAgentEvent) => void
}

export const runSkillWriterTurn = async (input: SkillWriterRunInput): Promise<string> => {
  const agent = new SocratesAgent(input.provider, createSkillWriterToolRegistry())
  const runtimeConfig = SKILL_WRITER_RUNTIME_CONFIG(input.modelSettings)
  const systemPrompt = buildSkillWriterSystemPrompt({
    socratesHome: input.socratesHome,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
  })
  const task = [
    "# Approved Skill Writer Task",
    `scope: ${input.scope}`,
    `operation: ${input.operation}`,
    `skill_name: ${input.name}`,
    "",
    "Approved request:",
    input.request.trim(),
    "",
    "You must call skill_write with the complete final SKILL.md.",
  ].join("\n")

  let text = ""
  for await (const event of agent.streamTurn({
    projectId: input.projectId,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    providerId: input.modelSettings.providerId,
    modelId: input.modelSettings.modelId,
    runtimeConfig,
    messages: [{ role: "user", content: task }],
    systemPromptOverride: systemPrompt,
    workspacePath: input.workspacePath ?? input.socratesHome,
    toolExecutors: createSkillWriterToolExecutors(input.tools),
    requestApproval: async () => ({
      decision: "rejected",
      reason: "Skill Writer Agent only writes through scoped skill_write, which does not require external approval.",
    }),
    maxToolCallsPerTurn: 20,
    maxParallelToolCalls: 2,
    maxConfirmedToolErrorsPerTurn: 4,
    contextCompression: {
      enabled: true,
      mode: "memory",
      ...(input.contextCompressorSettings
        ? {
            compressorProviderId: input.contextCompressorSettings.providerId,
            compressorAuthMode: input.contextCompressorSettings.authMode ?? "api_key",
            compressorModelId: input.contextCompressorSettings.modelId,
            compressorThinkingEnabled: input.contextCompressorSettings.thinkingEnabled,
            ...(input.contextCompressorSettings.thinkingEffort ? { compressorThinkingEffort: input.contextCompressorSettings.thinkingEffort } : {}),
          }
        : {}),
    },
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
