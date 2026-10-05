import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORTS, type Effort } from "@socrates/contracts";

/**
 * What the providers say about their models (architecture/agent-harness.md,
 * "Thinking levels"): which models a provider offers for chat, and which
 * thinking levels each model accepts.
 *
 * DeepSeek and OpenRouter list each model's levels themselves. OpenAI,
 * Anthropic and Gemini do not, so their models are looked up in OpenRouter's
 * public list, which carries the same models under the provider's prefix
 * (`openai/gpt-5`, `anthropic/claude-opus-5.5`, `google/gemini-3.8-flash`).
 * Lists are kept for ten minutes; a failed lookup is not kept.
 */

/** A model's thinking levels, weakest first, and the one used when the user has chosen none (null: the provider's own). */
export interface EffortLevels {
  levels: Effort[];
  default: Effort | null;
  /** The most the model may write in one reply, thinking included, when its list says. */
  maxOutputTokens?: number;
}

export interface ListedModel {
  id: string;
  name?: string;
}

export const NO_EFFORTS: EffortLevels = { levels: [], default: null };

/** Socrates' own default where a provider's would think longer than a chat needs; elsewhere the model's default. */
const SOCRATES_DEFAULT: Partial<Record<string, Effort>> = { gemini: "low", deepseek: "low" };
const LIST_TTL_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 10_000;

interface OpenRouterEntry {
  id: string;
  name?: string;
  supported_parameters?: string[];
  reasoning?: { mandatory?: boolean; supported_efforts?: string[] | null; default_effort?: string | null } | null;
  architecture?: { input_modalities?: unknown };
  top_provider?: { max_completion_tokens?: number | null };
}

interface DeepSeekEntry {
  id: string;
  name?: string;
  input_modalities?: unknown;
  max_output_tokens?: number;
  effort?: { supported_levels?: string[]; default_level?: string };
}

type Fetch = typeof fetch;
const caches = new WeakMap<Fetch, Map<string, { at: number; value: Promise<unknown> }>>();

