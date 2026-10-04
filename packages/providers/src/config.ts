import { ModelError, type ModelClient } from "@socrates/contracts";
import { AnthropicModel } from "./anthropic";
import { GeminiInteractionsModel } from "./gemini";
import { OpenAICompatibleModel } from "./openai";

export const PROVIDER_DEFAULTS = {
  anthropic: { router: "claude-haiku-4-5", main: "claude-opus-5-5", keys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] },
  openai: { router: "gpt-5-mini", main: "gpt-5", keys: ["OPENAI_API_KEY"] },
  deepseek: { router: "deepseek-v4-pro", main: "deepseek-v4-pro", keys: ["DEEPSEEK_API_KEY"] },
  openrouter: { router: "google/gemini-3.8-flash", main: "google/gemini-3.8-flash", keys: ["OPENROUTER_API_KEY"] },
  gemini: { router: "gemini-3.8-flash", main: "gemini-3.8-flash", keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
} as const;
export type Provider = keyof typeof PROVIDER_DEFAULTS;

/**
 * Whether a model can see images, as far as can be told without asking its
 * provider: every Claude and Gemini model can, and OpenAI's GPT-4o, GPT-4.1,
 * GPT-5 and o-series models can. DeepSeek and OpenRouter differ by model, so
 * they are asked (`detectVision`); unknown means no.
 */
export function knownVision(provider: string, model: string): boolean {
  if (provider === "anthropic" || provider === "gemini") return true;
  if (provider === "openai") return /^(gpt-4o|gpt-4\.1|gpt-5|o\d)/.test(model);
  return false;
}

/**
 * Whether a model can see images, asking the provider's model list where it
 * says so (DeepSeek and OpenRouter list each model's input modalities). A
 * failed or slow lookup falls back to `knownVision`.
 */
export async function detectVision(provider: string, model: string, env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): Promise<boolean> {
  const lists: Record<string, { url: string; key?: string }> = {
    deepseek: { url: `${env.SOCRATES_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"}/models`, key: env.DEEPSEEK_API_KEY },
    openrouter: { url: "https://openrouter.ai/api/v1/models" },
  };
  const list = lists[provider];
  if (!list) return knownVision(provider, model);
  try {
    const response = await fetcher(list.url, { headers: list.key ? { authorization: `Bearer ${list.key}` } : {}, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return knownVision(provider, model);
    const body = (await response.json()) as { data?: { id?: string; input_modalities?: unknown; architecture?: { input_modalities?: unknown } }[] };
    const entry = body.data?.find((m) => m.id === model);
    const modalities = entry?.input_modalities ?? entry?.architecture?.input_modalities;
    return Array.isArray(modalities) ? modalities.includes("image") : knownVision(provider, model);
  } catch {
    return knownVision(provider, model);
  }
}

export function makeModel(provider: string, model: string, env: Record<string, string | undefined> = process.env, options: { vision?: boolean } = {}): ModelClient {
  const defaults = PROVIDER_DEFAULTS[provider as Provider];
  if (!defaults) throw new Error(`Unknown provider "${provider}". Use ${Object.keys(PROVIDER_DEFAULTS).join(", ")}.`);
  const apiKey = defaults.keys.map(k => env[k]).find(Boolean);
  if (!apiKey) throw new ModelError(`Missing ${defaults.keys.join(" or ")}.`, "authentication");
  const vision = options.vision ?? knownVision(provider, model);
  switch (provider) {
    case "anthropic": return new AnthropicModel({ model, apiKey, vision });
    case "gemini": return new GeminiInteractionsModel({ model, apiKey, vision });
    case "deepseek": return new OpenAICompatibleModel({ model, provider, apiKey, vision, baseURL: env.SOCRATES_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com", maxTokensParam: "max_tokens", sampling: false, extraBody: { reasoning_effort: "low" } });
    case "openrouter": return new OpenAICompatibleModel({ model, provider, apiKey, vision, baseURL: "https://openrouter.ai/api/v1", maxTokensParam: "max_tokens", sampling: false });
    default: return new OpenAICompatibleModel({ model, provider, apiKey, vision, sampling: false });
  }
}
