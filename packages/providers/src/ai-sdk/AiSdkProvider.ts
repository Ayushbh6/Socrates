import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import {
  jsonSchema,
  smoothStream,
  streamText,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type JSONSchema7,
  type ModelMessage as AiModelMessage,
} from "ai"
import type { ModelToolDefinition, NormalizedToolCall, ProviderMetadata } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import {
  countModelRequestLocally,
  shouldUseProviderExactCount,
  type TokenCountResult,
} from "../tokenCounting"
import { envProviderCredentialResolver } from "../credentials"
import type { ModelEvent, ModelProvider, ModelRequest, ModelUsage, ProviderCredentialResolver } from "../types"

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type ProviderOptions = Record<string, Record<string, JsonValue>>

export class AiSdkProvider implements ModelProvider {
  constructor(private readonly credentials: ProviderCredentialResolver = envProviderCredentialResolver) {}

  async countTokens(request: ModelRequest): Promise<TokenCountResult> {
    const providerOptions = this.createProviderOptions(request)
    const local = countModelRequestLocally(request, { providerOptions })
    if (
      request.providerId !== "google" ||
      !request.countTokens?.exactThresholds ||
      !shouldUseProviderExactCount(local.inputTokens, request.countTokens.exactThresholds)
    ) {
      return local
    }

    const apiKey = this.credentials.getApiKey("google")
    if (!apiKey) {
      return {
        ...local,
        providerExactAttempted: false,
        warnings: [...(local.warnings ?? []), "Google exact token counting skipped because no Gemini API key is configured."],
      }
    }

    const googleRequest = toGoogleCountTokensRequest(request)
    if (!googleRequest) {
      return {
        ...local,
        providerExactAttempted: false,
        warnings: [
          ...(local.warnings ?? []),
          "Google exact token counting skipped because this request contains tool definitions or structured tool parts; using local count with safety margin.",
        ],
      }
    }

    try {
      const exactTokens = await countGoogleTokens(request.modelId, apiKey, googleRequest)
      return {
        providerId: request.providerId,
        modelId: request.modelId,
        inputTokens: exactTokens,
        baseTokens: exactTokens,
        method: "provider_exact",
        safetyMarginPercent: 0,
        providerExactAttempted: true,
        ...(local.warnings?.length ? { warnings: local.warnings } : {}),
      }
    } catch (error) {
      return {
        ...local,
        providerExactAttempted: true,
        warnings: [
          ...(local.warnings ?? []),
          `Google exact token counting failed; using local count with safety margin. ${error instanceof Error ? error.message : String(error)}`,
        ],
      }
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const streamTimeout = createStreamTimeout(request)
    try {
      yield { type: "model.started", ...(request.modelCallId ? { modelCallId: request.modelCallId } : {}) }

      const result = streamText({
        model: this.createModel(request),
        system: request.system,
        messages: request.messages.map(toAiModelMessage),
        ...(request.tools && request.tools.length > 0 ? { tools: toAiTools(request.tools) as never } : {}),
        providerOptions: this.createProviderOptions(request),
        ...(request.providerId === "openrouter"
          ? { experimental_transform: smoothStream({ chunking: "word", delayInMs: 20 }) }
          : {}),
        abortSignal: streamTimeout.signal,
      })

      const streamingToolInputs = new Map<string, { toolName: string; text: string }>()
      const streamingReasoning = new Map<string, { text: string; providerMetadata?: ProviderMetadata }>()
      const flushReasoning = (id?: string): ModelEvent[] => {
        const entries = id === undefined ? [...streamingReasoning.entries()] : streamingReasoning.has(id) ? [[id, streamingReasoning.get(id)!] as const] : []
        const events: ModelEvent[] = []
        for (const [reasoningId, entry] of entries) {
          streamingReasoning.delete(reasoningId)
          if (entry.text.length === 0 && !entry.providerMetadata) {
            continue
          }
          events.push({
            type: "model.reasoning.completed",
            text: entry.text,
            ...(entry.providerMetadata ? { providerMetadata: entry.providerMetadata } : {}),
          })
        }
        return events
      }
      for await (const part of result.fullStream) {
        streamTimeout.refresh()
        if (part.type === "reasoning-start") {
          streamingReasoning.set(part.id, { text: "", ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}) })
        }
        if (part.type === "reasoning-delta") {
          const text = reasoningDeltaText(part)
          const entry = streamingReasoning.get(part.id) ?? { text: "", ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}) }
          entry.text += text
          if (part.providerMetadata) {
            entry.providerMetadata = mergeProviderMetadata(entry.providerMetadata, part.providerMetadata)
          }
          streamingReasoning.set(part.id, entry)
          if (text && request.runtimeConfig.thinkingEnabled) {
            yield { type: "model.reasoning.delta", text }
          }
        }
        if (part.type === "reasoning-end") {
          const entry = streamingReasoning.get(part.id) ?? { text: "" }
          if (part.providerMetadata) {
            entry.providerMetadata = mergeProviderMetadata(entry.providerMetadata, part.providerMetadata)
            streamingReasoning.set(part.id, entry)
          }
          for (const event of flushReasoning(part.id)) {
            yield event
          }
        }
        if (part.type === "text-delta" && part.text) {
          yield { type: "model.answer.delta", text: part.text }
        }
        if (part.type === "tool-input-start") {
          streamingToolInputs.set(part.id, { toolName: part.toolName, text: "" })
          yield { type: "model.tool_call.streaming", toolCallId: part.id, toolName: part.toolName, argsText: "" }
        }
        if (part.type === "tool-input-delta") {
          const entry = streamingToolInputs.get(part.id)
          if (entry) {
            entry.text += part.delta
            yield { type: "model.tool_call.streaming", toolCallId: part.id, toolName: entry.toolName, argsText: entry.text }
          }
        }
        if (part.type === "tool-call") {
          for (const event of flushReasoning()) {
            yield event
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: normalizeAiSdkToolCallPart(part),
          }
        }
        if (part.type === "finish-step") {
          yield { type: "model.usage", usage: mapUsage(part.usage) }
        }
        if (part.type === "finish") {
          for (const event of flushReasoning()) {
            yield event
          }
          yield {
            type: "model.completed",
            finishReason: part.finishReason,
            usage: mapUsage(part.totalUsage),
          }
        }
        if (part.type === "error") {
          yield { type: "model.failed", error: normalizeProviderError(part.error) }
        }
      }
    } catch (error) {
      yield { type: "model.failed", error: streamTimeout.timeoutError ?? normalizeProviderError(error) }
    } finally {
      streamTimeout.dispose()
    }
  }

  private createModel(request: ModelRequest): LanguageModel {
    switch (request.providerId) {
      case "openai": {
        const apiKey = this.credentials.getApiKey("openai")
        if (!apiKey) {
          throw missingProviderCredential("openai")
        }
        return createOpenAI({ apiKey }).responses(request.modelId)
      }
      case "google": {
        const apiKey = this.credentials.getApiKey("google")
        if (!apiKey) {
          throw missingProviderCredential("google")
        }
        return createGoogleGenerativeAI({ apiKey })(request.modelId)
      }
      case "openrouter": {
        const apiKey = this.credentials.getApiKey("openrouter")
        if (!apiKey) {
          throw missingProviderCredential("openrouter")
        }
        return (
          createOpenRouter({
            apiKey,
            appName: "Socrates",
            appUrl: "http://localhost",
          })
        ).chat(request.modelId)
      }
    }
  }

  private createProviderOptions(request: ModelRequest): ProviderOptions {
    switch (request.providerId) {
      case "openai":
        return createOpenAiProviderOptions(request)
      case "google":
        return createGoogleProviderOptions(request)
      case "openrouter":
        return createOpenRouterProviderOptions(request)
    }
  }
}

