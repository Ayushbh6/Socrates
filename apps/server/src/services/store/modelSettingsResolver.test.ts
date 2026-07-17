import { describe, expect, it } from "vitest"
import type { ListModelsResponse, ModelSettingsSelection } from "@socrates/contracts"
import { resolveModelSettingsForAvailableModels } from "./modelSettingsResolver"

const grokOnlyCatalog: ListModelsResponse = {
  models: [
    {
      providerId: "openrouter",
      authMode: "api_key",
      providerLabel: "OpenRouter",
      modelId: "x-ai/grok-4.5",
      label: "Grok 4.5",
      isDefault: true,
      thinkingOptions: [
        { id: "low", label: "Low", enabled: true, effort: "low" },
        { id: "medium", label: "Medium", enabled: true, effort: "medium" },
        { id: "high", label: "High", enabled: true, effort: "high" },
      ],
      defaultThinkingOptionId: "low",
    },
  ],
  defaultModel: {
    providerId: "openrouter",
    authMode: "api_key",
    modelId: "x-ai/grok-4.5",
    thinkingOptionId: "low",
  },
}

const savedFrontier = (overrides: Partial<ModelSettingsSelection> = {}): ModelSettingsSelection => ({
  providerId: "openrouter",
  authMode: "api_key",
  modelId: "x-ai/grok-4.5",
  thinkingEnabled: true,
  thinkingEffort: "low",
  ...overrides,
})

describe("model settings resolver", () => {
  it("keeps a supported mandatory-reasoning Frontier selection", () => {
    expect(resolveModelSettingsForAvailableModels(savedFrontier(), "frontier", grokOnlyCatalog)).toMatchObject({
      status: "selected",
      effective: {
        providerId: "openrouter",
        modelId: "x-ai/grok-4.5",
        thinkingEnabled: true,
        thinkingEffort: "low",
      },
    })
  })

  it("keeps provider-default reasoning enabled when no effort was saved", () => {
    expect(
      resolveModelSettingsForAvailableModels(
        savedFrontier({ thinkingEnabled: true, thinkingEffort: undefined }),
        "frontier",
        grokOnlyCatalog,
      ),
    ).toMatchObject({
      status: "selected",
      effective: {
        thinkingEnabled: true,
      },
    })
  })

  it("normalizes a stale Grok thinking-off selection to the supported default", () => {
    expect(
      resolveModelSettingsForAvailableModels(
        savedFrontier({ thinkingEnabled: false, thinkingEffort: undefined }),
        "frontier",
        grokOnlyCatalog,
      ),
    ).toMatchObject({
      status: "resolved_fallback",
      reason: "Frontier thinking setting is unavailable for Grok 4.5; using its supported default.",
      saved: {
        thinkingEnabled: false,
      },
      effective: {
        providerId: "openrouter",
        modelId: "x-ai/grok-4.5",
        thinkingEnabled: true,
        thinkingEffort: "low",
      },
    })
  })
})
