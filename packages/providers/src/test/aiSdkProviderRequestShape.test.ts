import { beforeEach, describe, expect, it, vi } from "vitest"
import { readToolInputSchema, type ModelToolDefinition, type ProviderId, type RuntimeConfig } from "@socrates/contracts"
import { AiSdkProvider } from "../ai-sdk/AiSdkProvider"
import type { ModelRequest } from "../types"

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  smoothStream: vi.fn(() => ({ transform: "smooth" })),
}))

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return {
    ...actual,
    streamText: aiMocks.streamText,
    smoothStream: aiMocks.smoothStream,
  }
})

describe("AI SDK provider request shape", () => {
  beforeEach(() => {
    aiMocks.streamText.mockReset()
    aiMocks.smoothStream.mockClear()
    aiMocks.streamText.mockReturnValue({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop", totalUsage: undefined }
      })(),
    })
  })

  it.each([
    ["openrouter", "x-ai/grok-build-0.1"],
    ["openai", "gpt-5.4-mini"],
    ["google", "gemini-3-flash-preview"],
  ] satisfies Array<[ProviderId, string]>)("passes native image parts and tools together for %s", async (providerId, modelId) => {
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })

    for await (const _event of provider.stream(modelRequest(providerId, modelId))) {
      // Drain the mocked stream.
    }

    expect(aiMocks.streamText).toHaveBeenCalledTimes(1)
    const options = aiMocks.streamText.mock.calls[0]?.[0] as {
      messages?: unknown[]
      tools?: Record<string, unknown>
      toolChoice?: unknown
      activeTools?: unknown
    }

    expect(options.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this screenshot? Use tools if needed." },
          { type: "image", mediaType: "image/png", image: "iVBORw==" },
        ],
      },
    ])
    expect(Object.keys(options.tools ?? {})).toEqual(["read"])
    expect(options).not.toHaveProperty("toolChoice")
    expect(options).not.toHaveProperty("activeTools")
  })
})

const readTool: ModelToolDefinition = {
  name: "read",
  description: "Read a project file.",
  inputSchema: readToolInputSchema,
}

const modelRequest = (providerId: ProviderId, modelId: string): ModelRequest => ({
  providerId,
  modelId,
  system: "You are a tool-using vision agent.",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this screenshot? Use tools if needed." },
        { type: "image", mediaType: "image/png", data: "data:image/png;base64,iVBORw==" },
      ],
    },
  ],
  runtimeConfig: runtimeConfig(providerId, modelId),
  tools: [readTool],
})

const runtimeConfig = (providerId: ProviderId, modelId: string): RuntimeConfig => ({
  providerId,
  modelId,
  thinkingEnabled: false,
  thinkingEffort: "none",
  approvalMode: "manual",
  sandboxMode: "workspace_write",
})
