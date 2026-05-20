import { describe, expect, it } from "vitest"
import { createOpenRouterProviderOptions } from "../ai-sdk/AiSdkProvider"
import type { ModelRequest } from "../types"

const baseRequest = (thinkingEnabled: boolean): ModelRequest => ({
  providerId: "openrouter",
  modelId: "z-ai/glm-5.1",
  system: "You are Socrates.",
  messages: [{ role: "user", content: "Hello" }],
  runtimeConfig: {
    providerId: "openrouter",
    modelId: "z-ai/glm-5.1",
    thinkingEnabled,
    approvalMode: "manual",
    sandboxMode: "read_only",
  },
})

describe("OpenRouter provider options", () => {
  it("explicitly disables and excludes reasoning when thinking is off", () => {
    expect(createOpenRouterProviderOptions(baseRequest(false))).toEqual({
      openrouter: {
        usage: { include: true },
        reasoning: { effort: "none", exclude: true },
      },
    })
  })

  it("enables returned reasoning when thinking is on", () => {
    expect(createOpenRouterProviderOptions(baseRequest(true))).toEqual({
      openrouter: {
        usage: { include: true },
        reasoning: { enabled: true, exclude: false },
      },
    })
  })
})