const missingProviderCredential = (providerId: ModelRequest["providerId"]): SocratesError =>
  new SocratesError("provider_credential_missing", `${providerId} API key is not configured.`, {
    details: { providerId },
    recoverable: true,
  })

type GoogleContent = {
  role: "user" | "model"
  parts: Array<{ text: string }>
}

type GoogleCountTokensRequest = {
  generateContentRequest: {
    model: string
    systemInstruction?: { role: "system"; parts: Array<{ text: string }> }
    contents: GoogleContent[]
  }
}

const countGoogleTokens = async (modelId: string, apiKey: string, request: GoogleCountTokensRequest): Promise<number> => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:countTokens?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  )

  if (!response.ok) {
    throw new SocratesError("google_count_tokens_failed", `Google countTokens failed with HTTP ${response.status}`, {
      details: { status: response.status, body: await response.text().catch(() => "") },
      recoverable: true,
    })
  }

  const json = (await response.json()) as { totalTokens?: unknown }
  if (typeof json.totalTokens !== "number" || !Number.isFinite(json.totalTokens)) {
    throw new SocratesError("google_count_tokens_invalid_response", "Google countTokens returned an invalid response.", {
      details: json,
      recoverable: true,
    })
  }
  return Math.ceil(json.totalTokens)
}

