import { createOpenAI, openai } from "@ai-sdk/openai"
import { embed, embedMany } from "ai"
import { SocratesError } from "@socrates/shared"
import type { EmbeddingCheckRequest, EmbeddingCheckResult, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from "../types"

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  async check(request: EmbeddingCheckRequest): Promise<EmbeddingCheckResult> {
    if (!request.apiKey && !process.env.OPENAI_API_KEY) {
      return { ok: false, message: "OPENAI_API_KEY was not found in the selected environment." }
    }
    try {
      const result = await this.embed({ ...request, value: "Socrates embedding check" })
      return { ok: true, dimensions: result.dimensions, message: "OpenAI embeddings are reachable." }
    } catch (error) {
      return { ok: false, message: normalizeEmbeddingError(error).message }
    }
  }

  async embed(request: EmbeddingCheckRequest & { value: string }): Promise<EmbeddingResult> {
    const provider = request.apiKey ? createOpenAI({ apiKey: request.apiKey }) : openai
    const result = await embed({
      model: provider.embeddingModel(request.modelId),
      value: request.value,
      maxRetries: 1,
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    })
    const usage = mapEmbeddingUsage(result.usage)
    return {
      embeddings: [result.embedding],
      dimensions: result.embedding.length,
      ...(usage ? { usage } : {}),
      ...(result.response ? { raw: result.response } : {}),
    }
  }

  async embedMany(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.values.length === 0) {
      return { embeddings: [], dimensions: 0 }
    }
    const provider = request.apiKey ? createOpenAI({ apiKey: request.apiKey }) : openai
    const result = await embedMany({
      model: provider.embeddingModel(request.modelId),
      values: request.values,
      maxRetries: 1,
      maxParallelCalls: 2,
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    })
    const usage = mapEmbeddingUsage(result.usage)
    return {
      embeddings: result.embeddings,
      dimensions: result.embeddings[0]?.length ?? 0,
      ...(usage ? { usage } : {}),
      ...(result.responses ? { raw: result.responses } : {}),
    }
  }
}

const mapEmbeddingUsage = (usage: { tokens?: number; totalTokens?: number } | undefined): { inputTokens?: number; totalTokens?: number; raw: unknown } | undefined => {
  if (!usage) {
    return undefined
  }
  return {
    ...(usage.tokens === undefined ? {} : { inputTokens: usage.tokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    raw: usage,
  }
}

const normalizeEmbeddingError = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new SocratesError("embedding_provider_error", "Embedding provider failed", {
        details: { error },
        recoverable: true,
      })
