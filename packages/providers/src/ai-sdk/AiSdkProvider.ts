import { createHash } from "node:crypto"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import {
  generateText,
  jsonSchema,
  Output,
  smoothStream,
  streamObject,
  streamText,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage as AiModelMessage,
} from "ai"
import type { ModelToolDefinition, NormalizedToolCall, ProviderAuthMode, ProviderMetadata } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import {
  countModelRequestLocally,
  shouldUseProviderExactCount,
  type TokenCountResult,
} from "../tokenCounting"
import { envProviderCredentialResolver } from "../credentials"
import { openRouterProviderRoutingForModel } from "../openRouterRouting"
import { createStreamTimeout } from "../streamTimeout"
import { editToolJsonSchema, traceRetrieveJsonSchema, validateStrictTraceRetrieveInput } from "../toolJsonSchemas"
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ModelUsage,
  ProviderCredentialResolver,
  ProviderResolvedCredential,
  StructuredModelRequest,
  StructuredModelResult,
} from "../types"
import { normalizeProviderUsage } from "../usage"

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type ProviderOptions = Record<string, Record<string, JsonValue>>
type StreamObjectOptions = Parameters<typeof streamObject>[0]

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
        messages: toAiModelMessages(request.messages, request.providerId),
        ...(request.tools && request.tools.length > 0 ? { tools: toAiTools(request.tools) as never } : {}),
        providerOptions: this.createProviderOptions(request),
        ...(request.providerId === "openrouter"
          ? { experimental_transform: smoothStream({ chunking: "word", delayInMs: 20 }) }
          : {}),
        abortSignal: streamTimeout.signal,
      })

      const streamingToolInputs = new Map<string, { toolName: string; text: string }>()
      const streamingReasoning = new Map<string, { text: string; providerMetadata?: ProviderMetadata }>()
      let latestUsageProviderMetadata: ProviderMetadata | undefined
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
        const providerPart = part as { type: string; providerMetadata?: ProviderMetadata }
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
        if (providerPart.type === "response-metadata") {
          yield { type: "model.response.metadata", response: responseMetadataForStorage(part) }
        }
        if (part.type === "finish-step") {
          if (part.providerMetadata) {
            latestUsageProviderMetadata = mergeProviderMetadata(latestUsageProviderMetadata, part.providerMetadata)
          }
          yield {
            type: "model.usage",
            usage: mapUsage(request.providerId, request.modelId, part.usage, part.providerMetadata, request.runtimeConfig.authMode),
          }
        }
        if (part.type === "finish") {
          for (const event of flushReasoning()) {
            yield event
          }
          if (providerPart.providerMetadata) {
            latestUsageProviderMetadata = mergeProviderMetadata(latestUsageProviderMetadata, providerPart.providerMetadata)
          }
          yield {
            type: "model.completed",
            finishReason: part.finishReason,
            usage: mapUsage(
              request.providerId,
              request.modelId,
              part.totalUsage,
              providerPart.providerMetadata ?? latestUsageProviderMetadata,
              request.runtimeConfig.authMode,
            ),
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

  async generateStructured<TOutput>(request: StructuredModelRequest<TOutput>): Promise<StructuredModelResult<TOutput>> {
    const streamTimeout = createStreamTimeout(request)
    try {
      if ((request.runtimeConfig.authMode ?? "api_key") === "chatgpt_subscription") {
        const result = streamObject({
          model: this.createModel(request),
          system: request.system,
          messages: toAiModelMessages(request.messages, request.providerId),
          schema: request.schema,
          providerOptions: this.createProviderOptions(request),
          abortSignal: streamTimeout.signal,
        } as StreamObjectOptions)
        let usageValue: LanguageModelUsage | undefined
        let providerMetadata: ProviderMetadata | undefined
        let response: unknown
        for await (const part of result.fullStream) {
          if (part.type === "error") {
            throw normalizeProviderError(part.error)
          }
          if (part.type === "finish") {
            usageValue = part.usage
            providerMetadata = part.providerMetadata
            response = part.response
          }
        }
        const [output, warnings] = await Promise.all([result.object, result.warnings])
        const usage = mapUsage(request.providerId, request.modelId, usageValue, providerMetadata, request.runtimeConfig.authMode)
        return {
          output: output as TOutput,
          ...(Object.keys(usage).length > 0 ? { usage } : {}),
          raw: { response, warnings },
        }
      }

      const result = await generateText({
        model: this.createModel(request),
        system: request.system,
        messages: toAiModelMessages(request.messages, request.providerId),
        output: Output.object({ schema: request.schema as never }),
        providerOptions: this.createProviderOptions(request),
        abortSignal: streamTimeout.signal,
      })
      const usage = mapUsage(
        request.providerId,
        request.modelId,
        generationUsage(result),
        generationProviderMetadata(result),
        request.runtimeConfig.authMode,
      )
      return {
        output: result.output as TOutput,
        ...(Object.keys(usage).length > 0 ? { usage } : {}),
        raw: { response: result.response, warnings: result.warnings },
      }
    } catch (error) {
      throw streamTimeout.timeoutError ?? normalizeProviderError(error)
    } finally {
      streamTimeout.dispose()
    }
  }

  private createModel(request: ModelRequest): LanguageModel {
    switch (request.providerId) {
      case "openai": {
        const credential = this.resolveProviderAuth(request)
        if (!credential) {
          throw missingProviderCredential("openai")
        }
        return createOpenAI(
          credential.authMode === "chatgpt_subscription"
            ? { apiKey: credential.apiKey, fetch: credential.fetch }
            : { apiKey: credential.apiKey },
        ).responses(request.modelId)
      }
      case "google": {
        const credential = this.resolveProviderAuth(request)
        if (!credential || credential.authMode !== "api_key") {
          throw missingProviderCredential("google")
        }
        return createGoogleGenerativeAI({ apiKey: credential.apiKey })(request.modelId)
      }
      case "openrouter": {
        const credential = this.resolveProviderAuth(request)
        if (!credential || credential.authMode !== "api_key") {
          throw missingProviderCredential("openrouter")
        }
        return (
          createOpenRouter({
            apiKey: credential.apiKey,
            appName: "Socrates",
            appUrl: "http://localhost",
          })
        ).chat(request.modelId)
      }
      case "deepseek":
        throw new SocratesError("provider_not_supported_by_ai_sdk", "DeepSeek is served by the native DeepSeek provider, not the AI SDK provider.", {
          details: { providerId: request.providerId },
          recoverable: true,
        })
      case "ollama":
        throw new SocratesError("provider_not_supported_by_ai_sdk", "Ollama is served by the native Ollama provider, not the AI SDK provider.", {
          details: { providerId: request.providerId },
          recoverable: true,
        })
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
      case "deepseek":
        throw new SocratesError("provider_not_supported_by_ai_sdk", "DeepSeek is served by the native DeepSeek provider, not the AI SDK provider.", {
          details: { providerId: request.providerId },
          recoverable: true,
        })
      case "ollama":
        throw new SocratesError("provider_not_supported_by_ai_sdk", "Ollama is served by the native Ollama provider, not the AI SDK provider.", {
          details: { providerId: request.providerId },
          recoverable: true,
        })
    }
  }

  private resolveProviderAuth(request: ModelRequest): ProviderResolvedCredential | undefined {
    const authMode = request.runtimeConfig.authMode ?? "api_key"
    if (this.credentials.resolveAuth) {
      return this.credentials.resolveAuth(request.providerId, authMode)
    }
    if (authMode !== "api_key") {
      return undefined
    }
    const apiKey = this.credentials.getApiKey(request.providerId)
    return apiKey ? { authMode: "api_key", apiKey } : undefined
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
      if (!parsed.success) {
        return { success: false, error: new Error(parsed.error.message) }
      }
      const strictError = validateStrictTraceRetrieveInput(parsed.data)
      return strictError
        ? { success: false, error: new Error(strictError) }
        : { success: true, value: parsed.data }
    },
  })
}

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

