import { createHash } from "node:crypto"
import { zodToJsonSchema } from "zod-to-json-schema"
import type { ModelOption, ModelToolDefinition, NormalizedToolCall } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { makeOllamaModelOption } from "../modelCatalog/modelCatalog"
import { countModelRequestLocally, type TokenCountResult } from "../tokenCounting"
import {
  type ModelEvent,
  type ModelMessageContent,
  type ModelMessagePart,
  type ModelProvider,
  type ModelRequest,
  type ModelUsage,
  type StructuredModelRequest,
  type StructuredModelResult,
} from "../types"
import { normalizeProviderUsage } from "../usage"

export const DEFAULT_OLLAMA_CHAT_BASE_URL = "http://127.0.0.1:11434"

type OllamaModelSummary = {
  name?: string
  model?: string
  modified_at?: string
  size?: number
  details?: OllamaModelDetails
  capabilities?: string[]
}

type OllamaModelDetails = {
  family?: string
  families?: string[]
  parameter_size?: string
  quantization_level?: string
  context_length?: number
}

type OllamaTagsResponse = {
  models?: OllamaModelSummary[]
}

type OllamaShowResponse = {
  details?: OllamaModelDetails
  capabilities?: string[]
  model_info?: Record<string, unknown>
  parameters?: string
}

type OllamaToolCall = {
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: unknown
  }
}

type OllamaChatMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  images?: string[]
  tool_calls?: OllamaToolCall[]
}

type OllamaChatChunk = {
  model?: string
  created_at?: string
  message?: {
    role?: string
    content?: string
    thinking?: string
    tool_calls?: OllamaToolCall[]
  }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  total_duration?: number
  load_duration?: number
  prompt_eval_duration?: number
  eval_duration?: number
}

type ListOllamaChatModelsResult = {
  reachable: boolean
  baseUrl: string
  models: ModelOption[]
  warning?: string
  raw?: unknown
}

export class OllamaChatProvider implements ModelProvider {
  constructor(private readonly options: { baseUrl?: string } = {}) {}

  async countTokens(request: ModelRequest): Promise<TokenCountResult> {
    return countModelRequestLocally(request)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    yield { type: "model.started", ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}) }
    try {
      const baseUrl = normalizeOllamaBaseUrl(this.options.baseUrl)
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.modelId,
          messages: toOllamaMessages(request),
          stream: true,
          think: Boolean(request.runtimeConfig.thinkingEnabled),
          ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(toOllamaTool) } : {}),
        }),
        ...(request.abortSignal ? { signal: request.abortSignal } : {}),
      })
      await assertOk(response)

      let reasoningText = ""
      let latestUsage: ModelUsage | undefined
      let toolCallIndex = 0
      for await (const chunk of readNdjson(response)) {
        const parsed = chunk as OllamaChatChunk
        const thinking = parsed.message?.thinking
        if (thinking) {
          reasoningText += thinking
          if (request.runtimeConfig.thinkingEnabled) {
            yield {
              type: "model.reasoning.delta",
              text: thinking,
              ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}),
            }
          }
        }
        const text = parsed.message?.content
        if (text) {
          yield {
            type: "model.answer.delta",
            text,
            ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}),
          }
        }
        for (const toolCall of parsed.message?.tool_calls ?? []) {
          const normalized = normalizeOllamaToolCall(toolCall, toolCallIndex)
          toolCallIndex += 1
          if (normalized) {
            yield {
              type: "model.tool_call.completed",
              toolCall: normalized,
              ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}),
            }
          }
        }
        const usage = usageFromOllamaChunk(request.modelId, parsed)
        if (usage) {
          latestUsage = usage
        }
      }
      if (reasoningText) {
        yield {
          type: "model.reasoning.completed",
          text: reasoningText,
          providerMetadata: { ollama: { thinking: true } },
          ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}),
        }
      }
      if (latestUsage) {
        yield { type: "model.usage", usage: latestUsage, ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}) }
      }
      yield {
        type: "model.completed",
        ...(latestUsage ? { usage: latestUsage } : {}),
        ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}),
      }
    } catch (error) {
      const normalized = normalizeOllamaError(error)
      yield { type: "model.failed", error: normalized, ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}) }
      throw normalized
    }
  }

  async generateStructured<TOutput>(request: StructuredModelRequest<TOutput>): Promise<StructuredModelResult<TOutput>> {
    const baseUrl = normalizeOllamaBaseUrl(this.options.baseUrl)
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: request.modelId,
        messages: toOllamaMessages(request),
        stream: false,
        think: Boolean(request.runtimeConfig.thinkingEnabled),
        format: schemaToJsonSchema(request.schema),
      }),
      ...(request.abortSignal ? { signal: request.abortSignal } : {}),
    })
    await assertOk(response)
    const raw = (await response.json()) as OllamaChatChunk
    const content = raw.message?.content ?? ""
    const usage = usageFromOllamaChunk(request.modelId, raw)
    return {
      output: parseStructuredOutput<TOutput>(content),
      ...(usage ? { usage } : {}),
      raw,
    }
  }
}

