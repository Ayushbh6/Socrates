import { beforeEach, describe, expect, it, vi } from "vitest"
import { readToolInputSchema, type ModelToolDefinition, type ProviderId, type RuntimeConfig } from "@socrates/contracts"
import { AiSdkProvider } from "../ai-sdk/AiSdkProvider"
import type { ModelEvent, ModelRequest } from "../types"

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

  it("passes a stable OpenAI prompt cache key for cache-affinity routing", async () => {
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })

    for await (const _event of provider.stream({
      ...modelRequest("openai", "gpt-5.4-mini"),
      sessionId: "sess_1",
      cacheKey: "project:proj_1:conversation:conv_1",
    })) {
      // Drain the mocked stream.
    }

    const options = aiMocks.streamText.mock.calls[0]?.[0] as { providerOptions?: Record<string, Record<string, unknown>> }
    expect(options.providerOptions?.openai?.promptCacheKey).toBe("project:proj_1:conversation:conv_1")
  })

  it("leaves Gemini on implicit caching and does not create explicit cache resources", async () => {
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })

    for await (const _event of provider.stream({
      ...modelRequest("google", "gemini-3-flash-preview"),
      sessionId: "sess_1",
      cacheKey: "project:proj_1:conversation:conv_1",
      runtimeConfig: {
        ...runtimeConfig("google", "gemini-3-flash-preview"),
        thinkingEnabled: true,
        thinkingEffort: "low",
      },
    })) {
      // Drain the mocked stream.
    }

    const options = aiMocks.streamText.mock.calls[0]?.[0] as { providerOptions?: Record<string, Record<string, unknown>> }
    expect(options.providerOptions?.google).toEqual({
      thinkingConfig: {
        thinkingLevel: "low",
        includeThoughts: true,
      },
    })
    expect(JSON.stringify(options.providerOptions)).not.toContain("cachedContent")
  })

  it("renders late Socrates developer messages as user text for Gemini continuations", async () => {
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })

    for await (const _event of provider.stream({
      ...modelRequest("google", "gemini-3.1-pro-preview"),
      messages: [
        { role: "user", content: "Create the PDF." },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "search",
              input: { query: "exercise 10", path: "DBMS" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "search",
              output: { ok: true, output: { matches: [{ path: "DBMS/exercise10_en.pdf" }] } },
            },
          ],
        },
        {
          role: "developer",
          content:
            "Quiet backend reminder: if this turn changed durable repo behavior, inspect/update `.socrates/repo_docs/` before the final answer.",
        },
      ],
    })) {
      // Drain the mocked stream.
    }

    const options = aiMocks.streamText.mock.calls[0]?.[0] as { messages?: Array<{ role?: string; content?: unknown }> }
    expect(options.messages?.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"])
    expect(options.messages?.slice(1).some((message) => message.role === "system")).toBe(false)
    expect(options.messages?.[3]?.content).toContain("[developer]\nQuiet backend reminder")
  })

  it("emits completed OpenAI reasoning metadata before tool calls", async () => {
    aiMocks.streamText.mockReturnValue({
      fullStream: (async function* () {
        yield {
          type: "reasoning-start",
          id: "rs_1:0",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        }
        yield {
          type: "reasoning-delta",
          id: "rs_1:0",
          text: "Need to inspect.",
          providerMetadata: { openai: { itemId: "rs_1" } },
        }
        yield {
          type: "reasoning-end",
          id: "rs_1:0",
          providerMetadata: { openai: { itemId: "rs_1" } },
        }
        yield {
          type: "tool-call",
          toolCallId: "fc_1",
          toolName: "read",
          input: { path: "README.md" },
          providerMetadata: { openai: { itemId: "fc_item_1" } },
        }
        yield { type: "finish", finishReason: "tool-calls", totalUsage: undefined }
      })(),
    })
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })

    const events: ModelEvent[] = []
    for await (const event of provider.stream({
      ...modelRequest("openai", "gpt-5.4-mini"),
      runtimeConfig: {
        ...runtimeConfig("openai", "gpt-5.4-mini"),
        thinkingEnabled: true,
        thinkingEffort: "low",
      },
    })) {
      events.push(event)
    }

    expect(events.map((event) => event.type)).toEqual([
      "model.started",
      "model.reasoning.delta",
      "model.reasoning.completed",
      "model.tool_call.completed",
      "model.completed",
    ])
    expect(events[2]).toMatchObject({
      type: "model.reasoning.completed",
      text: "Need to inspect.",
      providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
    })
    expect(events[3]).toMatchObject({
      type: "model.tool_call.completed",
      toolCall: {
        toolCallId: "fc_1",
        toolName: "read",
        input: { path: "README.md" },
        providerMetadata: { openai: { itemId: "fc_item_1" } },
      },
    })
  })

  it("emits provider response metadata for persistence", async () => {
    aiMocks.streamText.mockReturnValue({
      fullStream: (async function* () {
        yield {
          type: "response-metadata",
          id: "gen_123",
          modelId: "deepseek/deepseek-v4-flash",
          timestamp: new Date("2026-06-05T10:00:00.000Z"),
        }
        yield { type: "finish", finishReason: "stop", totalUsage: undefined }
      })(),
    })
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })

    const events: ModelEvent[] = []
    for await (const event of provider.stream(modelRequest("openrouter", "deepseek/deepseek-v4-flash"))) {
      events.push(event)
    }

    expect(events).toContainEqual({
      type: "model.response.metadata",
      response: {
        id: "gen_123",
        modelId: "deepseek/deepseek-v4-flash",
        timestamp: new Date("2026-06-05T10:00:00.000Z"),
      },
    })
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
