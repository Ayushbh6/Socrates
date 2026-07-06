import { beforeEach, describe, expect, it, vi } from "vitest"
import { chatCompactionSchema, readToolInputSchema, type ModelToolDefinition, type ProviderId, type RuntimeConfig } from "@socrates/contracts"
import { AiSdkProvider } from "../ai-sdk/AiSdkProvider"
import type { ModelEvent, ModelRequest } from "../types"

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  outputObject: vi.fn((input: unknown) => ({ type: "mock-output-object", input })),
  streamObject: vi.fn(),
  streamText: vi.fn(),
  smoothStream: vi.fn(() => ({ transform: "smooth" })),
}))

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return {
    ...actual,
    generateText: aiMocks.generateText,
    Output: {
      ...actual.Output,
      object: aiMocks.outputObject,
    },
    streamObject: aiMocks.streamObject,
    streamText: aiMocks.streamText,
    smoothStream: aiMocks.smoothStream,
  }
})

describe("AI SDK provider request shape", () => {
  beforeEach(() => {
    aiMocks.generateText.mockReset()
    aiMocks.outputObject.mockClear()
    aiMocks.streamObject.mockReset()
    aiMocks.streamText.mockReset()
    aiMocks.smoothStream.mockClear()
    aiMocks.generateText.mockResolvedValue({
      output: validStructuredOutput(),
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        inputTokenDetails: {},
        outputTokenDetails: {},
      },
      response: { id: "gen_structured_1" },
      warnings: [],
    })
    aiMocks.streamObject.mockReturnValue({
      object: Promise.resolve(validStructuredOutput()),
      usage: Promise.resolve({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        inputTokenDetails: {},
        outputTokenDetails: {},
      }),
      providerMetadata: Promise.resolve(undefined),
      response: Promise.resolve({ id: "stream_structured_1" }),
      warnings: Promise.resolve([]),
      fullStream: (async function* () {
        yield {
          type: "finish",
          finishReason: "stop",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            inputTokenDetails: {},
            outputTokenDetails: {},
          },
          response: { id: "stream_structured_1" },
          providerMetadata: undefined,
        }
      })(),
    })
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

  it("passes stable OpenAI prompt cache options for cache-affinity routing", async () => {
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
    expect(options.providerOptions?.openai?.promptCacheRetention).toBe("24h")
  })

  it("runs ChatGPT subscription OpenAI responses in stateless mode", async () => {
    const provider = new AiSdkProvider({
      getApiKey: () => undefined,
      resolveAuth: () => ({
        authMode: "chatgpt_subscription",
        apiKey: "dummy-chatgpt-subscription-key",
        fetch,
      }),
    })

    for await (const _event of provider.stream({
      ...modelRequest("openai", "gpt-5.5"),
      runtimeConfig: {
        ...runtimeConfig("openai", "gpt-5.5"),
        authMode: "chatgpt_subscription",
        thinkingEnabled: true,
        thinkingEffort: "medium",
      },
    })) {
      // Drain the mocked stream.
    }

    const options = aiMocks.streamText.mock.calls[0]?.[0] as { providerOptions?: Record<string, Record<string, unknown>> }
    expect(options.providerOptions?.openai).toMatchObject({
      store: false,
      reasoningEffort: "medium",
      reasoningSummary: "auto",
    })
    expect(options.providerOptions?.openai).not.toHaveProperty("promptCacheRetention")
  })

  it("renders ChatGPT subscription developer messages as wrapped user text", async () => {
    const provider = new AiSdkProvider({
      getApiKey: () => undefined,
      resolveAuth: () => ({
        authMode: "chatgpt_subscription",
        apiKey: "dummy-chatgpt-subscription-key",
        fetch,
      }),
    })

    for await (const _event of provider.stream({
      ...modelRequest("openai", "gpt-5.3-codex-spark"),
      runtimeConfig: {
        ...runtimeConfig("openai", "gpt-5.3-codex-spark"),
        authMode: "chatgpt_subscription",
        thinkingEnabled: true,
        thinkingEffort: "low",
      },
      messages: [
        { role: "user", content: "What date is today?" },
        {
          role: "developer",
          content: "<runtime_socrates_docs_preflight>\nRead project docs before workspace actions.\n</runtime_socrates_docs_preflight>",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "read",
              input: { path: "README.md" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "read",
              output: { ok: true, output: "README" },
            },
          ],
        },
        {
          role: "developer",
          content: "Runtime action ledger for this turn:\n- Recent actions: ok read {\"path\":\"README.md\"}.",
        },
      ],
    })) {
      // Drain the mocked stream.
    }

    const options = aiMocks.streamText.mock.calls[0]?.[0] as { messages?: Array<{ role?: string; content?: unknown }> }
    expect(options.messages?.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"])
    expect(JSON.stringify(options.messages)).not.toContain('"role":"system"')
    expect(JSON.stringify(options.messages)).not.toContain('"role":"developer"')
    expect(String(options.messages?.[0]?.content)).toContain("<runtime_socrates_developer_context>")
    expect(String(options.messages?.[3]?.content)).toContain("Runtime action ledger")
  })

  it("normalizes blank provider API errors into non-empty model failures", async () => {
    aiMocks.streamText.mockReturnValue({
      fullStream: (async function* () {
        const error = new Error("")
        Object.assign(error, {
          name: "AI_APICallError",
          statusCode: 400,
          responseBody: "{\"detail\":\"Store must be set to false\"}",
        })
        yield { type: "error", error }
      })(),
    })
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })

    const events: ModelEvent[] = []
    for await (const event of provider.stream(modelRequest("openai", "gpt-5.5"))) {
      events.push(event)
    }

    const failed = events.find((event): event is Extract<ModelEvent, { type: "model.failed" }> => event.type === "model.failed")
    expect(failed?.error.message).toBe("Model provider failed: Store must be set to false")
  })

  it("shortens long OpenAI prompt cache keys to provider-safe stable values", async () => {
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })
    const longCacheKey = "project:proj_638aa7f40bd644e3b7db957a2fb923db:conversation:conv_61dd66756d684f18bc939ab9c56a8a5e"

    for await (const _event of provider.stream({
      ...modelRequest("openai", "gpt-5.4-mini"),
      sessionId: "sess_1",
      cacheKey: longCacheKey,
    })) {
      // Drain the mocked stream.
    }

    const options = aiMocks.streamText.mock.calls[0]?.[0] as { providerOptions?: Record<string, Record<string, unknown>> }
    const promptCacheKey = options.providerOptions?.openai?.promptCacheKey
    expect(typeof promptCacheKey).toBe("string")
    expect(promptCacheKey).not.toBe(longCacheKey)
    expect((promptCacheKey as string).length).toBeLessThanOrEqual(64)
    expect(promptCacheKey).toMatch(/^socrates_[a-f0-9]{48}$/)
  })

  it.each([
    ["gpt-5", "none", "minimal"],
    ["gpt-5", "xhigh", "high"],
    ["gpt-5.4", "minimal", "low"],
    ["gpt-5.4-mini", "none", "none"],
    ["gpt-5.4-mini", "xhigh", "xhigh"],
  ] as const)("normalizes OpenAI reasoning effort %s %s -> %s", async (modelId, requestedEffort, expectedEffort) => {
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })

    for await (const _event of provider.stream({
      ...modelRequest("openai", modelId),
      runtimeConfig: {
        ...runtimeConfig("openai", modelId),
        thinkingEnabled: requestedEffort !== "none",
        thinkingEffort: requestedEffort,
      },
    })) {
      // Drain the mocked stream.
    }

    const options = aiMocks.streamText.mock.calls[0]?.[0] as { providerOptions?: Record<string, Record<string, unknown>> }
    expect(options.providerOptions?.openai?.reasoningEffort).toBe(expectedEffort)
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
            "<runtime_docs_sync_checkpoint>\nBefore final answer, close the Socrates docs loop. If durable state changed, update project_docs or repo_docs now.\n</runtime_docs_sync_checkpoint>",
        },
      ],
    })) {
      // Drain the mocked stream.
    }

    const options = aiMocks.streamText.mock.calls[0]?.[0] as { messages?: Array<{ role?: string; content?: unknown }> }
    expect(options.messages?.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"])
    expect(options.messages?.slice(1).some((message) => message.role === "system")).toBe(false)
    expect(options.messages?.[3]?.content).toContain("[developer]\n<runtime_docs_sync_checkpoint>")
  })

  it("merges trailing OpenRouter developer messages into the latest user message", async () => {
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })

    for await (const _event of provider.stream({
      ...modelRequest("openrouter", "deepseek/deepseek-v4-pro"),
      messages: [
        { role: "user", content: "hi" },
        {
          role: "developer",
          content:
            "<runtime_socrates_docs_preflight>\nRead project docs before workspace actions.\n</runtime_socrates_docs_preflight>",
        },
      ],
    })) {
      // Drain the mocked stream.
    }

    const options = aiMocks.streamText.mock.calls[0]?.[0] as { messages?: Array<{ role?: string; content?: unknown }> }
    expect(options.messages).toEqual([
      {
        role: "user",
        content:
          "hi\n\n<runtime_socrates_developer_context>\nThe following is Socrates runtime guidance, not user-authored content.\n<runtime_socrates_docs_preflight>\nRead project docs before workspace actions.\n</runtime_socrates_docs_preflight>\n</runtime_socrates_developer_context>",
      },
    ])
    expect(JSON.stringify(options.messages)).not.toContain('"role":"system"')
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

  it("uses generateText with Output.object for structured generation", async () => {
    const provider = new AiSdkProvider({
      getApiKey: () => "test-key",
    })

    const result = await provider.generateStructured?.({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      system: "Compress context.",
      messages: [{ role: "user", content: "Old turns" }],
      runtimeConfig: runtimeConfig("openai", "gpt-5.4-mini"),
      schema: chatCompactionSchema,
    })

    expect(aiMocks.outputObject).toHaveBeenCalledWith({ schema: chatCompactionSchema })
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1)
    const options = aiMocks.generateText.mock.calls[0]?.[0] as {
      system?: string
      messages?: unknown[]
      output?: unknown
      tools?: unknown
    }
    expect(options.system).toBe("Compress context.")
    expect(options.messages).toEqual([{ role: "user", content: "Old turns" }])
    expect(options.output).toEqual({ type: "mock-output-object", input: { schema: chatCompactionSchema } })
    expect(options).not.toHaveProperty("tools")
    expect(result?.output).toEqual(validStructuredOutput())
    expect(result?.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })
  })

  it("streams structured ChatGPT subscription generations", async () => {
    const provider = new AiSdkProvider({
      getApiKey: () => undefined,
      resolveAuth: () => ({
        authMode: "chatgpt_subscription",
        apiKey: "dummy-chatgpt-subscription-key",
        fetch,
      }),
    })

    const result = await provider.generateStructured?.({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      system: "Compress context.",
      messages: [{ role: "user", content: "Old turns" }],
      runtimeConfig: {
        ...runtimeConfig("openai", "gpt-5.4-mini"),
        authMode: "chatgpt_subscription",
      },
      schema: chatCompactionSchema,
    })

    expect(aiMocks.generateText).not.toHaveBeenCalled()
    expect(aiMocks.streamObject).toHaveBeenCalledTimes(1)
    const options = aiMocks.streamObject.mock.calls[0]?.[0] as {
      system?: string
      messages?: unknown[]
      schema?: unknown
      providerOptions?: Record<string, Record<string, unknown>>
    }
    expect(options.system).toBe("Compress context.")
    expect(options.messages).toEqual([{ role: "user", content: "Old turns" }])
    expect(options.schema).toBe(chatCompactionSchema)
    expect(options.providerOptions?.openai).toMatchObject({ store: false })
    expect(options.providerOptions?.openai).not.toHaveProperty("promptCacheRetention")
    expect(result?.output).toEqual(validStructuredOutput())
    expect(result?.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })
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

const validStructuredOutput = () => ({
  schemaVersion: 1 as const,
  goal: "Compress context.",
  constraints: [],
  done: ["Structured output used."],
  inProgress: [],
  blocked: [],
  decisions: [],
  nextSteps: [],
  criticalContext: [],
  relevantFiles: [],
  toolState: [],
  anchors: ["Turn 1: inspect structured output source."],
})
