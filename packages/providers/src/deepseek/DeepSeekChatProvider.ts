import { createHash } from "node:crypto"
import type { NormalizedToolCall } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { envProviderCredentialResolver } from "../credentials"
import { createStreamTimeout } from "../streamTimeout"
import { countModelRequestLocally, type TokenCountResult } from "../tokenCounting"
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ModelUsage,
  ProviderCredentialResolver,
  StructuredModelRequest,
  StructuredModelResult,
} from "../types"
import { createDeepSeekChatRequest } from "./messages"
import { readDeepSeekSse } from "./stream"
import type { DeepSeekChatCompletionChunk, DeepSeekChatCompletionResponse, DeepSeekToolCallDelta } from "./types"
import { usageFromDeepSeek } from "./usage"

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com"

type DeepSeekChatProviderOptions = {
  baseUrl?: string
}

type ToolAccumulator = {
  index: number
  id?: string
  name: string
  argumentsText: string
  rawDeltas: DeepSeekToolCallDelta[]
}

export class DeepSeekChatProvider implements ModelProvider {
  constructor(
    private readonly credentials: ProviderCredentialResolver = envProviderCredentialResolver,
    private readonly options: DeepSeekChatProviderOptions = {},
  ) {}

  async countTokens(request: ModelRequest): Promise<TokenCountResult> {
    return countModelRequestLocally(request)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const streamTimeout = createStreamTimeout(request)
    try {
      yield { type: "model.started", ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}) }
      const response = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: this.headers(request),
        body: JSON.stringify(createDeepSeekChatRequest(request, { stream: true })),
        signal: streamTimeout.signal,
      })
      await assertOk(response)

      let reasoningText = ""
      let reasoningCompleted = false
      let latestUsage: ModelUsage | undefined
      let finishReason: string | undefined
      let metadataEmitted = false
      const toolCalls = new Map<number, ToolAccumulator>()
      const completedToolIndexes = new Set<number>()

      const flushReasoning = function* (): Iterable<ModelEvent> {
        if (reasoningCompleted || !reasoningText) {
          return
        }
        reasoningCompleted = true
        yield {
          type: "model.reasoning.completed",
          text: reasoningText,
          providerMetadata: { deepseek: { reasoningContent: reasoningText } },
          ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}),
        }
      }

      for await (const chunk of readDeepSeekSse(response, streamTimeout.refresh)) {
        streamTimeout.refresh()
        const metadata = responseMetadata(chunk)
        if (!metadataEmitted && metadata) {
          metadataEmitted = true
          yield { type: "model.response.metadata", response: metadata, ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}) }
        }
        if (chunk.usage) {
          latestUsage = usageFromDeepSeek(request.modelId, chunk.usage, metadata)
        }
        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) {
            finishReason = choice.finish_reason
          }
          const reasoningDelta = choice.delta?.reasoning_content
          if (reasoningDelta) {
            reasoningText += reasoningDelta
            if (request.runtimeConfig.thinkingEnabled) {
              yield {
                type: "model.reasoning.delta",
                text: reasoningDelta,
                ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}),
              }
            }
          }
          const contentDelta = choice.delta?.content
          if (contentDelta) {
            yield { type: "model.answer.delta", text: contentDelta, ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}) }
          }
          for (const toolCallDelta of choice.delta?.tool_calls ?? []) {
            for (const event of flushReasoning()) {
              yield event
            }
            const entry = accumulateToolCall(toolCalls, toolCallDelta)
            if (entry.id && entry.name) {
              yield {
                type: "model.tool_call.streaming",
                toolCallId: entry.id,
                toolName: entry.name,
                argsText: entry.argumentsText,
                ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}),
              }
            }
          }
          if (choice.finish_reason === "tool_calls") {
            for (const event of completeToolCalls(toolCalls, completedToolIndexes, request.modelCallId)) {
              yield event
            }
          }
        }
      }

      for (const event of flushReasoning()) {
        yield event
      }
      for (const event of completeToolCalls(toolCalls, completedToolIndexes, request.modelCallId)) {
        yield event
      }
      if (latestUsage) {
        yield { type: "model.usage", usage: latestUsage, ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}) }
      }
      yield {
        type: "model.completed",
        ...(latestUsage ? { usage: latestUsage } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}),
      }
    } catch (error) {
      const normalized = streamTimeout.timeoutError ?? normalizeDeepSeekError(error)
      yield { type: "model.failed", error: normalized, ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}) }
      throw normalized
    } finally {
      streamTimeout.dispose()
    }
  }

  async generateStructured<TOutput>(request: StructuredModelRequest<TOutput>): Promise<StructuredModelResult<TOutput>> {
    const streamTimeout = createStreamTimeout(request)
    try {
      const response = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: this.headers(request),
        body: JSON.stringify(createDeepSeekChatRequest(request, { stream: false, jsonObject: true, schema: request.schema })),
        signal: streamTimeout.signal,
      })
      await assertOk(response)
      const raw = (await response.json()) as DeepSeekChatCompletionResponse
      const metadata = responseMetadata(raw)
      const usage = usageFromDeepSeek(request.modelId, raw.usage, metadata)
      const content = raw.choices?.[0]?.message?.content ?? ""
      return {
        output: parseStructuredOutput<TOutput>(content),
        ...(usage ? { usage } : {}),
        raw,
      }
    } catch (error) {
      throw streamTimeout.timeoutError ?? normalizeDeepSeekError(error)
    } finally {
      streamTimeout.dispose()
    }
  }

  private headers(request: Pick<ModelRequest, "providerId" | "runtimeConfig">): Record<string, string> {
    const credential = this.credentials.resolveAuth
      ? this.credentials.resolveAuth(request.providerId, request.runtimeConfig.authMode ?? "api_key")
      : undefined
    const apiKey =
      credential?.authMode === "api_key" ? credential.apiKey : this.credentials.getApiKey(request.providerId)
    if (!apiKey) {
      throw new SocratesError("provider_credential_missing", "DeepSeek API key is not configured.", {
        details: { providerId: request.providerId },
        recoverable: true,
      })
    }
    return {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    }
  }

  private baseUrl(): string {
    return normalizeDeepSeekBaseUrl(this.options.baseUrl)
  }
}

