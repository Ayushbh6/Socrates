import { SocratesError } from "@socrates/shared"
import type {
  EmbeddingCheckRequest,
  EmbeddingCheckResult,
  EmbeddingModelListRequest,
  EmbeddingModelListResult,
  EmbeddingModelPullRequest,
  EmbeddingModelPullResult,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
} from "./types"

export class EmbeddingProviderRouter implements EmbeddingProvider {
  constructor(private readonly providers: Record<string, EmbeddingProvider>) {}

  check(request: EmbeddingCheckRequest): Promise<EmbeddingCheckResult> {
    return this.getProvider(request.providerId).check(request)
  }

  embedMany(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return this.getProvider(request.providerId).embedMany(request)
  }

  embed(request: EmbeddingCheckRequest & { value: string }): Promise<EmbeddingResult> {
    return this.getProvider(request.providerId).embed(request)
  }

  listModels(request: EmbeddingModelListRequest): Promise<EmbeddingModelListResult> {
    const provider = this.getProvider(request.providerId)
    if (!provider.listModels) {
      throw new SocratesError("embedding_model_discovery_not_supported", `Embedding provider does not support model discovery: ${request.providerId}`, {
        details: { providerId: request.providerId },
        recoverable: true,
      })
    }
    return provider.listModels(request)
  }

  pullModel(request: EmbeddingModelPullRequest): Promise<EmbeddingModelPullResult> {
    const provider = this.getProvider(request.providerId)
    if (!provider.pullModel) {
      throw new SocratesError("embedding_model_pull_not_supported", `Embedding provider does not support model pulls: ${request.providerId}`, {
        details: { providerId: request.providerId },
        recoverable: true,
      })
    }
    return provider.pullModel(request)
  }

  private getProvider(providerId: string): EmbeddingProvider {
    const provider = this.providers[providerId]
    if (!provider) {
      throw new SocratesError("embedding_provider_not_configured", `Embedding provider is not configured: ${providerId}`, {
        details: { providerId },
        recoverable: true,
      })
    }
    return provider
  }
}
