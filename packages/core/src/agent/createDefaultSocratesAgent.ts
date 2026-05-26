import { AiSdkProvider, findModelOption, listModels, ProviderRouter, type ProviderCredentialResolver } from "@socrates/providers"
import { SocratesAgent } from "./SocratesAgent"

export const createDefaultSocratesAgent = (credentials?: ProviderCredentialResolver): SocratesAgent => {
  const aiSdkProvider = new AiSdkProvider(credentials)
  return new SocratesAgent(
    new ProviderRouter({
      openai: aiSdkProvider,
      google: aiSdkProvider,
      openrouter: aiSdkProvider,
    }),
  )
}

export { findModelOption, listModels }
