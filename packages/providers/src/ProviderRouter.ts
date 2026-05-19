import { SocratesError } from "@socrates/shared"
import type { ModelEvent, ModelProvider, ModelRequest } from "./types"

export class ProviderRouter implements ModelProvider {
  constructor(private readonly providers: Record<string, ModelProvider>) {}

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const provider = this.providers[request.providerId]
    if (!provider) {
      throw new SocratesError("provider_not_configured", `Provider is not configured: ${request.providerId}`, {
        details: { providerId: request.providerId },
        recoverable: true,
      })
    }
    return provider.stream(request)
  }
}
