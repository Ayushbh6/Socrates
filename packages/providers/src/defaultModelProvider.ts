import { AiSdkProvider } from "./ai-sdk/AiSdkProvider"
import { DeepSeekChatProvider } from "./deepseek/DeepSeekChatProvider"
import { OllamaChatProvider } from "./ollama/OllamaChatProvider"
import { ProviderRouter } from "./ProviderRouter"
import type { ModelProvider, ProviderCredentialResolver } from "./types"

export const createDefaultModelProvider = (credentials?: ProviderCredentialResolver): ModelProvider => {
  const aiSdkProvider = new AiSdkProvider(credentials)
  return new ProviderRouter({
    openai: aiSdkProvider,
    google: aiSdkProvider,
    openrouter: aiSdkProvider,
    deepseek: new DeepSeekChatProvider(credentials),
    ollama: new OllamaChatProvider(),
  })
}
