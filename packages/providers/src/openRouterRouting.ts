export type OpenRouterProviderRouting = {
  order?: string[]
  allow_fallbacks?: boolean
  require_parameters?: boolean
  sort?: "price" | "throughput" | "latency"
}

export type OpenRouterProviderRoutingOptions = {
  preferredProvider?: string
  requiresTools?: boolean
}

const strictRouting = (order: string[]): OpenRouterProviderRouting => ({
  order,
  allow_fallbacks: false,
  require_parameters: true,
})

// Default routing for OpenRouter models without a deliberate provider pin.
// OpenRouter otherwise load-balances by uptime, which can land on a much more
// expensive upstream endpoint for the same model id. Sorting by price makes the
// cheapest provider the first choice and allow_fallbacks keeps the request alive
// if that endpoint is down. We intentionally do NOT set require_parameters: a
// strict parameter match filters out cheap first-party endpoints (e.g. DeepSeek)
// that do not advertise our exact reasoning/exclude shape, which silently pushes
// routing to a pricier provider. Cache locality is preserved by the stable
// session/cache-affinity fields sent separately in createOpenRouterProviderOptions.
const priceFirstCacheRouting = (): OpenRouterProviderRouting => ({
  sort: "price",
  allow_fallbacks: true,
})

const orderedFallbackRouting = (order: string[]): OpenRouterProviderRouting => ({
  order,
  allow_fallbacks: true,
})

// OpenRouter provider.order accepts provider slugs. Usage metadata usually
// reports display names, so turn-local provider affinity must normalize them.
const openRouterProviderDisplayNameToSlug = new Map<string, string>([
  ["alibaba", "alibaba"],
  ["atlascloud", "atlas-cloud"],
  ["baidu", "baidu"],
  ["cloudflare", "cloudflare"],
  ["crusoe", "crusoe"],
  ["deepinfra", "deepinfra"],
  ["deepseek", "deepseek"],
  ["digitalocean", "digitalocean"],
  ["fireworks", "fireworks"],
  ["friendli", "friendli"],
  ["gmicloud", "gmicloud"],
  ["ionet", "io-net"],
  ["lambda", "lambda"],
  ["morph", "morph"],
  ["nebiusaistudio", "nebius"],
  ["novita", "novita"],
  ["novitaai", "novita"],
  ["parasail", "parasail"],
  ["siliconflow", "siliconflow"],
  ["stepfun", "stepfun"],
  ["streamlake", "streamlake"],
  ["together", "together"],
  ["venice", "venice"],
  ["xai", "xai"],
  ["xiaomi", "xiaomi"],
  ["zai", "z-ai"],
])

export const openRouterProviderSlugForPreference = (provider: string | undefined): string | undefined => {
  const trimmed = provider?.trim()
  if (!trimmed) {
    return undefined
  }
  const directSlug = trimmed.toLowerCase()
  if (/^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(directSlug)) {
    return directSlug.split("/")[0]
  }
  return openRouterProviderDisplayNameToSlug.get(trimmed.toLowerCase().replace(/[^a-z0-9]/g, ""))
}

const preferredProviderRouting = (provider: string | undefined): OpenRouterProviderRouting | undefined => {
  const slug = openRouterProviderSlugForPreference(provider)
  return slug ? orderedFallbackRouting([slug]) : undefined
}

const deepseekV4ProToolOrder = [
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
]

const deepseekV4ProToolRouting = orderedFallbackRouting(deepseekV4ProToolOrder)
const deepseekV4ProTextRouting = orderedFallbackRouting(["deepseek", "baidu", ...deepseekV4ProToolOrder.slice(1)])

const deepseekV4FlashToolOrder = [
  "deepinfra",
  "cloudflare",
  "digitalocean",
  "gmicloud",
  "siliconflow",
  "alibaba",
  "morph",
  "deepseek",
  "parasail",
  "atlas-cloud",
]

const deepseekV4FlashToolRouting = orderedFallbackRouting(deepseekV4FlashToolOrder)
const deepseekV4FlashTextRouting = orderedFallbackRouting(["baidu", ...deepseekV4FlashToolOrder])

export const openRouterProviderRoutingByModelId: Record<string, OpenRouterProviderRouting> = {
  "moonshotai/kimi-k2.6": priceFirstCacheRouting(),
  "tencent/hy3": priceFirstCacheRouting(),
  "z-ai/glm-5.2": priceFirstCacheRouting(),
  "xiaomi/mimo-v2.5-pro": priceFirstCacheRouting(),
  "xiaomi/mimo-v2.5": strictRouting(["xiaomi"]),
  "x-ai/grok-build-0.1": strictRouting(["xai"]),
  "stepfun/step-3.7-flash": strictRouting(["stepfun"]),
  "deepseek/deepseek-v4-pro": deepseekV4ProToolRouting,
  "deepseek/deepseek-v4-flash": deepseekV4FlashToolRouting,
  "google/gemma-4-31b-it": priceFirstCacheRouting(),
  "meta-llama/llama-4-maverick": priceFirstCacheRouting(),
  "qwen/qwen3.5-flash-02-23": priceFirstCacheRouting(),
}

// Every OpenRouter model resolves to cost-aware routing. Explicit per-model
// entries win; anything else falls back to price-first cache-sticky routing so
// no model is ever sent with empty routing (OpenRouter's expensive default).
export const openRouterProviderRoutingForModel = (
  modelId: string,
  options: OpenRouterProviderRoutingOptions = {},
): OpenRouterProviderRouting => {
  const preferred = preferredProviderRouting(options.preferredProvider)
  if (preferred) {
    return preferred
  }
  if (modelId === "deepseek/deepseek-v4-pro") {
    return options.requiresTools ? deepseekV4ProToolRouting : deepseekV4ProTextRouting
  }
  if (modelId === "deepseek/deepseek-v4-flash") {
    return options.requiresTools ? deepseekV4FlashToolRouting : deepseekV4FlashTextRouting
  }
  const explicit = openRouterProviderRoutingByModelId[modelId]
  if (explicit) {
    return explicit
  }
  return priceFirstCacheRouting()
}