export const toAiModelMessage = (message: ModelRequest["messages"][number], providerId?: ModelRequest["providerId"]): AiModelMessage => {
  const role = aiSdkRoleForMessage(message.role, providerId)
  if (typeof message.content === "string") {
    return {
      role,
      content: textContentForProvider(message.content, message.role, providerId),
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
    content: contentPartsForProvider(message.content, message.role, providerId)
      .filter((part) => part.type === "text" || part.type === "image")
      .map((part) =>
        part.type === "text"
          ? { type: "text" as const, text: part.text }
          : { type: "image" as const, mediaType: part.mediaType, image: imageDataContent(part.data) },
      ),
  } as AiModelMessage
}

const toAiModelMessages = (messages: ModelRequest["messages"], providerId?: ModelRequest["providerId"]): AiModelMessage[] =>
  providerId === "openrouter" || providerId === "openai"
    ? normalizeInlineDeveloperMessages(messages).map((message) => toAiModelMessage(message, providerId))
    : messages.map((message) => toAiModelMessage(message, providerId))

const normalizeInlineDeveloperMessages = (messages: ModelRequest["messages"]): ModelRequest["messages"] => {
  const normalized: ModelRequest["messages"] = []
  for (const message of messages) {
    if (message.role !== "developer") {
      normalized.push(message)
      continue
    }

    const developerText = developerContextText(message.content)
    const previous = normalized[normalized.length - 1]
    if (previous?.role === "user") {
      normalized[normalized.length - 1] = {
        ...previous,
        content: appendDeveloperContextToUserContent(previous.content, developerText),
      }
      continue
    }

    normalized.push({
      role: "user",
      content: developerText,
    })
  }
  return normalized
}

const developerContextText = (content: ModelRequest["messages"][number]["content"]): string =>
  [
    "<runtime_socrates_developer_context>",
    "The following is Socrates runtime guidance, not user-authored content.",
    typeof content === "string" ? content : textFromContentParts(content),
    "</runtime_socrates_developer_context>",
  ].join("\n")

const appendDeveloperContextToUserContent = (
  content: ModelRequest["messages"][number]["content"],
  developerText: string,
): ModelRequest["messages"][number]["content"] =>
  typeof content === "string" ? `${content}\n\n${developerText}` : [...content, { type: "text", text: developerText }]

const textFromContentParts = (content: Extract<ModelRequest["messages"][number]["content"], unknown[]>): string =>
  content
    .map((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part ? String(part.text) : ""))
    .filter(Boolean)
    .join("\n")

const aiSdkRoleForMessage = (
  role: ModelRequest["messages"][number]["role"],
  providerId?: ModelRequest["providerId"],
): AiModelMessage["role"] => {
  if (role !== "developer") {
    return role as AiModelMessage["role"]
  }
  // Late Socrates runtime notes are per-turn guidance, not root system prompts.
  // Passing them as AI SDK system messages triggers warnings and can break
  // provider-specific continuation rules, so render them as wrapped user text.
  return "user"
}

const textContentForProvider = (
  text: string,
  role: ModelRequest["messages"][number]["role"],
  providerId?: ModelRequest["providerId"],
): string => (role === "developer" ? `[developer]\n${text}` : text)

const contentPartsForProvider = (
  content: Extract<ModelRequest["messages"][number]["content"], unknown[]>,
  role: ModelRequest["messages"][number]["role"],
  providerId?: ModelRequest["providerId"],
): Extract<ModelRequest["messages"][number]["content"], unknown[]> =>
  role === "developer" ? [{ type: "text", text: "[developer]" }, ...content] : content

const imageDataContent = (data: string): string => {
  const comma = data.indexOf(",")
  return data.startsWith("data:") && comma >= 0 ? data.slice(comma + 1) : data
}

const toToolResultOutput = (output: unknown) =>
  typeof output === "string"
    ? { type: "text" as const, value: output }
    : { type: "json" as const, value: output === undefined ? null : (output as never) }

const generationUsage = (result: unknown): LanguageModelUsage | undefined => {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {}
  return (record.totalUsage ?? record.usage) as LanguageModelUsage | undefined
}

const generationProviderMetadata = (result: unknown): ProviderMetadata | undefined => {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {}
  return (record.providerMetadata ?? record.providerOptions) as ProviderMetadata | undefined
}

export const mapUsage = (
  providerId: ModelRequest["providerId"],
  modelId: string,
  usage: LanguageModelUsage | undefined,
  providerMetadata?: ProviderMetadata,
  authMode?: ProviderAuthMode,
): ModelUsage => {
  if (!usage) {
    return providerMetadata ? { providerMetadata } : {}
  }
  const inputTokenDetails = usage.inputTokenDetails ?? {}
  const outputTokenDetails = usage.outputTokenDetails ?? {}

  return normalizeProviderUsage({
    providerId,
    ...(authMode === undefined ? {} : { authMode }),
    modelId,
    usage: {
      ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
      ...(outputTokenDetails.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: outputTokenDetails.reasoningTokens }),
      ...(inputTokenDetails.cacheReadTokens === undefined
        ? {}
        : { cachedInputTokens: inputTokenDetails.cacheReadTokens }),
      ...(inputTokenDetails.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: inputTokenDetails.cacheWriteTokens }),
      ...(inputTokenDetails.noCacheTokens === undefined
        ? {}
        : { uncachedInputTokens: inputTokenDetails.noCacheTokens }),
      ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
      ...(usage.raw === undefined ? {} : { raw: usage.raw }),
      ...(providerMetadata ? { providerMetadata } : {}),
    },
  })
}

