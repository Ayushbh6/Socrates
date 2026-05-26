import { EmbeddingProviderRouter } from "../EmbeddingProviderRouter"
import type { ProviderCredentialResolver } from "../types"
import { OllamaEmbeddingProvider } from "./OllamaEmbeddingProvider"
import { OpenAiEmbeddingProvider } from "./OpenAiEmbeddingProvider"

export const createDefaultEmbeddingProvider = (credentials?: ProviderCredentialResolver): EmbeddingProviderRouter =>
  new EmbeddingProviderRouter({
    openai: new OpenAiEmbeddingProvider(credentials),
    ollama: new OllamaEmbeddingProvider(),
  })
