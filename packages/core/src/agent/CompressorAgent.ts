import {
  anchorRepairSchema,
  chatCompactionDraftSchema,
  chatCompactionSchema,
  memoryCompactionDraftSchema,
  memoryCompactionSchema,
  type ChatCompaction,
  type MemoryCompaction,
} from "@socrates/contracts"
import type { ModelProvider, ModelUsage, StructuredModelRequest, StructuredModelResult } from "@socrates/providers"
import type { ProviderId } from "@socrates/contracts"
import { createId, SocratesError } from "@socrates/shared"
import { SOCRATES_ANCHOR_REPAIR_SYSTEM_PROMPT } from "../prompts/socratesCompressorPrompt"

export type CompressorAgentMode = "chat" | "memory"

export type CompressorAgentModel = {
  providerId: ProviderId
  modelId: string
}

export type CompressorAgentRunInput = {
  provider: ModelProvider
  mode: CompressorAgentMode
  primary: CompressorAgentModel
  fallback?: CompressorAgentModel
  fallbacks?: CompressorAgentModel[]
  system: string
  userContent: string
}

export type CompressorAgentResult =
  | {
      mode: "chat"
      output: ChatCompaction
      providerId: ProviderId
      modelId: string
      usage?: ModelUsage
      repairedAnchors: boolean
      attempts: number
    }
  | {
      mode: "memory"
      output: MemoryCompaction
      providerId: ProviderId
      modelId: string
      usage?: ModelUsage
      repairedAnchors: boolean
      attempts: number
    }

export class CompressorAgent {
  async run(input: CompressorAgentRunInput): Promise<CompressorAgentResult> {
    if (!input.provider.generateStructured) {
      throw new SocratesError("compressor_structured_generation_unavailable", "Compressor requires provider.generateStructured().", {
        recoverable: true,
      })
    }

    const candidates = uniqueByModel([
      input.primary,
      ...(input.fallback ? [input.fallback] : []),
      ...(input.fallbacks ?? []),
    ])
    let lastError: unknown
    let totalAttempts = 0

    for (const [candidateIndex, candidate] of candidates.entries()) {
      const maxAttempts = candidateIndex === 0 ? 2 : 1
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        totalAttempts += 1
        try {
          return await this.runOnce(input, candidate, totalAttempts)
        } catch (error) {
          lastError = error
        }
      }
    }

    throw normalizeCompressorError(lastError)
  }

  private async runOnce(
    input: CompressorAgentRunInput,
    model: CompressorAgentModel,
    attemptNumber: number,
  ): Promise<CompressorAgentResult> {
    const schemas = schemasForMode(input.mode)
    const generated = await generateStructured<unknown>(input.provider, {
      providerId: model.providerId,
      modelId: model.modelId,
      system: input.system,
      messages: [{ role: "user", content: input.userContent }],
      runtimeConfig: compressorRuntimeConfig(model),
      schema: schemas.draft,
      modelCallId: createId("mcall"),
    })

    const strict = schemas.strict.safeParse(generated.output)
    if (strict.success) {
      return {
        mode: input.mode,
        output: strict.data as never,
        providerId: model.providerId,
        modelId: model.modelId,
        ...(generated.usage ? { usage: generated.usage } : {}),
        repairedAnchors: false,
        attempts: attemptNumber,
      } as CompressorAgentResult
    }

    const withoutAnchors = schemas.rest.safeParse(generated.output)
    if (!withoutAnchors.success) {
      throw new SocratesError("compressor_schema_validation_failed", "Compressor output did not match the required schema.", {
        details: strict.error.flatten(),
        recoverable: true,
      })
    }

    const repaired = await generateStructured<{ anchors: string[] }>(input.provider, {
      providerId: model.providerId,
      modelId: model.modelId,
      system: SOCRATES_ANCHOR_REPAIR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            "# Source Text",
            input.userContent,
            "",
            "# Bad Anchors",
            JSON.stringify(anchorValue(generated.output), null, 2),
          ].join("\n"),
        },
      ],
      runtimeConfig: compressorRuntimeConfig(model),
      schema: anchorRepairSchema,
      modelCallId: createId("mcall"),
    })
    const repairedOutput = { ...recordOrEmpty(generated.output), anchors: repaired.output.anchors }
    const repairedStrict = schemas.strict.safeParse(repairedOutput)
    if (!repairedStrict.success) {
      throw new SocratesError("compressor_anchor_repair_failed", "Compressor anchor repair did not produce valid anchors.", {
        details: repairedStrict.error.flatten(),
        recoverable: true,
      })
    }

    return {
      mode: input.mode,
      output: repairedStrict.data as never,
      providerId: model.providerId,
      modelId: model.modelId,
      usage: mergeUsage(generated.usage, repaired.usage),
      repairedAnchors: true,
      attempts: attemptNumber,
    } as CompressorAgentResult
  }
}