const createOpenAiProviderOptions = (request: ModelRequest): ProviderOptions => {
  const effort = normalizeOpenAiReasoningEffort(request.modelId, request.runtimeConfig.thinkingEffort ?? "none")
  const stableCacheKey = providerSafePromptCacheKey(request)
  const isChatGptSubscription = (request.runtimeConfig.authMode ?? "api_key") === "chatgpt_subscription"
  const openaiOptions: Record<string, JsonValue> = {
    reasoningEffort: effort,
    ...(stableCacheKey ? { promptCacheKey: stableCacheKey } : {}),
    ...(supportsOpenAiExtendedPromptCacheRetention(request.modelId) && !isChatGptSubscription ? { promptCacheRetention: "24h" } : {}),
    ...(isChatGptSubscription ? { store: false } : {}),
  }

  if (effort !== "none") {
    openaiOptions.reasoningSummary = "auto"
  }

  return { openai: openaiOptions }
}

const normalizeOpenAiReasoningEffort = (modelId: string, effort: string): string => {
  const normalizedModelId = modelId.trim().toLowerCase()
  if (/^gpt-5(?:-|$)/.test(normalizedModelId)) {
    if (effort === "none") {
      return "minimal"
    }
    if (effort === "xhigh" && !normalizedModelId.startsWith("gpt-5.6")) {
      return "high"
    }
  }
  if (normalizedModelId.startsWith("gpt-5.4") && effort === "minimal") {
    return "low"
  }
  return effort
}

