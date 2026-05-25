import type { EmbeddingCheckRequest, EmbeddingCheckResult, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from "../types"

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"

type OllamaTagsResponse = {
  models?: Array<{ name?: string; model?: string }>
}

type OllamaEmbedResponse = {
  embeddings?: number[][]
  embedding?: number[]
  prompt_eval_count?: number
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  async check(request: EmbeddingCheckRequest): Promise<EmbeddingCheckResult> {
    try {
      const baseUrl = normalizeBaseUrl(request.baseUrl)
      const tags = (await fetchJson(`${baseUrl}/api/tags`, {
        ...(request.abortSignal ? { signal: request.abortSignal } : {}),
      })) as OllamaTagsResponse
      const models = tags.models ?? []
      const hasModel = models.some((model) => model.name === request.modelId || model.model === request.modelId)
      if (!hasModel) {
        return {
          ok: false,
          message: `Ollama is reachable, but model "${request.modelId}" was not found. Pull it with: ollama pull ${request.modelId}`,
          raw: tags,
        }
      }
      const result = await this.embed({ ...request, value: "Socrates embedding check" })
      return { ok: true, dimensions: result.dimensions, message: "Ollama embeddings are reachable.", raw: tags }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        message: `Could not reach Ollama at ${normalizeBaseUrl(request.baseUrl)}. Start Ollama and make sure the embedding model is pulled. ${message}`,
      }
    }
  }

  async embed(request: EmbeddingCheckRequest & { value: string }): Promise<EmbeddingResult> {
    return this.embedMany({ ...request, values: [request.value] })
  }

  async embedMany(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.values.length === 0) {
      return { embeddings: [], dimensions: 0 }
    }
    const baseUrl = normalizeBaseUrl(request.baseUrl)
    const response = (await fetchJson(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: request.modelId, input: request.values }),
      ...(request.abortSignal ? { signal: request.abortSignal } : {}),
    })) as OllamaEmbedResponse
    const embeddings = response.embeddings ?? (response.embedding ? [response.embedding] : [])
    return {
      embeddings,
      dimensions: embeddings[0]?.length ?? 0,
      ...(response.prompt_eval_count === undefined ? {} : { usage: { inputTokens: response.prompt_eval_count, raw: response } }),
      raw: response,
    }
  }
}

export const normalizeBaseUrl = (baseUrl: string | undefined): string => (baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "")

const fetchJson = async (url: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<unknown>
}
