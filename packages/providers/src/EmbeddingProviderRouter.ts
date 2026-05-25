import { SocratesError } from "@socrates/shared"
import type { EmbeddingCheckRequest, EmbeddingCheckResult, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from "./types"

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
