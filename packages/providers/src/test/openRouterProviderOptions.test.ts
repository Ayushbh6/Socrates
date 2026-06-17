import { describe, expect, it } from "vitest"
import { readToolInputSchema } from "@socrates/contracts"
import { createOpenRouterProviderOptions } from "../ai-sdk/AiSdkProvider"
import { modelCatalog } from "../modelCatalog/modelCatalog"
import {
  openRouterProviderRoutingByModelId,
  openRouterProviderRoutingForModel,
  openRouterProviderSlugForPreference,
} from "../openRouterRouting"
import type { ModelRequest } from "../types"

const baseRequest = (thinkingEnabled: boolean, modelId = "z-ai/glm-5.2"): ModelRequest => ({
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
  const priceFirstProvider = { sort: "price", allow_fallbacks: true }

  it("explicitly disables and excludes reasoning when thinking is off", () => {
    expect(createOpenRouterProviderOptions(baseRequest(false))).toEqual({
      openrouter: {
        usage: { include: true },
        session_id: "project:proj_1:conversation:conv_1",
        prompt_cache_key: "project:proj_1:conversation:conv_1",
        provider: priceFirstProvider,
        reasoning: { enabled: false, effort: "none", exclude: true },
      },
    })
  })

  it("enables returned reasoning when thinking is on", () => {
    expect(createOpenRouterProviderOptions(baseRequest(true))).toEqual({
      openrouter: {
        usage: { include: true },
        session_id: "project:proj_1:conversation:conv_1",
        prompt_cache_key: "project:proj_1:conversation:conv_1",
        provider: priceFirstProvider,
        reasoning: { enabled: true, exclude: false },
      },
    })
  })

  it("falls back to session id when a stable cache key is absent", () => {
    const request = baseRequest(false)
    delete request.cacheKey
    expect(createOpenRouterProviderOptions(request).openrouter?.session_id).toBe("sess_1")
    expect(createOpenRouterProviderOptions(request).openrouter?.prompt_cache_key).toBe("sess_1")
  })

  it("keeps strict provider pins for single-provider and title-generation routes", () => {
    expect(openRouterProviderRoutingForModel("xiaomi/mimo-v2.5")).toEqual({
      order: ["xiaomi"],
      allow_fallbacks: false,
      require_parameters: true,
    })
    expect(openRouterProviderRoutingForModel("x-ai/grok-build-0.1")).toEqual({
      order: ["xai"],
      allow_fallbacks: false,
      require_parameters: true,
    })
    expect(openRouterProviderRoutingForModel("stepfun/step-3.7-flash")).toEqual({
      order: ["stepfun"],
      allow_fallbacks: false,
      require_parameters: true,
    })
    expect(openRouterProviderRoutingForModel("meta-llama/llama-4-maverick")).toEqual({
      order: ["deepinfra"],
      allow_fallbacks: false,
      require_parameters: true,
    })
    expect(openRouterProviderRoutingForModel("qwen/qwen3.5-flash-02-23")).toEqual({
      order: ["alibaba"],
      allow_fallbacks: false,
      require_parameters: true,
    })
  })

  it("price-sorts multi-provider models so OpenRouter cannot default to an expensive endpoint", () => {
    const priceFirst = { sort: "price", allow_fallbacks: true }
    expect(openRouterProviderRoutingForModel("xiaomi/mimo-v2.5-pro")).toEqual(priceFirst)
    expect(openRouterProviderRoutingForModel("moonshotai/kimi-k2.6")).toEqual(priceFirst)
    expect(openRouterProviderRoutingForModel("z-ai/glm-5.2")).toEqual(priceFirst)
    expect(openRouterProviderRoutingForModel("google/gemma-4-31b-it")).toEqual(priceFirst)
  })

  it("ranks DeepSeek V4 Pro by cheapest compatible OpenRouter providers", () => {
    // Tool-capable requests skip Baidu because that endpoint does not advertise
    // tools/tool_choice; plain text requests may try it after DeepSeek-direct.
    expect(openRouterProviderRoutingForModel("deepseek/deepseek-v4-pro", { requiresTools: true })).toEqual({
      order: [
        "deepseek",
        "streamlake",
        "deepinfra",
        "gmicloud",
        "digitalocean",
        "siliconflow",
        "novita",
        "alibaba",
        "atlas-cloud",
        "venice",
        "parasail",
        "together",
      ],
      allow_fallbacks: true,
    })
    expect(openRouterProviderRoutingForModel("deepseek/deepseek-v4-pro", { requiresTools: false }).order?.slice(0, 3)).toEqual([
      "deepseek",
      "baidu",
      "streamlake",
    ])

    const request = baseRequest(false, "deepseek/deepseek-v4-pro")
    request.tools = [
      {
        name: "read",
        description: "Read a file.",
        inputSchema: readToolInputSchema,
      },
    ]
    const provider = createOpenRouterProviderOptions(request).openrouter?.provider
    expect(provider).toEqual(openRouterProviderRoutingForModel("deepseek/deepseek-v4-pro", { requiresTools: true }))
  })

  it("prefers the routed provider from earlier calls without hard-blocking fallback", () => {
    expect(openRouterProviderSlugForPreference("DeepInfra")).toBe("deepinfra")
    expect(openRouterProviderSlugForPreference("GMICloud")).toBe("gmicloud")
    expect(openRouterProviderSlugForPreference("Z.AI")).toBe("z-ai")

    const request = baseRequest(false, "deepseek/deepseek-v4-pro")
    request.providerRouting = { preferredOpenRouterProvider: "DeepInfra" }

    expect(createOpenRouterProviderOptions(request).openrouter?.provider).toEqual({
      order: ["deepinfra"],
      allow_fallbacks: true,
    })
  })

  it("never falls back to empty (expensive default) routing, even for unknown models", () => {
    expect(openRouterProviderRoutingForModel("some/unmapped-model")).toEqual({
      sort: "price",
      allow_fallbacks: true,
    })
  })

  it("keeps stable cache smoke inputs for repeated strict-pin requests", () => {
    const first = createOpenRouterProviderOptions(baseRequest(false, "x-ai/grok-build-0.1"))
    const second = createOpenRouterProviderOptions(baseRequest(false, "x-ai/grok-build-0.1"))

    expect(first).toEqual(second)
    expect(first.openrouter?.session_id).toBe("project:proj_1:conversation:conv_1")
    expect(first.openrouter?.prompt_cache_key).toBe("project:proj_1:conversation:conv_1")
    expect(first.openrouter?.provider).toEqual({
      order: ["xai"],
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
      // Every model must be cost-aware: either price-sorted or pinned to a
      // deliberate provider order. An empty routing object is a regression
      // because OpenRouter would then pick an expensive endpoint by default.
      const isCostAware = routing.sort === "price" || (routing.order?.length ?? 0) > 0
      expect(isCostAware, `model ${modelId} has no cost-aware routing`).toBe(true)
    }
  })
})
