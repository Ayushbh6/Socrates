import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { listOllamaChatModels, OllamaChatProvider } from "../ollama/OllamaChatProvider"
import type { ModelEvent, ModelRequest } from "../types"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe("Ollama chat provider", () => {
  it("discovers installed chat models without pulling or listing embedding-only models", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "embeddinggemma:latest" }, { name: "qwen3.5:4b" }, { name: "glm-ocr:latest" }] }))
      .mockResolvedValueOnce(jsonResponse({ capabilities: ["embedding"], details: { context_length: 2048 } }))
      .mockResolvedValueOnce(jsonResponse({ capabilities: ["completion", "tools"], model_info: { "qwen3.context_length": 32768 } }))
      .mockResolvedValueOnce(jsonResponse({ capabilities: ["completion", "vision"], details: { context_length: 8192 } })) as typeof fetch

    const result = await listOllamaChatModels()

    expect(result.reachable).toBe(true)
    expect(result.models.map((model) => model.modelId)).toEqual(["qwen3.5:4b", "glm-ocr:latest"])
    expect(result.models[0]).toMatchObject({
      providerId: "ollama",
      providerLabel: "Ollama Local",
      capabilities: { vision: false },
      contextWindowTokens: 32768,
      thinkingOptions: [
        { id: "off", enabled: false },
        { id: "on", enabled: true },
      ],
      defaultThinkingOptionId: "off",
    })
    expect(result.models[1]?.capabilities?.vision).toBe(true)
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/pull",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("streams answer, tool call, reasoning, and local usage events", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      ndjsonResponse([
        { message: { thinking: "checking " } },
        { message: { content: "Hi there" } },
        { message: { tool_calls: [{ function: { name: "current_time", arguments: {} } }] } },
        { done: true, prompt_eval_count: 9, eval_count: 3 },
      ]),
    ) as typeof fetch

    const provider = new OllamaChatProvider()
    const events: ModelEvent[] = []
    for await (const event of provider.stream(modelRequest())) {
      events.push(event)
    }

    expect(events.map((event) => event.type)).toEqual([
      "model.started",
      "model.reasoning.delta",
      "model.answer.delta",
      "model.tool_call.completed",
      "model.reasoning.completed",
      "model.usage",
      "model.completed",
    ])
    expect(events.find((event) => event.type === "model.answer.delta")).toMatchObject({ text: "Hi there" })
    expect(events.find((event) => event.type === "model.tool_call.completed")).toMatchObject({
      toolCall: { toolName: "current_time", input: {} },
    })
    expect(events.find((event) => event.type === "model.usage")).toMatchObject({
      usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12, routedProvider: "ollama", costSource: "unknown" },
    })
  })

  it("generates structured output with Ollama JSON schema format", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: { content: "{\"answer\":\"ok\"}" }, prompt_eval_count: 5, eval_count: 2 }))
    globalThis.fetch = fetchMock as typeof fetch

    const provider = new OllamaChatProvider()
    const result = await provider.generateStructured<{ answer: string }>({
      ...modelRequest(),
      schema: z.object({ answer: z.string() }),
    })

    expect(result.output).toEqual({ answer: "ok" })
    expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, routedProvider: "ollama", costSource: "unknown" })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({
      model: "qwen3.5:4b",
      stream: false,
      think: true,
    })
    expect(body.format).toMatchObject({
      type: "object",
      properties: { answer: { type: "string" } },
    })
  })
})

const modelRequest = (): ModelRequest => ({
  providerId: "ollama",
  modelId: "qwen3.5:4b",
  system: "You are Socrates.",
  messages: [{ role: "user", content: "say hi" }],
  runtimeConfig: {
    providerId: "ollama",
    authMode: "api_key",
    modelId: "qwen3.5:4b",
    thinkingEnabled: true,
    approvalMode: "manual",
    sandboxMode: "workspace_write",
  },
  tools: [{ name: "current_time", description: "Get current time.", inputSchema: z.object({}).strict() }],
})

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const ndjsonResponse = (values: unknown[]): Response =>
  new Response(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  })