export const listOllamaChatModels = async (input: { baseUrl?: string; abortSignal?: AbortSignal } = {}): Promise<ListOllamaChatModelsResult> => {
  const baseUrl = normalizeOllamaBaseUrl(input.baseUrl)
  try {
    const tags = (await fetchJson(`${baseUrl}/api/tags`, input.abortSignal ? { signal: input.abortSignal } : {})) as OllamaTagsResponse
    const summaries = tags.models ?? []
    const options = await Promise.all(
      summaries.map(async (summary) => {
        const modelId = summary.model ?? summary.name
        if (!modelId) {
          return undefined
        }
        let show: OllamaShowResponse | undefined
        try {
          show = (await fetchJson(`${baseUrl}/api/show`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: modelId }),
            ...(input.abortSignal ? { signal: input.abortSignal } : {}),
          })) as OllamaShowResponse
        } catch {
          show = undefined
        }
        return toOllamaModelOption(modelId, summary, show)
      }),
    )
    return {
      reachable: true,
      baseUrl,
      models: options.filter((option): option is ModelOption => Boolean(option)),
      raw: tags,
    }
  } catch (error) {
    return {
      reachable: false,
      baseUrl,
      models: [],
      warning: error instanceof Error ? error.message : String(error),
    }
  }
}

export const normalizeOllamaBaseUrl = (baseUrl: string | undefined): string => {
  const normalized = (baseUrl ?? process.env.OLLAMA_BASE_URL ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_CHAT_BASE_URL).trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? normalized : `http://${normalized}`
  return withScheme.replace(/\/+$/, "")
}

const toOllamaModelOption = (modelId: string, summary: OllamaModelSummary, show: OllamaShowResponse | undefined): ModelOption | undefined => {
  const capabilities = uniqueStrings([...(summary.capabilities ?? []), ...(show?.capabilities ?? [])]).map((capability) => capability.toLowerCase())
  const hasCompletion = capabilities.includes("completion")
  const hasVision = capabilities.includes("vision")
  const hasEmbedding = capabilities.includes("embedding")
  if (hasEmbedding && !hasCompletion && !hasVision) {
    return undefined
  }
  if (capabilities.length === 0 && looksLikeEmbeddingModel(modelId)) {
    return undefined
  }
  return makeOllamaModelOption({
    modelId,
    contextWindowTokens: contextWindowTokens(summary, show) ?? 8192,
    vision: hasVision,
  })
}

const contextWindowTokens = (summary: OllamaModelSummary, show: OllamaShowResponse | undefined): number | undefined =>
  numericValue(summary.details?.context_length) ??
  numericValue(show?.details?.context_length) ??
  modelInfoNumber(show?.model_info ?? {}, "context_length") ??
  parametersNumber(show?.parameters, "num_ctx")

const toOllamaMessages = (request: Pick<ModelRequest, "system" | "messages">): OllamaChatMessage[] => {
  const messages: OllamaChatMessage[] = request.system.trim() ? [{ role: "system", content: request.system }] : []
  for (const message of request.messages) {
    const converted = toOllamaMessage(message.role, message.content)
    if (converted) {
      messages.push(converted)
    }
  }
  return messages
}

