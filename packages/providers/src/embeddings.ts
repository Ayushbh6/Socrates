import { createHash } from "node:crypto";
import { type EmbeddingClient, ModelError } from "@socrates/contracts";

/**
 * Embedding clients (agent-harness.md, "Embeddings"). The default is a local
 * Ollama model, so memory search works offline; OpenRouter, OpenAI, or any
 * OpenAI-compatible endpoint can be chosen instead, like chat models.
 */

export const EMBEDDING_DEFAULTS = { provider: "ollama", model: "embeddinggemma", ollamaURL: "http://localhost:11434" } as const;
const BATCH = 32;

/** Instruction prefixes some models were trained with; a model without an entry gets the text as is. */
const PREFIXES: { match: RegExp; query: (t: string) => string; document: (t: string) => string }[] = [
  { match: /embeddinggemma/i, query: (t) => `task: search result | query: ${t}`, document: (t) => `title: none | text: ${t}` },
  { match: /nomic-embed/i, query: (t) => `search_query: ${t}`, document: (t) => `search_document: ${t}` },
];

function prefixed(model: string, texts: string[], purpose: "query" | "document"): string[] {
  const p = PREFIXES.find((x) => x.match.test(model));
  return p ? texts.map(p[purpose]) : texts;
}

export async function postJson(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal | undefined, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  } catch (error) {
    if (signal?.aborted) throw new ModelError(`${what} request was cancelled.`, "aborted");
    throw new ModelError(`${what} is unreachable: ${error instanceof Error ? error.message : String(error)}`, "network");
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const kind = res.status === 401 || res.status === 403 ? "authentication" : res.status === 429 ? "rate_limit" : res.status >= 500 ? "server" : "invalid_request";
    throw new ModelError(`${what} returned ${res.status}${detail ? `: ${detail}` : ""}`, kind, res.status);
  }
  return res.json();
}

/** A model served by a local Ollama, through its /api/embed endpoint. */
export class OllamaEmbedder implements EmbeddingClient {
  readonly id: string;
  constructor(private readonly options: { model: string; baseURL?: string }) {
    this.id = `ollama:${options.model}:${endpointKey(options.baseURL ?? EMBEDDING_DEFAULTS.ollamaURL)}`;
  }

  async embed(texts: string[], purpose: "query" | "document", signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const input = prefixed(this.options.model, texts.slice(i, i + BATCH), purpose);
      const body = (await postJson(`${this.options.baseURL ?? EMBEDDING_DEFAULTS.ollamaURL}/api/embed`, { model: this.options.model, input, truncate: true }, {}, signal, `Ollama (${this.options.model})`)) as { embeddings?: number[][] };
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) throw new ModelError(`Ollama (${this.options.model}) returned no embeddings.`, "server");
      out.push(...body.embeddings);
    }
    return out;
  }
}

/** OpenRouter, OpenAI, or any endpoint implementing the OpenAI embeddings API. */
export class OpenAICompatibleEmbedder implements EmbeddingClient {
  readonly id: string;
  constructor(private readonly options: { provider: string; model: string; baseURL: string; apiKey?: string }) {
    this.id = `${options.provider}:${options.model}:${endpointKey(options.baseURL)}`;
  }

