import { type IncomingMessage, createServer } from "node:http";
import { ModelError } from "@socrates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { HashEmbedder, OllamaEmbedder, OpenAICompatibleEmbedder, makeEmbedder } from "../src";

const servers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!();
});

/** A local HTTP server that records request bodies and answers with the handler's status and JSON. */
async function serve(handler: (path: string, body: any, headers: IncomingMessage["headers"]) => { status?: number; json: unknown }) {
  const seen: { path: string; body: any; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ path: req.url!, body, headers: req.headers });
      const out = handler(req.url!, body, req.headers);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(() => new Promise<void>((done) => server.close(() => done())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

describe("embedding clients", () => {
  it("Ollama: embeddinggemma's query and document prefixes, batches of 32, truncation on", async () => {
    const { url, seen } = await serve((_, body) => ({ json: { embeddings: body.input.map((_: string, i: number) => [i, 1]) } }));
    const e = new OllamaEmbedder({ model: "embeddinggemma", baseURL: url });
    expect(e.id).toBe("ollama:embeddinggemma");
    expect(await e.embed(["where is the cart bug"], "query")).toEqual([[0, 1]]);
    expect(seen[0]).toMatchObject({ path: "/api/embed", body: { model: "embeddinggemma", input: ["task: search result | query: where is the cart bug"], truncate: true } });
    const docs = Array.from({ length: 40 }, (_, i) => `doc ${i}`);
    expect(await e.embed(docs, "document")).toHaveLength(40);
    expect(seen.slice(1).map((s) => s.body.input.length)).toEqual([32, 8]);
    expect(seen[1]!.body.input[0]).toBe("title: none | text: doc 0");
  });

  it("OpenAI-compatible: bearer key, results reordered by index, no prefix for unknown models", async () => {
    const { url, seen } = await serve((_, body) => ({ json: { data: body.input.map((_: string, i: number) => ({ index: i, embedding: [i] })).reverse() } }));
    const e = new OpenAICompatibleEmbedder({ provider: "custom", model: "text-embedding-3-small", baseURL: `${url}/v1/`, apiKey: "test-key" });
    expect(await e.embed(["a", "b", "c"], "document")).toEqual([[0], [1], [2]]);
    expect(seen[0]).toMatchObject({ path: "/v1/embeddings", body: { model: "text-embedding-3-small", input: ["a", "b", "c"], encoding_format: "float" } });
    expect(seen[0]!.headers.authorization).toBe("Bearer test-key");
  });

  it("maps failures to model errors without leaking more than a bounded detail", async () => {
    const { url } = await serve((path) => ({ status: path.includes("auth") ? 401 : 500, json: { error: "x".repeat(1_000) } }));
    const failing = new OllamaEmbedder({ model: "embeddinggemma", baseURL: url });
    const error = await failing.embed(["q"], "query").catch((e) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error.kind).toBe("server");
    expect(error.message.length).toBeLessThan(400);
    const auth = await new OpenAICompatibleEmbedder({ provider: "custom", model: "m", baseURL: `${url}/auth` }).embed(["q"], "query").catch((e) => e);
    expect(auth.kind).toBe("authentication");
    const offline = await new OllamaEmbedder({ model: "embeddinggemma", baseURL: "http://127.0.0.1:9" }).embed(["q"], "query").catch((e) => e);
    expect(offline.kind).toBe("network");
  });

  it("defaults to local Ollama embeddinggemma and is configured like the chat models", () => {
    expect(makeEmbedder({}).id).toBe("ollama:embeddinggemma");
    expect(makeEmbedder({ SOCRATES_EMBEDDINGS_MODEL: "nomic-embed-text" }).id).toBe("ollama:nomic-embed-text");
    expect(makeEmbedder({ SOCRATES_EMBEDDINGS_PROVIDER: "openrouter", SOCRATES_EMBEDDINGS_MODEL: "openai/text-embedding-3-small", OPENROUTER_API_KEY: "k" }).id).toBe("openrouter:openai/text-embedding-3-small");
    expect(makeEmbedder({ SOCRATES_EMBEDDINGS_PROVIDER: "custom", SOCRATES_EMBEDDINGS_MODEL: "m", SOCRATES_EMBEDDINGS_URL: "http://localhost:1234/v1" }).id).toBe("custom:m");
    expect(() => makeEmbedder({ SOCRATES_EMBEDDINGS_PROVIDER: "openrouter", SOCRATES_EMBEDDINGS_MODEL: "m" })).toThrow("Missing OPENROUTER_API_KEY");
    expect(() => makeEmbedder({ SOCRATES_EMBEDDINGS_PROVIDER: "openai" })).toThrow("SOCRATES_EMBEDDINGS_MODEL is required");
    expect(() => makeEmbedder({ SOCRATES_EMBEDDINGS_PROVIDER: "custom", SOCRATES_EMBEDDINGS_MODEL: "m" })).toThrow("SOCRATES_EMBEDDINGS_URL is required");
    expect(() => makeEmbedder({ SOCRATES_EMBEDDINGS_PROVIDER: "elsewhere" })).toThrow("Unknown embeddings provider");
  });

  it("the test embedder is deterministic, normalised, and treats a concept group as one meaning", async () => {
    const e = new HashEmbedder({ concepts: [["cart", "basket"]] });
    const [a, b, c] = await e.embed(["cart", "basket", "garden"], "document");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(Math.hypot(...a!)).toBeCloseTo(1);
  });
});
