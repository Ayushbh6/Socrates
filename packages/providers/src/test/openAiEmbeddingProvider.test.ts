import { getEncoding } from "js-tiktoken"
import { describe, expect, it } from "vitest"
import { OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET, prepareOpenAiEmbeddingInput } from "../embeddings/OpenAiEmbeddingProvider"

describe("OpenAI embedding provider", () => {
  it("caps embedding inputs below the OpenAI per-input token limit", () => {
    const encoder = getEncoding("cl100k_base")
    const oversized = " token".repeat(OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET + 500)
    const prepared = prepareOpenAiEmbeddingInput(oversized)

    expect(encoder.encode(prepared).length).toBeLessThanOrEqual(OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET)
  })

  it("leaves short embedding inputs unchanged", () => {
    const value = "Socrates embedding check"

    expect(prepareOpenAiEmbeddingInput(value)).toBe(value)
  })
})
