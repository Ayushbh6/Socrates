import { createDefaultModelProvider, findModelOption, listModels, type ProviderCredentialResolver } from "@socrates/providers"
import { SocratesAgent } from "./SocratesAgent"
import { createV2ToolRegistry } from "../tools/registry"

export const createDefaultSocratesAgent = (credentials?: ProviderCredentialResolver): SocratesAgent => {
  return new SocratesAgent(createDefaultModelProvider(credentials))
}

export const createV2SocratesAgent = (credentials?: ProviderCredentialResolver): SocratesAgent => {
  return new SocratesAgent(createDefaultModelProvider(credentials), createV2ToolRegistry())
}

export { findModelOption, listModels }
