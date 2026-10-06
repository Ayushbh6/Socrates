import type { ModelUsage } from "@socrates/contracts";
import { deepSeekModels, openRouterId, openRouterModels } from "./catalog";

/** What a model costs, in US dollars per million tokens. `null`: the price of an ordinary input token. */
export interface Price {
  input: number;
  cachedInput: number | null;
  cacheWrite: number | null;
  output: number;
}

const PER_MILLION = 1_000_000;

/** The client id's provider and model: "openrouter:z-ai/glm-5.3-flash" is ["openrouter", "z-ai/glm-5.3-flash"]. */
export function splitModelId(id: string): [string, string] {
  const at = id.indexOf(":");
  if (at < 0) return ["", id];
  const provider = id.slice(0, at);
  const model = id.slice(at + 1);
  return [provider, provider === "gemini" ? model.replace(/^interactions:/, "") : model];
}

/**
 * The price list of a model, from OpenRouter's public list (architecture/
 * observability.md, "Cost"): the provider's own models appear there under its
 * prefix, and DeepSeek's by the name its model list gives. These are list
 * prices: a provider's own price may differ, which the settings can override.
 * Null when the model is not on the list or the list cannot be reached.
 */
export async function listPrice(provider: string, model: string, env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): Promise<Price | null> {
  try {
    let id = openRouterId(provider, model);
    if (provider === "deepseek") {
      const name = (await deepSeekModels(env, fetcher)).find((m) => m.id === model)?.name;
      id = name ? `deepseek/${name.toLowerCase()}` : null;
    }
    const pricing = id ? (await openRouterModels(fetcher)).find((m) => m.id === id)?.pricing : undefined;
    const input = Number(pricing?.prompt);
    const output = Number(pricing?.completion);
    if (!pricing || !Number.isFinite(input) || !Number.isFinite(output)) return null;
    // Dollars per token to dollars per million, without the float noise of the multiplication.
    const perMillion = (perToken: number) => Math.round(perToken * PER_MILLION * 1e6) / 1e6;
    const optional = (value: string | undefined) => (value !== undefined && Number.isFinite(Number(value)) ? perMillion(Number(value)) : null);
    return { input: perMillion(input), output: perMillion(output), cachedInput: optional(pricing.input_cache_read), cacheWrite: optional(pricing.input_cache_write) };
  } catch {
    return null;
  }
}

/** The cost of one call at a price; cache reads and writes are part of the prompt tokens and cost their own rate. */
export function costOf(usage: ModelUsage, price: Price): number {
  const read = Math.min(usage.cacheReadTokens, usage.promptTokens);
  const write = Math.min(usage.cacheWriteTokens, usage.promptTokens - read);
  const plain = usage.promptTokens - read - write;
  const dollars = plain * price.input + read * (price.cachedInput ?? price.input) + write * (price.cacheWrite ?? price.input) + usage.outputTokens * price.output;
  return dollars / PER_MILLION;
}

/** The cost the provider itself reported in its usage (OpenRouter does), in dollars. */
export function reportedCost(meta: Record<string, unknown> | null | undefined): number | null {
  const cost = (meta?.usage as { cost?: unknown } | null | undefined)?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}
