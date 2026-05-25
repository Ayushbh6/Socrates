import { EmbeddingProviderRouter } from "../EmbeddingProviderRouter"
import { OllamaEmbeddingProvider } from "./OllamaEmbeddingProvider"
import { OpenAiEmbeddingProvider } from "./OpenAiEmbeddingProvider"

export const createDefaultEmbeddingProvider = (): EmbeddingProviderRouter =>
  new EmbeddingProviderRouter({
    openai: new OpenAiEmbeddingProvider(),
    ollama: new OllamaEmbeddingProvider(),
  })
