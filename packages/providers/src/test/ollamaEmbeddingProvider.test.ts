import { afterEach, describe, expect, it, vi } from "vitest"
import { OllamaEmbeddingProvider } from "../embeddings/OllamaEmbeddingProvider"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe("Ollama embedding provider", () => {
  it("checks model availability and returns dimensions without downloading models", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: "embeddinggemma:latest", model: "embeddinggemma:latest" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ capabilities: ["embedding"], details: { family: "bert", embedding_length: 768 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
      }) as typeof fetch

    const provider = new OllamaEmbeddingProvider()
    const result = await provider.check({ providerId: "ollama", modelId: "embeddinggemma" })

    expect(result).toMatchObject({ ok: true, dimensions: 3 })
    expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:11434/api/tags", {})
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/pull",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("reports missing local models with setup guidance", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: "nomic-embed-text" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ capabilities: ["embedding"] }),
      }) as typeof fetch

    const provider = new OllamaEmbeddingProvider()
    const result = await provider.check({ providerId: "ollama", modelId: "embeddinggemma" })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("ollama pull embeddinggemma")
  })

  it("lists installed model metadata and filters non-embedding capabilities", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: "embeddinggemma:latest", model: "embeddinggemma:latest", size: 623000000 },
            { name: "glm-ocr:latest", model: "glm-ocr:latest", size: 2200000000 },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ capabilities: ["embedding"], details: { family: "bert", parameter_size: "300M" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ capabilities: ["completion", "vision", "tools"], details: { family: "glmocr" } }),
      }) as typeof fetch

    const provider = new OllamaEmbeddingProvider()
    const result = await provider.listModels({ providerId: "ollama" })

    expect(result.models).toHaveLength(2)
    expect(result.models[0]).toMatchObject({ modelId: "embeddinggemma:latest", status: "embedding", embeddingCapable: true })
    expect(result.models[1]).toMatchObject({ modelId: "glm-ocr:latest", status: "not_embedding", embeddingCapable: false })
  })

  it("pulls exactly the requested model only when explicitly requested", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "success" }),
    }) as typeof fetch

    const provider = new OllamaEmbeddingProvider()
    const result = await provider.pullModel({ providerId: "ollama", modelId: "embeddinggemma:latest" })

    expect(result.ok).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/pull",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "embeddinggemma:latest", stream: false }),
      }),
    )
  })
})