  async embed(texts: string[], purpose: "query" | "document", signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    const headers: Record<string, string> = this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {};
    for (let i = 0; i < texts.length; i += BATCH) {
      const input = prefixed(this.options.model, texts.slice(i, i + BATCH), purpose);
      const body = (await postJson(`${this.options.baseURL.replace(/\/$/, "")}/embeddings`, { model: this.options.model, input, encoding_format: "float" }, headers, signal, `${this.options.provider} embeddings (${this.options.model})`)) as { data?: { embedding: number[]; index: number }[] };
      if (!Array.isArray(body.data) || body.data.length !== input.length) throw new ModelError(`${this.options.provider} returned no embeddings.`, "server");
      out.push(...[...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  }
}

/**
 * The configured embedding model. Defaults to Ollama with embeddinggemma.
 * SOCRATES_EMBEDDINGS_PROVIDER: ollama | openrouter | openai | custom;
 * SOCRATES_EMBEDDINGS_MODEL; SOCRATES_EMBEDDINGS_URL (Ollama or custom base
 * URL); SOCRATES_EMBEDDINGS_API_KEY (custom endpoints).
 */
export function makeEmbedder(env: Record<string, string | undefined> = process.env): EmbeddingClient {
  const provider = env.SOCRATES_EMBEDDINGS_PROVIDER ?? EMBEDDING_DEFAULTS.provider;
  if (!["ollama", "openrouter", "openai", "custom"].includes(provider)) throw new Error(`Unknown embeddings provider "${provider}". Use ollama, openrouter, openai, or custom.`);
  const model = env.SOCRATES_EMBEDDINGS_MODEL ?? (provider === "ollama" ? EMBEDDING_DEFAULTS.model : undefined);
  if (!model) throw new Error(`SOCRATES_EMBEDDINGS_MODEL is required for the ${provider} embeddings provider.`);
  const key = (name: string) => {
    const value = env[name];
    if (!value) throw new ModelError(`Missing ${name} for ${provider} embeddings.`, "authentication");
    return value;
  };
  switch (provider) {
    case "ollama": return new OllamaEmbedder({ model, baseURL: env.SOCRATES_EMBEDDINGS_URL ?? EMBEDDING_DEFAULTS.ollamaURL });
    case "openrouter": return new OpenAICompatibleEmbedder({ provider, model, baseURL: "https://openrouter.ai/api/v1", apiKey: key("OPENROUTER_API_KEY") });
    case "openai": return new OpenAICompatibleEmbedder({ provider, model, baseURL: "https://api.openai.com/v1", apiKey: key("OPENAI_API_KEY") });
    default: {
      const baseURL = env.SOCRATES_EMBEDDINGS_URL;
      if (!baseURL) throw new Error("SOCRATES_EMBEDDINGS_URL is required for the custom embeddings provider.");
      return new OpenAICompatibleEmbedder({ provider, model, baseURL, ...(env.SOCRATES_EMBEDDINGS_API_KEY ? { apiKey: env.SOCRATES_EMBEDDINGS_API_KEY } : {}) });
    }
  }
}

/**
 * A deterministic offline embedder for tests: words are hashed into a fixed
 * number of dimensions, and words of one concept group share a dimension, so
 * paraphrases with no shared word can still be similar.
 */
export class HashEmbedder implements EmbeddingClient {
  readonly id: string;
  calls = 0;
  /** Set to make every request fail, as an unreachable server would. */
  failing = false;
  private readonly concept = new Map<string, string>();

  constructor(private readonly options: { dims?: number; concepts?: string[][]; id?: string; delayMs?: number } = {}) {
    this.id = options.id ?? "test:hash";
    for (const group of options.concepts ?? []) for (const word of group) this.concept.set(word.toLowerCase(), group[0]!.toLowerCase());
  }

  async embed(texts: string[], _purpose: "query" | "document", signal?: AbortSignal): Promise<number[][]> {
    this.calls++;
    if (this.options.delayMs) await new Promise((done) => setTimeout(done, this.options.delayMs));
    if (signal?.aborted) throw new ModelError("Embedding request was cancelled.", "aborted");
    if (this.failing) throw new ModelError("Test embedder is unreachable.", "network");
    const dims = this.options.dims ?? 256;
    return texts.map((text) => {
      const v = new Array<number>(dims).fill(0);
      for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        const word = this.concept.get(raw) ?? raw;
        const h = createHash("sha256").update(word).digest();
        v[h.readUInt32BE(0) % dims]! += h[4]! & 1 ? 1 : -1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

// Hash endpoint identity so URLs containing credentials are never exposed in diagnostics.
function endpointKey(url: string): string {
  return createHash("sha256").update(url.replace(/\/$/, "")).digest("hex");
}
