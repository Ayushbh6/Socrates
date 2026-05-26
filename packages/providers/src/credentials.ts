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
  }
}

export const envProviderCredentialResolver: ProviderCredentialResolver = {
  getApiKey: (providerId) => envProviderApiKey(providerId),
}
