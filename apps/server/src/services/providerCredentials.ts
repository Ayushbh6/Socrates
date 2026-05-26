import type {
  CheckProviderCredentialResponse,
  ProviderCredentialSource,
  ProviderCredentialStatus,
  ProviderId,
  SetProviderCredentialSessionRequest,
} from "@socrates/contracts"
import { envProviderApiKey, type ProviderCredentialResolver } from "@socrates/providers"

const providerLabels: Record<ProviderId, string> = {
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
}

const providers: ProviderId[] = ["openrouter", "openai", "google"]

export class ProviderCredentialStore implements ProviderCredentialResolver {
  private readonly sessionKeys = new Map<ProviderId, string>()
  private readonly sessionSources = new Map<ProviderId, Exclude<ProviderCredentialSource, "env" | "missing">>()

  getApiKey(providerId: ProviderId): string | undefined {
    return this.sessionKeys.get(providerId) ?? envProviderApiKey(providerId)
  }

  listStatus(): {
    providers: ProviderCredentialStatus[]
    openRouterRequired: boolean
    openAiRequiredForHostedEmbeddings: boolean
    googleOptional: boolean
  } {
    return {
      providers: providers.map((providerId) => this.statusFor(providerId)),
      openRouterRequired: true,
      openAiRequiredForHostedEmbeddings: true,
      googleOptional: true,
    }
  }

  setSessionCredential(input: SetProviderCredentialSessionRequest): ProviderCredentialStatus {
    this.sessionKeys.set(input.providerId, input.apiKey)
    this.sessionSources.set(input.providerId, input.source === "keychain" ? "keychain" : "session")
    return this.statusFor(input.providerId)
  }

  deleteSessionCredential(providerId: ProviderId): ProviderCredentialStatus {
    this.sessionKeys.delete(providerId)
    this.sessionSources.delete(providerId)
    return this.statusFor(providerId)
  }

  check(providerId: ProviderId, apiKey?: string): CheckProviderCredentialResponse {
    const source = apiKey ? "session" : this.sourceFor(providerId)
    const configured = Boolean(apiKey ?? this.getApiKey(providerId))
    return {
      providerId,
      ok: configured,
      configured,
      source,
      message: configured
        ? `${providerLabels[providerId]} credential is configured.`
        : `${providerLabels[providerId]} credential is missing.`,
    }
  }

  statusFor(providerId: ProviderId): ProviderCredentialStatus {
    const source = this.sourceFor(providerId)
    return {
      providerId,
      providerLabel: providerLabels[providerId],
      required: providerId === "openrouter",
      configured: source !== "missing",
      source,
      ...(providerId === "openrouter"
        ? { message: "Required for chat and context compression." }
        : providerId === "openai"
          ? { message: "Required when hosted OpenAI embeddings are selected instead of local Ollama embeddings." }
          : { message: "Optional chat provider." }),
    }
  }

  private sourceFor(providerId: ProviderId): ProviderCredentialSource {
    if (this.sessionKeys.has(providerId)) {
      return this.sessionSources.get(providerId) ?? "session"
    }
    return envProviderApiKey(providerId) ? "env" : "missing"
  }
}
