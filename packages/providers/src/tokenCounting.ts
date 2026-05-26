import { encodingForModel, getEncoding, type Tiktoken, type TiktokenModel } from "js-tiktoken"
import type { ModelRequest } from "./types"

export const DEFAULT_TOKEN_SAFETY_MARGIN_PERCENT = 15

export type TokenCountMethod = "provider_exact" | "local_tiktoken" | "local_tiktoken_with_margin" | "fallback_tiktoken_with_margin"

export type TokenCountResult = {
  providerId: string
  modelId: string
  inputTokens: number
  baseTokens: number
  method: TokenCountMethod
  safetyMarginPercent: number
  providerExactAttempted?: boolean
  warnings?: string[]
}

type CountableToolDefinition = {
  name: string
  description: string
  inputSchema: unknown
}

type CountableModelRequest = {
  providerId: string
  modelId: string
  system: string
  messages: unknown[]
  tools: CountableToolDefinition[]
  providerOptions?: unknown
}

const encoders = new Map<string, Tiktoken>()

export const countModelRequestLocally = (
  request: ModelRequest,
  options: { providerOptions?: unknown; safetyMarginPercent?: number; applySafetyMargin?: boolean } = {},
): TokenCountResult => {
  const payload = buildCountableModelRequest(request, options.providerOptions)
  const serialized = stableStringify(payload)
  const warnings: string[] = []
  const encoder = getEncoderForModel(request.modelId, warnings)
  const baseTokens = encoder.encode(serialized).length
  const margin = options.safetyMarginPercent ?? DEFAULT_TOKEN_SAFETY_MARGIN_PERCENT
  const applySafetyMargin = options.applySafetyMargin ?? shouldApplyLocalSafetyMargin(request.providerId, request.modelId)
  const inputTokens = applySafetyMargin ? applyMargin(baseTokens, margin) : baseTokens

  return {
    providerId: request.providerId,
    modelId: request.modelId,
    inputTokens,
    baseTokens,
    method: applySafetyMargin ? "local_tiktoken_with_margin" : "local_tiktoken",
    safetyMarginPercent: applySafetyMargin ? margin : 0,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

export const estimateTextTokens = (
  value: string,
  options: { modelId?: string; providerId?: string; safetyMarginPercent?: number; applySafetyMargin?: boolean } = {},
): TokenCountResult => {
  const warnings: string[] = []
  const encoder = getEncoderForModel(options.modelId ?? "gpt-5", warnings)
  const baseTokens = encoder.encode(value).length
  const margin = options.safetyMarginPercent ?? DEFAULT_TOKEN_SAFETY_MARGIN_PERCENT
  const applySafetyMargin = options.applySafetyMargin ?? true
  return {
    providerId: options.providerId ?? "local",
    modelId: options.modelId ?? "text",
    inputTokens: applySafetyMargin ? applyMargin(baseTokens, margin) : baseTokens,
    baseTokens,
    method: applySafetyMargin ? "fallback_tiktoken_with_margin" : "local_tiktoken",
    safetyMarginPercent: applySafetyMargin ? margin : 0,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

export const shouldUseProviderExactCount = (localCount: number, thresholds: number[]): boolean =>
  thresholds.some((threshold) => {
    const lowerBound = Math.floor(threshold * (1 - DEFAULT_TOKEN_SAFETY_MARGIN_PERCENT / 100))
    const upperBound = Math.ceil(threshold * (1 + DEFAULT_TOKEN_SAFETY_MARGIN_PERCENT / 100))
    return localCount >= lowerBound && localCount <= upperBound
  })

export const applyMargin = (tokens: number, marginPercent: number): number =>
  Math.ceil(tokens * (1 + Math.max(0, marginPercent) / 100))

export const buildCountableModelRequest = (request: ModelRequest, providerOptions?: unknown): CountableModelRequest => ({
  providerId: request.providerId,
  modelId: request.modelId,
  system: request.system,
  messages: request.messages,
  tools: (request.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: schemaForCounting(tool.inputSchema),
  })),
  ...(providerOptions === undefined ? {} : { providerOptions }),
})

export const stableStringify = (value: unknown): string =>
  JSON.stringify(toJsonValue(value), (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
    }
    return nested
  })

const schemaForCounting = (schema: unknown): unknown => {
  if (schema && typeof schema === "object" && "_def" in schema) {
    return toJsonValue((schema as { _def: unknown })._def)
  }
  return toJsonValue(schema)
}

const toJsonValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "bigint") {
    return value.toString()
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, seen))
  }
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, item]) => [String(key), toJsonValue(item, seen)]))
  }
  if (value instanceof Set) {
    return [...value].map((item) => toJsonValue(item, seen))
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]"
    }
    seen.add(value)
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, toJsonValue(item, seen)] as const)
        .filter(([, item]) => item !== undefined),
    )
  }
  return String(value)
}

const shouldApplyLocalSafetyMargin = (providerId: string, modelId: string): boolean => {
  if (providerId === "openrouter") {
    return true
  }
  return !isKnownOpenAiTokenizerModel(modelId)
}

const getEncoderForModel = (modelId: string, warnings: string[]): Tiktoken => {
  const encodingName = encodingNameForModel(modelId, warnings)
  const cached = encoders.get(encodingName)
  if (cached) {
    return cached
  }
  const encoder = getEncoding(encodingName as Parameters<typeof getEncoding>[0])
  encoders.set(encodingName, encoder)
  return encoder
}

const encodingNameForModel = (modelId: string, warnings: string[]): string => {
  const normalized = modelId.toLowerCase()
  if (normalized.startsWith("gpt-5") || normalized.startsWith("gpt-4.1") || normalized.startsWith("o")) {
    return "o200k_base"
  }
  if (normalized.includes("gpt-4") || normalized.includes("gpt-3.5")) {
    try {
      encodingForModel(modelId as TiktokenModel)
      return "cl100k_base"
    } catch {
      return "cl100k_base"
    }
  }
  warnings.push(`No exact tokenizer mapping for ${modelId}; using o200k_base with safety margin.`)
  return "o200k_base"
}

const isKnownOpenAiTokenizerModel = (modelId: string): boolean => {
  const normalized = modelId.toLowerCase()
  return normalized.startsWith("gpt-5") || normalized.startsWith("gpt-4") || normalized.startsWith("gpt-3.5") || normalized.startsWith("o")
}