const toOllamaMessage = (role: ModelRequest["messages"][number]["role"], content: ModelMessageContent): OllamaChatMessage | undefined => {
  if (role === "developer") {
    return {
      role: "user",
      content: developerContextText(content),
    }
  }
  if (role === "tool") {
    return {
      role: "tool",
      content: toolResultText(content),
    }
  }
  if (typeof content === "string") {
    return { role: role === "system" ? "system" : role === "assistant" ? "assistant" : "user", content }
  }

  const text = textFromParts(content)
  const images = content.filter((part) => part.type === "image").map((part) => imageDataContent(part.data))
  const toolCalls =
    role === "assistant"
      ? content
          .filter((part) => part.type === "tool-call")
          .map((part) => ({
            id: part.toolCallId,
            type: "function",
            function: { name: part.toolName, arguments: part.input },
          }))
      : []
  return {
    role: role === "system" ? "system" : role === "assistant" ? "assistant" : "user",
    content: text,
    ...(images.length > 0 ? { images } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

const developerContextText = (content: ModelMessageContent): string =>
  [
    "<runtime_socrates_developer_context>",
    "The following is Socrates runtime guidance, not user-authored content.",
    typeof content === "string" ? content : textFromParts(content),
    "</runtime_socrates_developer_context>",
  ].join("\n")

const textFromParts = (parts: ModelMessagePart[]): string =>
  parts
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return part.text
      }
      if (part.type === "tool-result") {
        return JSON.stringify({ toolName: part.toolName, toolCallId: part.toolCallId, output: part.output })
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")

const toolResultText = (content: ModelMessageContent): string => {
  if (typeof content === "string") {
    return content
  }
  return content
    .filter((part) => part.type === "tool-result")
    .map((part) => JSON.stringify({ toolName: part.toolName, toolCallId: part.toolCallId, output: part.output ?? null }))
    .join("\n")
}

const imageDataContent = (data: string): string => {
  const comma = data.indexOf(",")
  return data.startsWith("data:") && comma >= 0 ? data.slice(comma + 1) : data
}

const toOllamaTool = (definition: ModelToolDefinition) => ({
  type: "function",
  function: {
    name: definition.name,
    description: definition.description,
    parameters: schemaToJsonSchema(definition.inputSchema),
  },
})

const schemaToJsonSchema = (schema: unknown): unknown => {
  if (schema && typeof schema === "object" && "_def" in schema) {
    return zodToJsonSchema(schema as never, { $refStrategy: "none" })
  }
  return schema
}

const normalizeOllamaToolCall = (toolCall: OllamaToolCall, index: number): NormalizedToolCall | undefined => {
  const toolName = toolCall.function?.name
  if (!toolName) {
    return undefined
  }
  const input = parseToolArguments(toolCall.function?.arguments)
  return {
    toolCallId: toolCall.id ?? `ollama_tool_${index}_${shortHash(`${toolName}:${JSON.stringify(input)}`)}`,
    toolName: toolName as NormalizedToolCall["toolName"],
    input,
    providerMetadata: { ollama: { toolCall } },
  }
}

const parseToolArguments = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value ?? {}
  }
  try {
    return JSON.parse(value)
  } catch {
    return { value }
  }
}

const usageFromOllamaChunk = (modelId: string, chunk: OllamaChatChunk): ModelUsage | undefined => {
  const inputTokens = numericValue(chunk.prompt_eval_count)
  const outputTokens = numericValue(chunk.eval_count)
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined
  }
  return normalizeProviderUsage({
    providerId: "ollama",
    modelId,
    usage: {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      raw: chunk,
    },
  })
}

const parseStructuredOutput = <TOutput>(content: string): TOutput => {
  try {
    return JSON.parse(content) as TOutput
  } catch {
    const extracted = content.match(/\{[\s\S]*\}/)?.[0] ?? content.match(/\[[\s\S]*\]/)?.[0]
    if (!extracted) {
      throw new SocratesError("ollama_structured_output_invalid", "Ollama returned non-JSON structured output.", { recoverable: true })
    }
    return JSON.parse(extracted) as TOutput
  }
}

const readNdjson = async function* (response: Response): AsyncIterable<unknown> {
  const reader = response.body?.getReader()
  if (!reader) {
    yield response.json()
    return
  }
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let lineBreak = buffer.indexOf("\n")
      while (lineBreak >= 0) {
        const line = buffer.slice(0, lineBreak).trim()
        buffer = buffer.slice(lineBreak + 1)
        if (line) {
          yield JSON.parse(line)
        }
        lineBreak = buffer.indexOf("\n")
      }
    }
    buffer += decoder.decode()
    const trailing = buffer.trim()
    if (trailing) {
      yield JSON.parse(trailing)
    }
  } finally {
    reader.releaseLock()
  }
}

const fetchJson = async (url: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await fetch(url, init)
  await assertOk(response)
  return response.json() as Promise<unknown>
}

const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) {
    return
  }
  let body = ""
  try {
    body = await response.text()
  } catch {
    body = ""
  }
  throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`)
}

const normalizeOllamaError = (error: unknown): Error => {
  if (error instanceof SocratesError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  return new SocratesError("ollama_chat_failed", `Ollama chat request failed. ${message}`, { recoverable: true })
}

const looksLikeEmbeddingModel = (modelId: string): boolean => /\b(embed|embedding|minilm|bge|gte|e5|mxbai|nomic)\b/i.test(modelId.replaceAll("-", " "))

const uniqueStrings = (values: Array<string | undefined>): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))]

const numericValue = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined)

const modelInfoNumber = (modelInfo: Record<string, unknown>, suffix: string): number | undefined => {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(`.${suffix}`) || key === suffix) {
      const numeric = numericValue(value)
      if (numeric) {
        return numeric
      }
    }
  }
  return undefined
}

const parametersNumber = (parameters: string | undefined, key: string): number | undefined => {
  if (!parameters) {
    return undefined
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = parameters.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s+(\\d+)`))
  return match ? numericValue(Number(match[1])) : undefined
}

const shortHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12)