const supportsOpenAiExtendedPromptCacheRetention = (modelId: string): boolean => {
  const normalized = modelId.trim().toLowerCase()
  return normalized.startsWith("gpt-5") || normalized.startsWith("gpt-4.1")
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

export const createOpenRouterProviderOptions = (request: ModelRequest): ProviderOptions => {
  const providerRouting = openRouterProviderRoutingForModel(request.modelId, {
    ...(request.providerRouting?.preferredOpenRouterProvider
      ? { preferredProvider: request.providerRouting.preferredOpenRouterProvider }
      : {}),
    requiresTools: (request.tools?.length ?? 0) > 0,
  })
  const shouldSendProviderRouting = providerRouting && Object.keys(providerRouting).length > 0
  const stableSessionId = providerSafePromptCacheKey(request)
  const reasoning = request.providerRouting?.omitReasoning
    ? undefined
    : request.runtimeConfig.thinkingEnabled
      ? { enabled: true, exclude: false }
      : { enabled: false, effort: "none", exclude: true }
  return {
    openrouter: {
      usage: { include: true },
      ...(stableSessionId ? { session_id: stableSessionId } : {}),
      ...(stableSessionId ? { prompt_cache_key: stableSessionId } : {}),
      ...(shouldSendProviderRouting ? { provider: providerRouting } : {}),
      ...(reasoning ? { reasoning } : {}),
    },
  }
}

const stablePromptCacheKey = (request: ModelRequest): string | undefined => request.cacheKey ?? request.sessionId

const providerSafePromptCacheKey = (request: ModelRequest): string | undefined => {
  const key = stablePromptCacheKey(request)
  if (!key || key.length <= 64) {
    return key
  }
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 48)
  return `socrates_${digest}`
}

const responseMetadataForStorage = (part: unknown): unknown => {
  if (!part || typeof part !== "object") {
    return part
  }
  const { type: _type, ...metadata } = part as Record<string, unknown>
  return metadata
}

const normalizeProviderError = (error: unknown): Error => {
  if (error instanceof SocratesError) {
    if (error.message.trim()) {
      return error
    }
    return new SocratesError(error.code, "Model provider failed without an error message.", {
      details: error.details,
      recoverable: error.recoverable,
    })
  }

  if (error instanceof Error) {
    return new SocratesError("model_provider_error", providerErrorMessage(error), {
      details: providerErrorDetails(error),
      recoverable: true,
    })
  }

  return new SocratesError("model_provider_error", "Model provider failed", {
    details: { error },
    recoverable: true,
  })
}

const providerErrorMessage = (error: Error): string => {
  const directMessage = error.message.trim()
  if (directMessage) {
    return directMessage
  }

  const bodyMessage = providerErrorBodyMessage(error)
  if (bodyMessage) {
    return `Model provider failed: ${bodyMessage}`
  }

  return "Model provider failed without an error message."
}

const providerErrorBodyMessage = (error: Error): string | undefined => {
  const responseBody = (error as { responseBody?: unknown }).responseBody
  if (typeof responseBody !== "string" || !responseBody.trim()) {
    return undefined
  }
  try {
    const parsed = JSON.parse(responseBody) as { detail?: unknown; error?: { message?: unknown } | string; message?: unknown }
    const nestedError = parsed.error
    const value =
      typeof parsed.detail === "string"
        ? parsed.detail
        : typeof parsed.message === "string"
          ? parsed.message
          : typeof nestedError === "string"
            ? nestedError
            : nestedError && typeof nestedError === "object" && typeof nestedError.message === "string"
              ? nestedError.message
              : undefined
    return value?.trim() || undefined
  } catch {
    return responseBody.trim()
  }
}

const providerErrorDetails = (error: Error): Record<string, unknown> => {
  const details: Record<string, unknown> = {
    name: error.name,
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode
  const url = (error as { url?: unknown }).url
  const responseBody = (error as { responseBody?: unknown }).responseBody
  if (typeof statusCode === "number") {
    details.statusCode = statusCode
  }
  if (typeof url === "string") {
    details.url = url
  }
  if (typeof responseBody === "string" && responseBody.trim()) {
    details.responseBody = responseBody
  }
  return details
}
