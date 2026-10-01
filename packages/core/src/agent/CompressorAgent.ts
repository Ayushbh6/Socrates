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
import type { ProviderAuthMode, ProviderId, ThinkingEffort } from "@socrates/contracts"
import { createId, SocratesError } from "@socrates/shared"
import { SOCRATES_ANCHOR_REPAIR_SYSTEM_PROMPT } from "../prompts/socratesCompressorPrompt"

export type CompressorAgentMode = "chat" | "memory"

export type CompressorAgentModel = {
  providerId: ProviderId
  authMode?: ProviderAuthMode
  modelId: string
  thinkingEnabled?: boolean
  thinkingEffort?: ThinkingEffort
}

export type CompressorAgentRunInput = {
  provider: ModelProvider
  mode: CompressorAgentMode
  primary: CompressorAgentModel
  fallback?: CompressorAgentModel
  fallbacks?: CompressorAgentModel[]
  system: string
  userContent: string
  allowedTurnNumbers?: number[]
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
      assertAnchorTurnsAllowed(strict.data as { anchors: string[] }, input.allowedTurnNumbers)
      const output = enforceDeterministicCarryover(input.mode, strict.data, input.userContent, schemas.strict)
      return {
        mode: input.mode,
        output: output as never,
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
    assertAnchorTurnsAllowed(repairedStrict.data as { anchors: string[] }, input.allowedTurnNumbers)
    const output = enforceDeterministicCarryover(input.mode, repairedStrict.data, input.userContent, schemas.strict)

    return {
      mode: input.mode,
      output: output as never,
      providerId: model.providerId,
      modelId: model.modelId,
      usage: mergeUsage(generated.usage, repaired.usage),
      repairedAnchors: true,
      attempts: attemptNumber,
    } as CompressorAgentResult
  }
}

const enforceDeterministicCarryover = <TOutput>(
  mode: CompressorAgentMode,
  output: TOutput,
  userContent: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: { flatten: () => unknown } } },
): TOutput => {
  if (mode !== "chat" || !output || typeof output !== "object" || !("relevantFiles" in output) || !("toolState" in output) || !("blocked" in output)) return output
  const record = output as TOutput & { relevantFiles: string[]; toolState: string[]; blocked: string[] }
  const paths = Array.from(userContent.matchAll(/\.socrates\/attachments\/[A-Za-z0-9._/-]+/g))
    .map((match) => match[0].replace(/[.,;:]+$/, ""))
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 8)
  const missing = paths.filter((attachmentPath) => !record.relevantFiles.some((line) => line.includes(attachmentPath)))
  const carriedCommands = Array.from(userContent.matchAll(/Exact historical command:\s*((?:pnpm|npm|yarn|bun|git)\s+[^\n`]{1,300})/g))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
  const detectedCommands = Array.from(userContent.matchAll(/\b(?:pnpm|npm|yarn|bun|git)\s+[^\n`]{1,300}?(?=\s+and the file\b|[.;](?:\s|$)|\r?\n|$)/g))
    .map((match) => match[0].trim())
  const commands = [...carriedCommands, ...detectedCommands]
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 8)
  const missingCommands = commands.filter((command) => !record.toolState.some((line) => line.includes(command)))
  const unresolvedInstructions = userContent
    .split(/\r?\n/)
    .map((line) => line.replace(/^User:\s*/i, "").trim())
    .filter((line) => /\bunresolved task\b|\bdo not mark (?:it )?completed\b/i.test(line))
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 8)
  const missingUnresolved = unresolvedInstructions.filter((instruction) => !record.blocked.some((line) => line.includes(instruction)))
  if (missing.length === 0 && missingCommands.length === 0 && missingUnresolved.length === 0) return output
  const candidate = {
    ...record,
    relevantFiles: [
      ...record.relevantFiles,
      ...missing.map((attachmentPath) => `${attachmentPath}: conversation source attachment; inspect with read or search before relying on it.`),
    ],
    toolState: [
      ...record.toolState,
      ...missingCommands.map((command) => `Exact historical command: ${command}`),
    ],
    blocked: [
      ...record.blocked,
      ...missingUnresolved.map((instruction) => `Explicit unresolved user instruction: ${instruction}`),
    ],
  }
  const parsed = schema.safeParse(candidate)
  if (!parsed.success) {
    throw new SocratesError("compressor_deterministic_carryover_failed", "Required exact source artifacts could not fit the compaction schema.", {
      details: { validation: parsed.error?.flatten() },
      recoverable: true,
    })
  }
  return parsed.data as TOutput
}

const assertAnchorTurnsAllowed = (output: { anchors: string[] }, allowedTurnNumbers?: number[]): void => {
  if (!allowedTurnNumbers) return
  const allowed = new Set(allowedTurnNumbers)
  const invalid = output.anchors.filter((anchor) => {
    const match = /^Turn (\d+):/.exec(anchor)
    return !match || !allowed.has(Number(match[1]))
  })
  if (invalid.length > 0) {
    throw new SocratesError("compressor_anchor_turn_not_in_input", "Compressor anchors referenced turns that were not present in its input.", {
      details: { invalid, allowedTurnNumbers },
      recoverable: true,
    })
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
  authMode: model.authMode ?? "api_key",
  modelId: model.modelId,
  thinkingEnabled: model.thinkingEnabled ?? false,
  ...(model.thinkingEffort ? { thinkingEffort: model.thinkingEffort } : model.thinkingEnabled ? {} : { thinkingEffort: "none" as const }),
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
    const key = `${item.providerId}:${item.authMode ?? "api_key"}:${item.modelId}`
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
