import { AiSdkProvider, findModelOption, listModels, ProviderRouter } from "@socrates/providers"
import { SocratesAgent } from "./SocratesAgent"

export const createDefaultSocratesAgent = (): SocratesAgent => {
  const aiSdkProvider = new AiSdkProvider()
  return new SocratesAgent(
    new ProviderRouter({
      openai: aiSdkProvider,
      google: aiSdkProvider,
      openrouter: aiSdkProvider,
    }),
  )
}

export { findModelOption, listModels }
