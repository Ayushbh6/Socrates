import {
  conversationTitleAgentOutputSchema,
  type ConversationTitleAgentOutput,
  type ProviderAuthMode,
  type ProviderId,
  type RuntimeConfig,
  type ThinkingEffort,
} from "@socrates/contracts"
import type { ModelMessageContent, ModelProvider, ModelUsage } from "@socrates/providers"
import { TITLE_GENERATOR_SYSTEM_PROMPT } from "../prompts/titleGeneratorPrompt"
import { createTitleGeneratorToolRegistry } from "../tools/registry"
import { StructuredToolAgentRunner } from "./StructuredToolAgentRunner"

export type TitleGeneratorAgentModelSettings = {
  providerId: ProviderId
  authMode?: ProviderAuthMode
  modelId: string
  thinkingEnabled: boolean
  thinkingEffort?: ThinkingEffort
}

export type TitleGeneratorAgentInput = {
  provider: ModelProvider
  modelSettings: TitleGeneratorAgentModelSettings
  userContent: ModelMessageContent
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  workspacePath: string
  abortSignal?: AbortSignal
}

export type TitleGeneratorAgentResult = {
  output: ConversationTitleAgentOutput
  usages: ModelUsage[]
}

export class TitleGeneratorAgent {
  async run(input: TitleGeneratorAgentInput): Promise<TitleGeneratorAgentResult> {
    const result = await new StructuredToolAgentRunner().run({
      provider: input.provider,
      providerId: input.modelSettings.providerId,
      modelId: input.modelSettings.modelId,
      runtimeConfig: titleGeneratorRuntimeConfig(input.modelSettings),
      system: TITLE_GENERATOR_SYSTEM_PROMPT,
      userContent: input.userContent,
      schema: conversationTitleAgentOutputSchema,
      toolRegistry: createTitleGeneratorToolRegistry(),
      toolExecutors: {},
      maxToolCalls: 0,
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      workspacePath: input.workspacePath,
      cacheKey: `project:${input.projectId}:conversation:${input.conversationId}:title`,
      providerRouting: { omitReasoning: true },
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    })
    return { output: result.output, usages: result.usages }
  }
}

const titleGeneratorRuntimeConfig = (settings: TitleGeneratorAgentModelSettings): RuntimeConfig => ({
  providerId: settings.providerId,
  authMode: settings.authMode ?? "api_key",
  modelId: settings.modelId,
  thinkingEnabled: settings.thinkingEnabled,
  ...(settings.thinkingEffort ? { thinkingEffort: settings.thinkingEffort } : {}),
  approvalMode: "read_only_auto",
  sandboxMode: "read_only",
})
