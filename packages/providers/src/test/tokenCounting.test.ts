import { readToolInputSchema } from "@socrates/contracts"
import { describe, expect, it } from "vitest"
import { AiSdkProvider } from "../ai-sdk/AiSdkProvider"
import {
  DEFAULT_TOKEN_SAFETY_MARGIN_PERCENT,
  countModelRequestLocally,
  estimateTextTokens,
  shouldUseProviderExactCount,
} from "../tokenCounting"
import type { ModelRequest } from "../types"

const baseRequest = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  providerId: "openai",
  modelId: "gpt-5.4-mini",
  system: "You are Socrates.",
  messages: [
    { role: "user", content: "Read the README." },
    { role: "assistant", content: [{ type: "text", text: "I will inspect it." }] },
  ],
  runtimeConfig: {
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    thinkingEnabled: false,
    thinkingEffort: "none",
    approvalMode: "manual",
    sandboxMode: "read_only",
  },
  ...overrides,
})

describe("provider token counting", () => {
  it("counts text with the local js-tiktoken tokenizer", () => {
    const result = estimateTextTokens("hello world", { applySafetyMargin: false, modelId: "gpt-5.4-mini", providerId: "openai" })

    expect(result.baseTokens).toBeGreaterThan(0)
    expect(result.inputTokens).toBe(result.baseTokens)
    expect(result.method).toBe("local_tiktoken")
    expect(result.safetyMarginPercent).toBe(0)
  })

  it("applies the safety margin for fallback tokenizer methods", () => {
    const result = countModelRequestLocally(
      baseRequest({
        providerId: "openrouter",
        modelId: "unknown/model",
        runtimeConfig: {
          providerId: "openrouter",
          modelId: "unknown/model",
          thinkingEnabled: false,
          thinkingEffort: "none",
          approvalMode: "manual",
          sandboxMode: "read_only",
        },
      }),
    )

    expect(result.inputTokens).toBe(Math.ceil(result.baseTokens * 1.15))
    expect(result.safetyMarginPercent).toBe(DEFAULT_TOKEN_SAFETY_MARGIN_PERCENT)
    expect(result.method).toBe("local_tiktoken_with_margin")
    expect(result.warnings?.join("\n")).toContain("No exact tokenizer mapping")
  })

  it("does not apply a safety margin for known OpenAI tokenizer mappings", () => {
    const result = countModelRequestLocally(baseRequest())

    expect(result.inputTokens).toBe(result.baseTokens)
    expect(result.safetyMarginPercent).toBe(0)
    expect(result.method).toBe("local_tiktoken")
  })

  it("includes system prompt, messages, tool calls, tool results, and tool schemas", () => {
    const withoutTools = countModelRequestLocally(baseRequest({ messages: [{ role: "user", content: "Hi" }] }))
    const withToolsAndResults = countModelRequestLocally(
      baseRequest({
        messages: [
          { role: "user", content: "Read README.md" },
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "call_read", toolName: "read", input: { path: "README.md" } }],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_read",
                toolName: "read",
                output: { path: "README.md", content: "Socrates token accounting", truncation: { truncated: false } },
              },
            ],
          },
        ],
        tools: [
          {
            name: "read",
            description: "Read a file from the workspace.",
            inputSchema: readToolInputSchema,
          },
        ],
      }),
    )

    expect(withToolsAndResults.baseTokens).toBeGreaterThan(withoutTools.baseTokens)
  })

  it("identifies near-threshold counts for provider-exact counting", () => {
    expect(shouldUseProviderExactCount(86, [100])).toBe(true)
    expect(shouldUseProviderExactCount(116, [100])).toBe(false)
    expect(shouldUseProviderExactCount(40, [100])).toBe(false)
  })

  it("returns fallback metadata when Google exact counting is unavailable", async () => {
    const previousGoogleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    const previousGeminiKey = process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      const provider = new AiSdkProvider()
      const request = baseRequest({
        providerId: "google",
        modelId: "gemini-3-flash-preview",
        runtimeConfig: {
          providerId: "google",
          modelId: "gemini-3-flash-preview",
          thinkingEnabled: false,
          thinkingEffort: "none",
          approvalMode: "manual",
          sandboxMode: "read_only",
        },
      })
      const local = countModelRequestLocally(request)
      const result = await provider.countTokens({ ...request, countTokens: { exactThresholds: [local.inputTokens] } })

      expect(result.inputTokens).toBeGreaterThan(0)
      expect(result.providerExactAttempted).toBe(false)
      expect(result.warnings?.join("\n")).toContain("Google exact token counting skipped")
    } finally {
      if (previousGoogleKey === undefined) {
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
      } else {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousGoogleKey
      }
      if (previousGeminiKey === undefined) {
        delete process.env.GEMINI_API_KEY
      } else {
        process.env.GEMINI_API_KEY = previousGeminiKey
      }
    }
  })

  it("does not attempt Google exact counting for tool-bearing requests it cannot map losslessly", async () => {
    const previousGoogleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    const previousFetch = globalThis.fetch
    let fetchCalled = false
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key"
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error("fetch should not be called")
    }) as typeof fetch
    try {
      const provider = new AiSdkProvider()
      const request = baseRequest({
        providerId: "google",
        modelId: "gemini-3-flash-preview",
        runtimeConfig: {
          providerId: "google",
          modelId: "gemini-3-flash-preview",
          thinkingEnabled: false,
          thinkingEffort: "none",
          approvalMode: "manual",
          sandboxMode: "read_only",
        },
        tools: [{ name: "read", description: "Read a file.", inputSchema: readToolInputSchema }],
      })
      const local = countModelRequestLocally(request)
      const result = await provider.countTokens({ ...request, countTokens: { exactThresholds: [local.inputTokens] } })

      expect(fetchCalled).toBe(false)
      expect(result.providerExactAttempted).toBe(false)
      expect(result.warnings?.join("\n")).toContain("tool definitions")
    } finally {
      if (previousGoogleKey === undefined) {
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
      } else {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousGoogleKey
      }
      globalThis.fetch = previousFetch
    }
  })
})
