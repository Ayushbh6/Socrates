import { SocratesError } from "@socrates/shared"
import type { TokenCountResult } from "./tokenCounting"
import type { ModelEvent, ModelProvider, ModelRequest, StructuredModelRequest, StructuredModelResult } from "./types"

export class ProviderRouter implements ModelProvider {
  constructor(private readonly providers: Record<string, ModelProvider>) {}

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    return this.getProvider(request).stream(request)
  }

  countTokens(request: ModelRequest): Promise<TokenCountResult> {
    return this.getProvider(request).countTokens(request)
  }

  generateStructured<TOutput>(request: StructuredModelRequest<TOutput>): Promise<StructuredModelResult<TOutput>> {
    const provider = this.getProvider(request)
    if (!provider.generateStructured) {
      throw new SocratesError("provider_structured_generation_unavailable", `Provider does not support structured generation: ${request.providerId}`, {
        details: { providerId: request.providerId },
        recoverable: true,
      })
    }
    return provider.generateStructured<TOutput>(request) as Promise<StructuredModelResult<TOutput>>
  }

  private getProvider(request: ModelRequest): ModelProvider {
    const provider = this.providers[request.providerId]
    if (!provider) {
      throw new SocratesError("provider_not_configured", `Provider is not configured: ${request.providerId}`, {
        details: { providerId: request.providerId },
        recoverable: true,
      })
    }
    return provider
  }
}