const toGoogleCountTokensRequest = (request: ModelRequest): GoogleCountTokensRequest | undefined => {
  if (request.tools && request.tools.length > 0) {
    return undefined
  }

  const contents: GoogleContent[] = []
  for (const message of request.messages) {
    const text = textContentForGeminiCount(message.content)
    if (text === undefined) {
      return undefined
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.role === "developer" ? `[developer]\n${text}` : text }],
    })
  }

  return {
    generateContentRequest: {
      model: `models/${request.modelId}`,
      ...(request.system ? { systemInstruction: { role: "system", parts: [{ text: request.system }] } } : {}),
      contents,
    },
  }
}

const textContentForGeminiCount = (content: ModelRequest["messages"][number]["content"]): string | undefined => {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return undefined
  }
  const textParts: string[] = []
  for (const part of content) {
    if (part.type !== "text") {
      return undefined
    }
    textParts.push(part.text)
  }
  return textParts.join("\n")
}

const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 120_000

const createStreamTimeout = (request: ModelRequest): {
  signal: AbortSignal
  timeoutError: SocratesError | undefined
  refresh: () => void
  dispose: () => void
} => {
  const timeoutMs = Number(process.env.SOCRATES_MODEL_STREAM_IDLE_TIMEOUT_MS ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS)
  const controller = new AbortController()
  let timeoutError: SocratesError | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const abortFromParent = () => controller.abort(request.abortSignal?.reason)
  const refresh = () => {
    if (timer) {
      clearTimeout(timer)
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || controller.signal.aborted) {
      return
    }
    timer = setTimeout(() => {
      timeoutError = new SocratesError("model_stream_idle_timeout", "Model provider stream timed out without new output.", {
        details: { providerId: request.providerId, modelId: request.modelId, idleTimeoutMs: timeoutMs },
        recoverable: true,
      })
      controller.abort(timeoutError)
    }, timeoutMs)
  }

  if (request.abortSignal?.aborted) {
    abortFromParent()
  } else {
    request.abortSignal?.addEventListener("abort", abortFromParent, { once: true })
    refresh()
  }

  return {
    signal: controller.signal,
    get timeoutError() {
      return timeoutError
    },
    refresh,
    dispose: () => {
      if (timer) {
        clearTimeout(timer)
      }
      request.abortSignal?.removeEventListener("abort", abortFromParent)
    },
  }
}

const toAiTools = (tools: NonNullable<ModelRequest["tools"]>) =>
  Object.fromEntries(
    tools.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: inputSchemaForAiTool(definition),
      }),
    ]),
  )

