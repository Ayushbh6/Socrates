import { describe, expect, it } from "vitest"
import {
  chunkMarkdown,
  embeddingFingerprint,
  rankDistinctParents,
  retrievalChunkId,
  sha256Hex,
} from "../retrieval"

describe("shared retrieval foundation", () => {
  it("chunks Markdown deterministically with bounded token-aware overlap", () => {
    const markdown = `# Retrieval\n\n${"alpha beta gamma delta ".repeat(220)}\n\n## Next\n\n${"epsilon zeta eta theta ".repeat(120)}`
    const first = chunkMarkdown(markdown, { targetTokens: 120, overlapTokens: 30 })
    const second = chunkMarkdown(markdown, { targetTokens: 120, overlapTokens: 30 })
    expect(first.length).toBeGreaterThan(3)
    expect(first).toEqual(second)
    expect(first.every((chunk) => chunk.tokenCount <= 120)).toBe(true)
    expect(first.some((chunk) => chunk.content.includes("# Retrieval"))).toBe(true)
    const chunkIds = first.map((chunk) =>
      retrievalChunkId({
        corpusKind: "trace_turn",
        parentId: "turn_1",
        discriminator: "user",
        chunkIndex: chunk.chunkIndex,
        contentHash: chunk.contentHash,
      }),
    )
    expect(new Set(chunkIds).size).toBe(first.length)
  })

  it("handles fenced code and Unicode without losing content", () => {
    const markdown = "## Example\n\n```ts\nconst greeting = 'नमस्ते';\n```\n\nA precise explanation follows."
    const chunks = chunkMarkdown(markdown, { targetTokens: 80, overlapTokens: 10 })
    expect(chunks.map((chunk) => chunk.content).join("\n")).toContain("const greeting")
    expect(chunks.map((chunk) => chunk.content).join("\n")).toContain("नमस्ते")
  })

  it("builds stable content, embedding, and chunk identities", () => {
    const contentHash = sha256Hex("slow mode")
    expect(embeddingFingerprint({ providerId: "ollama", modelId: "embeddinggemma:latest", dimensions: 768, contentHash })).toBe(
      embeddingFingerprint({ providerId: "ollama", modelId: "embeddinggemma:latest", dimensions: 768, contentHash }),
    )
    expect(retrievalChunkId({ corpusKind: "memory_section", parentId: "user_profile:collaboration_style", discriminator: "section", chunkIndex: 0, contentHash })).toHaveLength(64)
  })

  it("keeps one best chunk per parent and uses recency only inside the score band", () => {
    const ranked = rankDistinctParents([
      { chunkId: "a1", parentId: "a", content: "old best", rawScore: 0.91, normalizedScore: 0.91, occurredAt: "2026-01-01T00:00:00Z", metadata: {} },
      { chunkId: "a2", parentId: "a", content: "duplicate", rawScore: 0.7, normalizedScore: 0.7, occurredAt: "2026-07-01T00:00:00Z", metadata: {} },
      { chunkId: "b1", parentId: "b", content: "new close", rawScore: 0.88, normalizedScore: 0.88, occurredAt: "2026-07-01T00:00:00Z", metadata: {} },
      { chunkId: "c1", parentId: "c", content: "new far", rawScore: 0.7, normalizedScore: 0.7, occurredAt: "2026-07-10T00:00:00Z", metadata: {} },
    ])
    expect(ranked.map((result) => result.parentId)).toEqual(["b", "a", "c"])
    expect(ranked.find((result) => result.parentId === "a")?.content).toBe("old best")
    expect(ranked[0]?.recencyReordered).toBe(true)
  })
})
