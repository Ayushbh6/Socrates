import { describe, expect, it } from "vitest"
import { createOpenRouterProviderOptions } from "../ai-sdk/AiSdkProvider"
import { modelCatalog } from "../modelCatalog/modelCatalog"
import { openRouterProviderRoutingByModelId, openRouterProviderRoutingForModel } from "../openRouterRouting"
import type { ModelRequest } from "../types"

const baseRequest = (thinkingEnabled: boolean, modelId = "z-ai/glm-5.1"): ModelRequest => ({
  providerId: "openrouter",
  modelId,
  sessionId: "sess_1",
  cacheKey: "project:proj_1:conversation:conv_1",
  system: "You are Socrates.",
  messages: [{ role: "user", content: "Hello" }],
  runtimeConfig: {
    providerId: "openrouter",
    modelId,
    thinkingEnabled,
    approvalMode: "manual",
    sandboxMode: "read_only",
  },
})

describe("OpenRouter provider options", () => {
  it("explicitly disables and excludes reasoning when thinking is off", () => {
    expect(createOpenRouterProviderOptions(baseRequest(false))).toEqual({
      openrouter: {
        usage: { include: true },
        extraBody: { session_id: "project:proj_1:conversation:conv_1" },
        reasoning: { enabled: false, effort: "none", exclude: true },
      },
    })
  })

  it("enables returned reasoning when thinking is on", () => {
    expect(createOpenRouterProviderOptions(baseRequest(true))).toEqual({
      openrouter: {
        usage: { include: true },
        extraBody: { session_id: "project:proj_1:conversation:conv_1" },
        reasoning: { enabled: true, exclude: false },
      },
    })
  })

  it("falls back to session id when a stable cache key is absent", () => {
    const request = baseRequest(false)
    delete request.cacheKey
    expect(createOpenRouterProviderOptions(request).openrouter?.extraBody).toEqual({ session_id: "sess_1" })
  })

  it("keeps strict provider pins for single-provider and title-generation routes", () => {
    expect(openRouterProviderRoutingForModel("xiaomi/mimo-v2.5")).toEqual({
      order: ["Xiaomi"],
      allow_fallbacks: false,
      require_parameters: true,
    })
    expect(openRouterProviderRoutingForModel("x-ai/grok-build-0.1")).toEqual({
      order: ["xAI"],
      allow_fallbacks: false,
      require_parameters: true,
    })
    expect(openRouterProviderRoutingForModel("stepfun/step-3.7-flash")).toEqual({
      order: ["StepFun"],
      allow_fallbacks: false,
      require_parameters: true,
    })
    expect(openRouterProviderRoutingForModel("deepseek/deepseek-v4-flash")).toEqual({
      order: ["DeepInfra"],
      allow_fallbacks: false,
      require_parameters: false,
    })
    expect(openRouterProviderRoutingForModel("meta-llama/llama-4-maverick")).toEqual({
      order: ["DeepInfra"],
      allow_fallbacks: false,
      require_parameters: true,
    })
    expect(openRouterProviderRoutingForModel("qwen/qwen3.5-flash-02-23")).toEqual({
      order: ["Alibaba"],
      allow_fallbacks: false,
      require_parameters: true,
    })
  })

  it("omits manual provider order for multi-provider cache-sticky models", () => {
    expect(openRouterProviderRoutingForModel("deepseek/deepseek-v4-pro")).toEqual({
      // No manual order: session_id can activate OpenRouter sticky routing.
    })
    expect(openRouterProviderRoutingForModel("xiaomi/mimo-v2.5-pro")).toEqual({
      // No manual order: session_id can activate OpenRouter sticky routing.
    })
    expect(createOpenRouterProviderOptions(baseRequest(false, "deepseek/deepseek-v4-pro")).openrouter).not.toHaveProperty("provider")
  })

  it("keeps stable cache smoke inputs for repeated strict-pin requests", () => {
    const first = createOpenRouterProviderOptions(baseRequest(false, "x-ai/grok-build-0.1"))
    const second = createOpenRouterProviderOptions(baseRequest(false, "x-ai/grok-build-0.1"))

    expect(first).toEqual(second)
    expect(first.openrouter?.extraBody).toEqual({ session_id: "project:proj_1:conversation:conv_1" })
    expect(first.openrouter?.provider).toEqual({
      order: ["xAI"],
      allow_fallbacks: false,
      require_parameters: true,
    })
  })

  it("has an explicit routing policy for every OpenRouter catalog model", () => {
    const openRouterModelIds = modelCatalog.filter((model) => model.providerId === "openrouter").map((model) => model.modelId)
    expect(Object.keys(openRouterProviderRoutingByModelId).sort()).toEqual([...openRouterModelIds].sort())
    for (const modelId of openRouterModelIds) {
      const routing = openRouterProviderRoutingForModel(modelId)
      expect(routing).toBeDefined()
    }
  })
})
