import type {
  EmbeddingCheckRequest,
  EmbeddingCheckResult,
  EmbeddingModelInfo,
  EmbeddingModelListRequest,
  EmbeddingModelListResult,
  EmbeddingModelPullRequest,
  EmbeddingModelPullResult,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
} from "../types"

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"

type OllamaTagsResponse = {
  models?: OllamaModelSummary[]
}

type OllamaModelSummary = {
  name?: string
  model?: string
  modified_at?: string
  size?: number
  details?: OllamaModelDetails
  capabilities?: string[]
}

type OllamaModelDetails = {
  format?: string
  family?: string
  families?: string[]
  parameter_size?: string
  quantization_level?: string
  context_length?: number
  embedding_length?: number
}

type OllamaShowResponse = {
  details?: OllamaModelDetails
  capabilities?: string[]
  model_info?: Record<string, unknown>
}

type OllamaEmbedResponse = {
  embeddings?: number[][]
  embedding?: number[]
  prompt_eval_count?: number
}

type OllamaPullResponse = {
  status?: string
  error?: string
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  async check(request: EmbeddingCheckRequest): Promise<EmbeddingCheckResult> {
    try {
      const baseUrl = normalizeBaseUrl(request.baseUrl)
      const list = await this.listModels({ providerId: request.providerId, baseUrl, ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}) })
      const model = list.models.find((candidate) => modelNameMatches(candidate.modelId, request.modelId))
      if (!model) {
        return {
          ok: false,
          message: `Ollama is reachable, but model "${request.modelId}" was not found. Pull it with: ollama pull ${request.modelId}`,
          raw: list.raw,
        }
      }
      if (model.status === "not_embedding") {
        return {
          ok: false,
          message: `Ollama model "${request.modelId}" is installed, but it does not advertise embedding support. Choose an embedding model such as embeddinggemma:latest.`,
          raw: model.raw,
        }
      }
      const result = await this.embed({ ...request, value: "Socrates embedding check" })
      return { ok: true, dimensions: result.dimensions, message: "Ollama embeddings are reachable.", raw: list.raw }
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

  async listModels(request: EmbeddingModelListRequest): Promise<EmbeddingModelListResult> {
    const baseUrl = normalizeBaseUrl(request.baseUrl)
    const tags = (await fetchJson(`${baseUrl}/api/tags`, {
      ...(request.abortSignal ? { signal: request.abortSignal } : {}),
    })) as OllamaTagsResponse
    const summaries = tags.models ?? []
    const models = await Promise.all(
      summaries.map(async (summary) => {
        const modelId = summary.model ?? summary.name
        if (!modelId) {
          return undefined
        }
        let details: OllamaShowResponse | undefined
        try {
          details = (await fetchJson(`${baseUrl}/api/show`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: modelId }),
            ...(request.abortSignal ? { signal: request.abortSignal } : {}),
          })) as OllamaShowResponse
        } catch {
          details = undefined
        }
        return toModelInfo(summary, details)
      }),
    )
    return { models: models.filter((model): model is EmbeddingModelInfo => Boolean(model)), raw: tags }
  }

  async pullModel(request: EmbeddingModelPullRequest): Promise<EmbeddingModelPullResult> {
    const baseUrl = normalizeBaseUrl(request.baseUrl)
    const response = (await fetchJson(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: request.modelId, stream: false }),
      ...(request.abortSignal ? { signal: request.abortSignal } : {}),
    })) as OllamaPullResponse
    if (response.error) {
      return { ok: false, message: response.error, raw: response }
    }
    return {
      ok: true,
      message: `Pulled ${request.modelId}.`,
      raw: response,
    }
  }
}

export const normalizeBaseUrl = (baseUrl: string | undefined): string => (baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "")

const toModelInfo = (summary: OllamaModelSummary, show: OllamaShowResponse | undefined): EmbeddingModelInfo | undefined => {
  const modelId = summary.model ?? summary.name
  if (!modelId) {
    return undefined
  }
  const details = { ...(summary.details ?? {}), ...(show?.details ?? {}) }
  const capabilities = uniqueStrings([...(summary.capabilities ?? []), ...(show?.capabilities ?? [])])
  const modelInfo = show?.model_info ?? {}
  const contextLength = numericValue(details.context_length) ?? modelInfoNumber(modelInfo, "context_length")
  const embeddingLength = numericValue(details.embedding_length) ?? modelInfoNumber(modelInfo, "embedding_length")
  const status = inferEmbeddingStatus(modelId, capabilities)
  return {
    modelId,
    name: summary.name ?? modelId,
    status,
    embeddingCapable: status === "embedding",
    ...(typeof summary.size === "number" ? { sizeBytes: summary.size } : {}),
    ...(summary.modified_at ? { modifiedAt: summary.modified_at } : {}),
    ...(details.family ? { family: details.family } : {}),
    ...(details.families ? { families: details.families } : {}),
    ...(details.parameter_size ? { parameterSize: details.parameter_size } : {}),
    ...(details.quantization_level ? { quantizationLevel: details.quantization_level } : {}),
    ...(contextLength ? { contextLength } : {}),
    ...(embeddingLength ? { embeddingLength } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    raw: { summary, show },
  }
}

const inferEmbeddingStatus = (modelId: string, capabilities: string[]): EmbeddingModelInfo["status"] => {
  const normalized = capabilities.map((capability) => capability.toLowerCase())
  if (normalized.includes("embedding")) {
    return "embedding"
  }
  if (normalized.length > 0) {
    return "not_embedding"
  }
  return looksLikeEmbeddingModel(modelId) ? "embedding" : "unknown"
}

const looksLikeEmbeddingModel = (modelId: string): boolean => /\b(embed|embedding|minilm|bge|gte|e5|mxbai|nomic)\b/i.test(modelId.replaceAll("-", " "))

const modelNameMatches = (installedModelId: string, requestedModelId: string): boolean => {
  if (installedModelId === requestedModelId) {
    return true
  }
  if (!requestedModelId.includes(":") && installedModelId === `${requestedModelId}:latest`) {
    return true
  }
  if (!installedModelId.includes(":") && `${installedModelId}:latest` === requestedModelId) {
    return true
  }
  return false
}

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

const fetchJson = async (url: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<unknown>
}
