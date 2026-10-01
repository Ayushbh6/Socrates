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

export function makeModel(provider: string, model: string, env: Record<string, string | undefined> = process.env): ModelClient {
  const defaults = PROVIDER_DEFAULTS[provider as Provider];
  if (!defaults) throw new Error(`Unknown provider "${provider}". Use ${Object.keys(PROVIDER_DEFAULTS).join(", ")}.`);
  const apiKey = defaults.keys.map(k => env[k]).find(Boolean);
  if (!apiKey) throw new ModelError(`Missing ${defaults.keys.join(" or ")}.`, "authentication");
  switch (provider) {
    case "anthropic": return new AnthropicModel({ model, apiKey });
    case "gemini": return new GeminiInteractionsModel({ model, apiKey });
    case "deepseek": return new OpenAICompatibleModel({ model, provider, apiKey, baseURL: env.SOCRATES_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com", maxTokensParam: "max_tokens", sampling: false, extraBody: { reasoning_effort: "low" } });
    case "openrouter": return new OpenAICompatibleModel({ model, provider, apiKey, baseURL: "https://openrouter.ai/api/v1", maxTokensParam: "max_tokens", sampling: false });
    default: return new OpenAICompatibleModel({ model, provider, apiKey, sampling: false });
  }
}