export const normalizeDeepSeekBaseUrl = (baseUrl: string | undefined): string =>
  (baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL).trim().replace(/\/+$/, "")

const accumulateToolCall = (entries: Map<number, ToolAccumulator>, delta: DeepSeekToolCallDelta): ToolAccumulator => {
  const index = Number.isInteger(delta.index) ? Number(delta.index) : entries.size
  const entry = entries.get(index) ?? { index, name: "", argumentsText: "", rawDeltas: [] }
  if (delta.id) {
    entry.id = delta.id
  }
  if (delta.function?.name) {
    entry.name += delta.function.name
  }
  if (delta.function?.arguments) {
    entry.argumentsText += delta.function.arguments
  }
  entry.rawDeltas.push(delta)
  entries.set(index, entry)
  return entry
}

const completeToolCalls = (
  entries: Map<number, ToolAccumulator>,
  completedIndexes: Set<number>,
  modelCallId?: string,
): ModelEvent[] => {
  const events: ModelEvent[] = []
  for (const entry of [...entries.values()].sort((left, right) => left.index - right.index)) {
    if (completedIndexes.has(entry.index) || !entry.name) {
      continue
    }
    completedIndexes.add(entry.index)
    events.push({
      type: "model.tool_call.completed",
      toolCall: normalizeDeepSeekToolCall(entry),
      ...(modelCallId ? { modelCallId } : {}),
    })
  }
  return events
}

const normalizeDeepSeekToolCall = (entry: ToolAccumulator): NormalizedToolCall => ({
  toolCallId: entry.id ?? `deepseek_tool_${entry.index}_${shortHash(`${entry.name}:${entry.argumentsText}`)}`,
  toolName: entry.name as NormalizedToolCall["toolName"],
  input: parseToolArguments(entry.argumentsText),
  providerMetadata: {
    deepseek: {
      toolCall: {
        id: entry.id,
        index: entry.index,
        type: "function",
        function: {
          name: entry.name,
          arguments: entry.argumentsText,
        },
      },
      rawDeltas: entry.rawDeltas,
    },
  },
})

const parseToolArguments = (value: string): unknown => {
  if (!value.trim()) {
    return {}
  }
  try {
    return JSON.parse(value)
  } catch {
    return { value }
  }
}

const parseStructuredOutput = <TOutput>(content: string): TOutput => {
  try {
    return JSON.parse(content) as TOutput
  } catch {
    const extracted = content.match(/\{[\s\S]*\}/)?.[0] ?? content.match(/\[[\s\S]*\]/)?.[0]
    if (!extracted) {
      throw new SocratesError("deepseek_structured_output_invalid", "DeepSeek returned non-JSON structured output.", { recoverable: true })
    }
    return JSON.parse(extracted) as TOutput
  }
}

const responseMetadata = (value: DeepSeekChatCompletionChunk | DeepSeekChatCompletionResponse): Record<string, unknown> | undefined => {
  const metadata: Record<string, unknown> = {}
  if (value.id) {
    metadata.id = value.id
  }
  if (value.model) {
    metadata.model = value.model
  }
  if (value.created) {
    metadata.created = value.created
  }
  if (value.system_fingerprint) {
    metadata.systemFingerprint = value.system_fingerprint
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) {
    return
  }
  const body = await response.text().catch(() => "")
  throw new SocratesError("deepseek_http_error", `DeepSeek request failed with HTTP ${response.status}. ${errorMessageFromBody(body)}`, {
    details: { status: response.status, statusText: response.statusText, body: body.slice(0, 1000) },
    recoverable: response.status === 429 || response.status >= 500 || response.status === 400 || response.status === 401,
  })
}

const normalizeDeepSeekError = (error: unknown): Error => {
  if (error instanceof SocratesError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  return new SocratesError("deepseek_chat_failed", `DeepSeek chat request failed. ${message}`, { recoverable: true })
}

const errorMessageFromBody = (body: string): string => {
  if (!body.trim()) {
    return ""
  }
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    if (typeof parsed.error === "string") {
      return parsed.error
    }
    if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
      return parsed.error.message
    }
    if (typeof parsed.message === "string") {
      return parsed.message
    }
  } catch {
    return body.slice(0, 500)
  }
  return body.slice(0, 500)
}

const shortHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12)