/** One load per fetcher and key at a time, kept while fresh; a failure is forgotten so the next call tries again. */
function cached<T>(fetcher: Fetch, key: string, load: () => Promise<T>): Promise<T> {
  let cache = caches.get(fetcher);
  if (!cache) caches.set(fetcher, (cache = new Map()));
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

async function getJson(fetcher: Fetch, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}.`);
  return response.json();
}

const fingerprint = (key: string | undefined) => (key ? createHash("sha256").update(key).digest("hex").slice(0, 12) : "none");

export function openRouterModels(fetcher: Fetch = fetch): Promise<OpenRouterEntry[]> {
  return cached(fetcher, "openrouter", async () => ((await getJson(fetcher, "https://openrouter.ai/api/v1/models")) as { data?: OpenRouterEntry[] }).data ?? []);
}

export function deepSeekModels(env: Record<string, string | undefined> = process.env, fetcher: Fetch = fetch): Promise<DeepSeekEntry[]> {
  const key = env.DEEPSEEK_API_KEY;
  const base = env.SOCRATES_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  return cached(fetcher, `deepseek:${base}:${fingerprint(key)}`, async () =>
    ((await getJson(fetcher, `${base}/models`, key ? { authorization: `Bearer ${key}` } : {})) as { data?: DeepSeekEntry[] }).data ?? []);
}

/** The same model in OpenRouter's list, for providers that do not list levels themselves. */
export function openRouterId(provider: string, model: string): string | null {
  if (provider === "openrouter") return model;
  if (provider === "openai") return `openai/${model}`;
  if (provider === "gemini") return `google/${model}`;
  // claude-opus-5-5 is anthropic/claude-opus-5.5; a dated snapshot is the same model.
  if (provider === "anthropic") return `anthropic/${model.replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
  return null;
}

/** The thinking levels a model accepts, and the one Socrates uses until the user chooses; none when unknown. */
export async function detectEfforts(provider: string, model: string, env: Record<string, string | undefined> = process.env, fetcher: Fetch = fetch): Promise<EffortLevels> {
  try {
    let found = NO_EFFORTS;
    if (provider === "deepseek") {
      const entry = (await deepSeekModels(env, fetcher)).find((m) => m.id === model);
      // Every DeepSeek model can also answer without thinking (`thinking: { type: "disabled" }`).
      if (entry?.effort?.supported_levels?.length) found = withLimit(levelsOf(["off", ...entry.effort.supported_levels], entry.effort.default_level), entry.max_output_tokens);
    } else {
      const id = openRouterId(provider, model);
      const entry = id ? (await openRouterModels(fetcher)).find((m) => m.id === id) : undefined;
      const r = entry?.reasoning;
      // Gemini's thinking cannot be turned off through its own API.
      if (r?.supported_efforts?.length) found = withLimit(levelsOf([...r.supported_efforts, ...(r.mandatory === false && provider !== "gemini" ? ["off"] : [])], r.default_effort), entry?.top_provider?.max_completion_tokens);
    }
    const preferred = SOCRATES_DEFAULT[provider];
    return preferred && found.levels.includes(preferred) ? { ...found, default: preferred } : found;
  } catch {
    return NO_EFFORTS;
  }
}

const withLimit = (levels: EffortLevels, max: number | null | undefined): EffortLevels =>
  typeof max === "number" && max > 0 ? { ...levels, maxOutputTokens: max } : levels;

/** Levels in one vocabulary ("none" is "off"), weakest first, without ones Socrates does not know. */
function levelsOf(named: string[], fallback: string | null | undefined): EffortLevels {
  const known = (name: string | null | undefined): Effort | null => {
    const level = name === "none" ? "off" : name;
    return (EFFORTS as readonly string[]).includes(level ?? "") ? (level as Effort) : null;
  };
  const levels = EFFORTS.filter((e) => named.some((n) => known(n) === e));
  const preferred = known(fallback);
  return { levels, default: preferred && levels.includes(preferred) ? preferred : null };
}

/**
 * The models a provider offers for chat, as its own list says: only ones
 * that can call tools, which Socrates needs. Keys stay in headers.
 */
export async function listModels(provider: string, env: Record<string, string | undefined> = process.env, fetcher: Fetch = fetch): Promise<ListedModel[]> {
  switch (provider) {
    case "deepseek":
      return (await deepSeekModels(env, fetcher)).map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }));
    case "openrouter":
      return (await openRouterModels(fetcher))
        .filter((m) => m.supported_parameters?.includes("tools") && !m.id.endsWith(":batch"))
        .map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }));
    case "openai": {
      const key = env.OPENAI_API_KEY;
      return cached(fetcher, `openai:${fingerprint(key)}`, async () => {
        const body = (await getJson(fetcher, "https://api.openai.com/v1/models", key ? { authorization: `Bearer ${key}` } : {})) as { data?: { id: string }[] };
        return (body.data ?? [])
          .filter((m) => /^(gpt-|o\d|chatgpt)/.test(m.id) && !/(audio|realtime|transcribe|tts|image|search|embedding|instruct)/.test(m.id))
          .map((m) => ({ id: m.id }));
      });
    }
    case "gemini": {
      const key = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
      return cached(fetcher, `gemini:${fingerprint(key)}`, async () => {
        const body = (await getJson(fetcher, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", key ? { "x-goog-api-key": key } : {})) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
        return (body.models ?? [])
          // Speech, image, transcription, robotics and computer-use models cannot hold a chat with tools.
          .filter((m) => m.name.startsWith("models/gemini-") && m.supportedGenerationMethods?.includes("generateContent") && !/(tts|image|transcribe|robotics|computer-use|omni|audio|live)/.test(m.name))
          .map((m) => ({ id: m.name.slice("models/".length), ...(m.displayName ? { name: m.displayName } : {}) }));
      });
    }
    case "anthropic": {
      const apiKey = env.ANTHROPIC_API_KEY;
      const authToken = apiKey ? undefined : env.ANTHROPIC_AUTH_TOKEN;
      return cached(fetcher, `anthropic:${fingerprint(apiKey ?? authToken)}`, async () => {
        const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(authToken ? { authToken } : {}), fetch: fetcher, timeout: LIST_TIMEOUT_MS, maxRetries: 0 });
        const models: ListedModel[] = [];
        for await (const m of client.models.list()) models.push({ id: m.id, name: m.display_name });
        return models;
      });
    }
    default:
      return [];
  }
}
