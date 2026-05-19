import type { ProviderId, RuntimeConfig } from "@socrates/contracts"
import type { ModelEvent, ModelMessage, ModelProvider } from "@socrates/providers"
import { buildSocratesSystemPrompt, type SocratesPromptContext } from "../prompts/socratesPrompt"

export type SocratesAgentTurnInput = {
  providerId: ProviderId
  modelId: string
  runtimeConfig: RuntimeConfig
  messages: ModelMessage[]
  promptContext?: SocratesPromptContext
  abortSignal?: AbortSignal
}

export class SocratesAgent {
  constructor(private readonly provider: ModelProvider) {}

  streamTurn(input: SocratesAgentTurnInput): AsyncIterable<ModelEvent> {
    return this.provider.stream({
      providerId: input.providerId,
      modelId: input.modelId,
      system: buildSocratesSystemPrompt(input.promptContext),
      messages: input.messages,
      runtimeConfig: input.runtimeConfig,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    })
  }
}