export const inputSchemaForAiTool = (definition: ModelToolDefinition) => {
  if (definition.name === "edit") {
    return jsonSchema(editToolJsonSchema, {
      validate: (value) => {
        const parsed = definition.inputSchema.safeParse(value)
        return parsed.success
          ? { success: true, value: parsed.data }
          : { success: false, error: new Error(parsed.error.message) }
      },
    })
  }
  if (definition.name !== "trace_retrieve") {
    return definition.inputSchema
  }
  return jsonSchema(traceRetrieveJsonSchema, {
    validate: (value) => {
      const parsed = definition.inputSchema.safeParse(value)
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: new Error(parsed.error.message) }
    },
  })
}

const editToolJsonSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Project-relative file path to create or edit.",
    },
    oldString: {
      type: "string",
      minLength: 1,
      description: "Exact existing text to replace. Use with newString for targeted edits to existing files.",
    },
    newString: {
      type: "string",
      description: "Replacement text for oldString. Use an empty string to delete the matched text.",
    },
    replaceAll: {
      type: "boolean",
      description: "Replace every occurrence of oldString. Omit unless every occurrence should change.",
    },
    content: {
      type: "string",
      description: "Whole-file content. Use for new files, or with overwrite=true for deliberate full rewrites.",
    },
    overwrite: {
      type: "boolean",
      description: "Set true only when intentionally replacing the full content of an existing file.",
    },
    dryRun: {
      type: "boolean",
      description: "Preview the edit without writing it.",
    },
  },
} as const

const traceRetrieveJsonSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation: { type: "string", enum: ["search", "inspect"], description: "Use search by default; use inspect for a returned resultNumber." },
    query: { type: "string", description: "Search text. Required unless operation is inspect." },
    resultNumber: { type: "integer", minimum: 1, maximum: 20, description: "Result number from the previous trace_retrieve search to inspect." },
    scope: { type: "string", enum: ["current_conversation", "recent_conversations", "project"] },
    conversationHint: { type: "string" },
    turnNo: { type: "integer", minimum: 1, maximum: 10_000 },
    role: { type: "string", enum: ["user", "assistant", "any"] },
    mode: { type: "string", enum: ["combined", "exact", "semantic", "audit"] },
    conversationLimit: { type: "integer", minimum: 1, maximum: 50 },
    include: { type: "array", items: { type: "string", enum: ["messages", "summaries", "tool_calls", "shell", "files", "errors", "decisions"] } },
    paths: { type: "array", items: { type: "string" }, maxItems: 20 },
    command: { type: "string" },
    handle: { type: "string", description: "Exact inspect handle returned by a previous trace_retrieve result." },
    conversationId: { type: "string", description: "Exact conversation id returned by a previous trace_retrieve result." },
    turnId: { type: "string", description: "Exact turn id returned by a previous trace_retrieve result." },
    messageId: { type: "string", description: "Exact message id returned by a previous trace_retrieve result." },
    toolCallId: { type: "string", description: "Exact tool-call id returned by a previous trace_retrieve result." },
    startTurnNo: { type: "integer", minimum: 1, maximum: 10_000 },
    turnLimit: { type: "integer", minimum: 1, maximum: 100 },
    limit: { type: "integer", minimum: 1, maximum: 20 },
    charLimit: { type: "integer", minimum: 1, maximum: 80_000 },
  },
} as const

export const normalizeAiSdkToolCallPart = (part: {
  toolCallId: string
  toolName: string
  input: unknown
  providerMetadata?: ProviderMetadata
}): NormalizedToolCall => ({
  toolCallId: part.toolCallId,
  toolName: part.toolName as NormalizedToolCall["toolName"],
  input: part.input,
  ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
})

const reasoningDeltaText = (part: { text?: unknown; delta?: unknown }): string => {
  if (typeof part.text === "string") {
    return part.text
  }
  if (typeof part.delta === "string") {
    return part.delta
  }
  return ""
}

