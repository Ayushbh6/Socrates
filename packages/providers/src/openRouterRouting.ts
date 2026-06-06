export type OpenRouterProviderRouting = {
  order?: string[]
  allow_fallbacks?: boolean
  require_parameters?: boolean
  sort?: "price" | "throughput" | "latency"
}

const strictRouting = (order: string[]): OpenRouterProviderRouting => ({
  order,
  allow_fallbacks: false,
  require_parameters: true,
})

const pinnedCacheRouting = (order: string[]): OpenRouterProviderRouting => ({
  order,
  allow_fallbacks: false,
  require_parameters: false,
})

const cacheStickyRouting = (): OpenRouterProviderRouting => ({
  // Deliberately omit provider.order/only/ignore so OpenRouter can apply
  // session_id sticky routing after the first successful request.
})

const titleGenerationPrimaryRouting = strictRouting(["DeepInfra"])
const titleGenerationFallbackRouting = strictRouting(["Alibaba"])

export const openRouterProviderRoutingByModelId: Record<string, OpenRouterProviderRouting> = {
  "moonshotai/kimi-k2.6": cacheStickyRouting(),
  "z-ai/glm-5.1": cacheStickyRouting(),
  "xiaomi/mimo-v2.5-pro": cacheStickyRouting(),
  "xiaomi/mimo-v2.5": strictRouting(["Xiaomi"]),
  "x-ai/grok-build-0.1": strictRouting(["xAI"]),
  "stepfun/step-3.7-flash": strictRouting(["StepFun"]),
  "deepseek/deepseek-v4-pro": cacheStickyRouting(),
  "deepseek/deepseek-v4-flash": pinnedCacheRouting(["DeepInfra"]),
  "google/gemma-4-31b-it": cacheStickyRouting(),
}

export const openRouterProviderRoutingForModel = (modelId: string): OpenRouterProviderRouting | undefined =>
  openRouterProviderRoutingByModelId[modelId] ??
  (modelId === "meta-llama/llama-4-maverick"
    ? titleGenerationPrimaryRouting
    : modelId === "qwen/qwen3.5-flash-02-23"
      ? titleGenerationFallbackRouting
      : undefined)