const schemasForMode = (mode: CompressorAgentMode) =>
  mode === "chat"
    ? {
        draft: chatCompactionDraftSchema,
        strict: chatCompactionSchema,
        rest: chatCompactionDraftSchema,
      }
    : {
        draft: memoryCompactionDraftSchema,
        strict: memoryCompactionSchema,
        rest: memoryCompactionDraftSchema,
      }

const compressorRuntimeConfig = (model: CompressorAgentModel) => ({
  providerId: model.providerId,
  modelId: model.modelId,
  thinkingEnabled: false,
  thinkingEffort: "none" as const,
  approvalMode: "read_only_auto" as const,
  sandboxMode: "read_only" as const,
})

const anchorValue = (output: unknown): unknown =>
  output && typeof output === "object" && "anchors" in output ? (output as { anchors?: unknown }).anchors : undefined

const recordOrEmpty = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})

const generateStructured = async <TOutput>(
  provider: ModelProvider,
  request: StructuredModelRequest<TOutput>,
): Promise<StructuredModelResult<TOutput>> => {
  const method = provider.generateStructured
  if (!method) {
    throw new SocratesError("compressor_structured_generation_unavailable", "Compressor requires provider.generateStructured().", {
      recoverable: true,
    })
  }
  const bound = method.bind(provider) as <T>(request: StructuredModelRequest<T>) => Promise<StructuredModelResult<T>>
  return bound<TOutput>(request)
}

const mergeUsage = (first?: ModelUsage, second?: ModelUsage): ModelUsage | undefined => {
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  const merged: ModelUsage = { ...first }
  assignSum(merged, "inputTokens", first.inputTokens, second.inputTokens)
  assignSum(merged, "outputTokens", first.outputTokens, second.outputTokens)
  assignSum(merged, "reasoningTokens", first.reasoningTokens, second.reasoningTokens)
  assignSum(merged, "cachedInputTokens", first.cachedInputTokens, second.cachedInputTokens)
  assignSum(merged, "cacheWriteTokens", first.cacheWriteTokens, second.cacheWriteTokens)
  assignSum(merged, "uncachedInputTokens", first.uncachedInputTokens, second.uncachedInputTokens)
  assignSum(merged, "totalTokens", first.totalTokens, second.totalTokens)
  assignSum(merged, "costUsd", first.costUsd, second.costUsd)
  return merged
}

const sumDefined = (first?: number, second?: number): number | undefined =>
  first === undefined && second === undefined ? undefined : (first ?? 0) + (second ?? 0)

const assignSum = (usage: ModelUsage, key: keyof Pick<ModelUsage, "inputTokens" | "outputTokens" | "reasoningTokens" | "cachedInputTokens" | "cacheWriteTokens" | "uncachedInputTokens" | "totalTokens" | "costUsd">, first?: number, second?: number): void => {
  const value = sumDefined(first, second)
  if (value !== undefined) {
    usage[key] = value
  }
}

const uniqueByModel = <T extends CompressorAgentModel>(items: T[]): T[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.providerId}:${item.modelId}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const normalizeCompressorError = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new SocratesError("compressor_failed", "Compressor failed.", {
        details: { error },
        recoverable: true,
      })
