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
        json: async () => ({ models: [{ name: "embeddinggemma" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
      }) as typeof fetch

    const provider = new OllamaEmbeddingProvider()
    const result = await provider.check({ providerId: "ollama", modelId: "embeddinggemma" })

    expect(result).toMatchObject({ ok: true, dimensions: 3 })
    expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:11434/api/tags", {})
  })

  it("reports missing local models with setup guidance", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "nomic-embed-text" }] }),
    }) as typeof fetch

    const provider = new OllamaEmbeddingProvider()
    const result = await provider.check({ providerId: "ollama", modelId: "embeddinggemma" })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("ollama pull embeddinggemma")
  })
})
