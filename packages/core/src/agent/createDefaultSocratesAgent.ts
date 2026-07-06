import { createDefaultModelProvider, findModelOption, listModels, type ProviderCredentialResolver } from "@socrates/providers"
import { SocratesAgent } from "./SocratesAgent"

export const createDefaultSocratesAgent = (credentials?: ProviderCredentialResolver): SocratesAgent => {
  return new SocratesAgent(createDefaultModelProvider(credentials))
}

export { findModelOption, listModels }