const mergeProviderMetadata = (left: ProviderMetadata | undefined, right: ProviderMetadata): ProviderMetadata => {
  const merged: ProviderMetadata = { ...(left ?? {}) }
  for (const [provider, metadata] of Object.entries(right)) {
    merged[provider] = { ...(merged[provider] ?? {}), ...metadata }
  }
  return merged
}

export const toAiModelMessage = (message: ModelRequest["messages"][number]): AiModelMessage => {
  const role = message.role === "developer" ? "system" : message.role
  if (typeof message.content === "string") {
    return {
      role,
      content: message.content,
    } as AiModelMessage
  }

  if (role === "tool") {
    return {
      role: "tool",
      content: message.content
        .filter((part) => part.type === "tool-result")
        .map((part) => ({
          type: "tool-result" as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: toToolResultOutput(part.output),
        })),
    } as AiModelMessage
  }

  if (role === "assistant") {
    return {
      role: "assistant",
      content: message.content.map((part) => {
        if (part.type === "text") {
          return { type: "text" as const, text: part.text }
        }
        if (part.type === "reasoning") {
          return {
            type: "reasoning" as const,
            text: part.text,
            ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
          }
        }
        if (part.type === "image") {
          return { type: "image" as const, mediaType: part.mediaType, image: imageDataContent(part.data) }
        }
        if (part.type === "tool-call") {
          return {
            type: "tool-call" as const,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
          }
        }
        return {
          type: "tool-result" as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: toToolResultOutput(part.output),
        }
      }),
    } as AiModelMessage
  }

  return {
    role,
    content: message.content
      .filter((part) => part.type === "text" || part.type === "image")
      .map((part) =>
        part.type === "text"
          ? { type: "text" as const, text: part.text }
          : { type: "image" as const, mediaType: part.mediaType, image: imageDataContent(part.data) },
      ),
  } as AiModelMessage
}

const imageDataContent = (data: string): string => {
  const comma = data.indexOf(",")
  return data.startsWith("data:") && comma >= 0 ? data.slice(comma + 1) : data
}

const toToolResultOutput = (output: unknown) =>
  typeof output === "string"
    ? { type: "text" as const, value: output }
    : { type: "json" as const, value: output === undefined ? null : (output as never) }

export const mapUsage = (usage: LanguageModelUsage | undefined): ModelUsage => {
  if (!usage) {
    return {}
  }

  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.outputTokenDetails.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
    ...(usage.inputTokenDetails.cacheReadTokens === undefined
      ? {}
      : { cachedInputTokens: usage.inputTokenDetails.cacheReadTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.raw === undefined ? {} : { raw: usage.raw }),
  }
}

const createOpenAiProviderOptions = (request: ModelRequest): ProviderOptions => {
  const effort = request.runtimeConfig.thinkingEffort ?? "none"
  const openaiOptions: Record<string, JsonValue> = {
    reasoningEffort: effort,
  }

  if (effort !== "none") {
    openaiOptions.reasoningSummary = "auto"
  }

  return { openai: openaiOptions }
}

const createGoogleProviderOptions = (request: ModelRequest): ProviderOptions => {
  const effort = request.runtimeConfig.thinkingEffort
  if (!request.runtimeConfig.thinkingEnabled || !effort || effort === "none" || effort === "xhigh") {
    return {}
  }

  return {
    google: {
      thinkingConfig: {
        thinkingLevel: effort,
        includeThoughts: true,
      },
    },
  }
}

export const createOpenRouterProviderOptions = (request: ModelRequest): ProviderOptions => ({
  openrouter: {
    usage: { include: true },
    reasoning: request.runtimeConfig.thinkingEnabled
      ? { enabled: true, exclude: false }
      : { enabled: false, effort: "none", exclude: true },
  },
})

const normalizeProviderError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error
  }

  return new SocratesError("model_provider_error", "Model provider failed", {
    details: { error },
    recoverable: true,
  })
}
