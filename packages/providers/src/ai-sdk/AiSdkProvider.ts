import { google, createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI, openai } from "@ai-sdk/openai"
import { createOpenRouter, openrouter } from "@openrouter/ai-sdk-provider"
import { streamText, type LanguageModel, type LanguageModelUsage } from "ai"
import { SocratesError } from "@socrates/shared"
import type { ModelEvent, ModelProvider, ModelRequest, ModelUsage } from "../types"

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type ProviderOptions = Record<string, Record<string, JsonValue>>

export class AiSdkProvider implements ModelProvider {
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    try {
      yield { type: "model.started" }

      const result = streamText({
        model: this.createModel(request),
        system: request.system,
        messages: request.messages.map((message) => ({
          role: message.role === "developer" ? "system" : message.role,
          content: message.content,
        })),
        providerOptions: this.createProviderOptions(request),
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      })

      for await (const part of result.fullStream) {
        if (part.type === "reasoning-delta" && part.text) {
          yield { type: "model.reasoning.delta", text: part.text }
        }
        if (part.type === "text-delta" && part.text) {
          yield { type: "model.answer.delta", text: part.text }
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
      yield { type: "model.failed", error: normalizeProviderError(error) }
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
