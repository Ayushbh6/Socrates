import { google, createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI, openai } from "@ai-sdk/openai"
import { createOpenRouter, openrouter } from "@openrouter/ai-sdk-provider"
import { smoothStream, streamText, tool, type LanguageModel, type LanguageModelUsage, type ModelMessage as AiModelMessage } from "ai"
import type { NormalizedToolCall, ProviderMetadata } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { ModelEvent, ModelProvider, ModelRequest, ModelUsage } from "../types"

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type ProviderOptions = Record<string, Record<string, JsonValue>>

export class AiSdkProvider implements ModelProvider {
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

      for await (const part of result.fullStream) {
        streamTimeout.refresh()
        if (part.type === "reasoning-delta" && part.text) {
          yield { type: "model.reasoning.delta", text: part.text }
        }
        if (part.type === "text-delta" && part.text) {
          yield { type: "model.answer.delta", text: part.text }
        }
        if (part.type === "tool-call") {
          yield {
            type: "model.tool_call.completed",
            toolCall: normalizeAiSdkToolCallPart(part),
          }
        }
        if (part.type === "finish-step") {
          yield { type: "model.usage", usage: mapUsage(part.usage) }
        }
        if (part.type === "finish") {
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
      case "openai":
        return (process.env.OPENAI_API_KEY ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY }) : openai).responses(request.modelId)
      case "google": {
        const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY
        return (apiKey ? createGoogleGenerativeAI({ apiKey }) : google)(request.modelId)
      }
      case "openrouter":
        return (
          process.env.OPENROUTER_API_KEY
            ? createOpenRouter({
                apiKey: process.env.OPENROUTER_API_KEY,
                appName: "Socrates",
                appUrl: "http://localhost",
              })
            : openrouter
        ).chat(request.modelId)
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
        inputSchema: definition.inputSchema,
      }),
    ]),
  )

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
        if (part.type === "tool-call") {
          return {
            type: "tool-call" as const,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
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
      .filter((part) => part.type === "text")
      .map((part) => ({ type: "text" as const, text: part.text })),
  } as AiModelMessage
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
      : { effort: "none", exclude: true },
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
