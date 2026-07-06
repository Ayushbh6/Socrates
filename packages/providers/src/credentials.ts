import type { ProviderId } from "@socrates/contracts"
import type { ProviderCredentialResolver } from "./types"

export const envProviderApiKey = (providerId: ProviderId, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  switch (providerId) {
    case "openai":
      return env.OPENAI_API_KEY
    case "google":
      return env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GEMINI_API_KEY
    case "openrouter":
      return env.OPENROUTER_API_KEY
    case "ollama":
      return undefined
  }
}

export const envProviderCredentialResolver: ProviderCredentialResolver = {
  getApiKey: (providerId) => envProviderApiKey(providerId),
  resolveAuth: (providerId, authMode = "api_key") => {
    if (authMode !== "api_key") {
      return undefined
    }
    const apiKey = envProviderApiKey(providerId)
    return apiKey ? { authMode: "api_key", apiKey } : undefined
  },
  availableAuthModes: () =>
    (["openrouter", "openai", "google"] as const)
      .filter((providerId) => Boolean(envProviderApiKey(providerId)))
      .map((providerId) => ({ providerId, authMode: "api_key" as const })),
}
