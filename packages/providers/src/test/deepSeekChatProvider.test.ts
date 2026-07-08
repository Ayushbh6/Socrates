import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  editToolModelInputSchema,
  mcpRegistryToolModelInputSchema,
  projectDocsToolModelInputSchema,
  repoDocsToolModelInputSchema,
  skillsToolModelInputSchema,
  traceRetrieveToolModelInputSchema,
} from "@socrates/contracts"
import { DeepSeekChatProvider } from "../deepseek/DeepSeekChatProvider"
import type { ModelEvent, ModelRequest, ProviderCredentialResolver } from "../types"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe("DeepSeek chat provider", () => {
  it("streams reasoning, answer, tool calls, and cache-aware usage through the native API path", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      sseResponse([
        { id: "ds_resp_1", model: "deepseek-v4-pro", choices: [{ delta: { reasoning_content: "thinking " } }] },
        { id: "ds_resp_1", model: "deepseek-v4-pro", choices: [{ delta: { content: "I will check." } }] },
        {
          id: "ds_resp_1",
          model: "deepseek-v4-pro",
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "current_time", arguments: "" } }],
              },
            },
          ],
        },
        {
          id: "ds_resp_1",
          model: "deepseek-v4-pro",
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        },
        {
          id: "ds_resp_1",
          model: "deepseek-v4-pro",
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_cache_hit_tokens: 70,
            prompt_cache_miss_tokens: 30,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
      ]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const provider = new DeepSeekChatProvider(credentials())
    const events: ModelEvent[] = []
    for await (const event of provider.stream(modelRequest())) {
      events.push(event)
    }

    expect(fetchMock).toHaveBeenCalledWith("https://api.deepseek.com/chat/completions", expect.any(Object))
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      tools: [
        {
          type: "function",
          function: {
            name: "current_time",
            description: "Get current time.",
          },
        },
      ],
    })
    expect(body.tools[0].function.parameters).toMatchObject({ type: "object" })

    expect(events.map((event) => event.type)).toEqual([
      "model.started",
      "model.response.metadata",
      "model.reasoning.delta",
      "model.answer.delta",
      "model.reasoning.completed",
      "model.tool_call.streaming",
      "model.tool_call.streaming",
      "model.tool_call.completed",
      "model.usage",
      "model.completed",
    ])
    expect(events.find((event) => event.type === "model.reasoning.completed")).toMatchObject({
      text: "thinking ",
      providerMetadata: { deepseek: { reasoningContent: "thinking " } },
    })
    expect(events.find((event) => event.type === "model.tool_call.completed")).toMatchObject({
      toolCall: {
        toolCallId: "call_1",
        toolName: "current_time",
        input: {},
      },
    })
    expect(events.find((event) => event.type === "model.usage")).toMatchObject({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 70,
        uncachedInputTokens: 30,
        reasoningTokens: 5,
        routedProvider: "deepseek",
        costSource: "computed",
      },
    })
  })

  it("serializes stable cache prelude before the latest user message", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      sseResponse([{ id: "ds_resp_cache_prelude", model: "deepseek-v4-pro", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const provider = new DeepSeekChatProvider(credentials())
    for await (const _event of provider.stream({
      ...modelRequest(),
      messages: [
        {
          role: "developer",
          content:
            "<socrates_stable_cache_prelude>\n<global_always_apply_rules>\n- Slow Mode.\n</global_always_apply_rules>\n</socrates_stable_cache_prelude>",
        },
        { role: "user", content: "Now inspect the workspace." },
      ],
    })) {
      // Drain stream.
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user", "user"])
    expect(body.messages[1].content).toContain("socrates_stable_cache_prelude")
    expect(body.messages[2].content).toBe("Now inspect the workspace.")
  })

  it("passes DeepSeek reasoning_content back for thinking tool-call continuations", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sseResponse([{ id: "ds_resp_2", model: "deepseek-v4-pro", choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }]))
    globalThis.fetch = fetchMock as typeof fetch

    const provider = new DeepSeekChatProvider(credentials())
    for await (const _event of provider.stream({
      ...modelRequest(),
      messages: [
        { role: "user", content: "Need the current time." },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "I need the current_time tool.", providerMetadata: { deepseek: { reasoningContent: "I need the current_time tool." } } },
            { type: "text", text: "I will check." },
            { type: "tool-call", toolCallId: "call_1", toolName: "current_time", input: {} },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call_1", toolName: "current_time", output: { iso: "2026-07-08T12:00:00.000Z" } }],
        },
      ],
    })) {
      // Drain stream.
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: "I will check.",
        reasoning_content: "I need the current_time tool.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "current_time", arguments: "{}" },
          },
        ],
      }),
    )
    expect(body.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_1",
      }),
    )
  })

  it("serializes union tool schemas as DeepSeek-accepted object parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      sseResponse([{ id: "ds_resp_tools", model: "deepseek-v4-pro", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const provider = new DeepSeekChatProvider(credentials())
    for await (const _event of provider.stream({
      ...modelRequest(),
      tools: [
        { name: "edit", description: "Edit a file.", inputSchema: editToolModelInputSchema },
        { name: "trace_retrieve", description: "Search prior runtime context.", inputSchema: traceRetrieveToolModelInputSchema },
        { name: "skills", description: "Inspect available skills.", inputSchema: skillsToolModelInputSchema },
        { name: "project_docs", description: "Read or edit project docs.", inputSchema: projectDocsToolModelInputSchema },
        { name: "repo_docs", description: "Read or edit repo docs.", inputSchema: repoDocsToolModelInputSchema },
        { name: "mcp_registry", description: "Inspect MCP registry.", inputSchema: mcpRegistryToolModelInputSchema },
      ],
    })) {
      // Drain stream.
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({
          name: "edit",
          parameters: expect.objectContaining({
            type: "object",
            required: ["path"],
          }),
        }),
      }),
      expect.objectContaining({
        function: expect.objectContaining({
          name: "trace_retrieve",
          parameters: expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({
              mode: expect.objectContaining({ enum: ["exact", "semantic", "combined", "audit"] }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        function: expect.objectContaining({
          name: "skills",
          parameters: expect.objectContaining({
            type: "object",
            required: ["operation"],
            properties: expect.objectContaining({
              operation: expect.objectContaining({ enum: ["list", "describe"] }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        function: expect.objectContaining({
          name: "project_docs",
          parameters: expect.objectContaining({
            type: "object",
            required: ["operation", "area"],
            properties: expect.objectContaining({
              operation: expect.objectContaining({ enum: expect.arrayContaining(["read", "search", "edit", "patch_section"]) }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        function: expect.objectContaining({
          name: "repo_docs",
          parameters: expect.objectContaining({
            type: "object",
            required: ["operation"],
            properties: expect.objectContaining({
              operation: expect.objectContaining({ enum: expect.arrayContaining(["read", "search", "edit", "patch_section"]) }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        function: expect.objectContaining({
          name: "mcp_registry",
          parameters: expect.objectContaining({
            type: "object",
            required: ["operation"],
            properties: expect.objectContaining({
              operation: expect.objectContaining({ enum: ["list", "describe"] }),
            }),
          }),
        }),
      }),
    ])
  })

  it("generates structured JSON with response_format=json_object", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        id: "ds_resp_3",
        model: "deepseek-v4-flash",
        choices: [{ message: { role: "assistant", content: "{\"answer\":\"ok\"}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 4 },
      }),
    )
    globalThis.fetch = fetchMock as typeof fetch

    const provider = new DeepSeekChatProvider(credentials())
    const result = await provider.generateStructured<{ answer: string }>({
      ...modelRequest(),
      modelId: "deepseek-v4-flash",
      runtimeConfig: { ...modelRequest().runtimeConfig, modelId: "deepseek-v4-flash", thinkingEnabled: false },
      schema: z.object({ answer: z.string() }),
    })

    expect(result.output).toEqual({ answer: "ok" })
    expect(result.usage).toMatchObject({ cachedInputTokens: 6, uncachedInputTokens: 4, routedProvider: "deepseek" })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: false,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
    })
    expect(body.messages[0].content).toContain("Return only a valid JSON object")
  })
})

const credentials = (): ProviderCredentialResolver => ({
  getApiKey: (providerId) => (providerId === "deepseek" ? "sk-test-deepseek" : undefined),
  resolveAuth: (providerId, authMode = "api_key") =>
    providerId === "deepseek" && authMode === "api_key"
      ? { authMode: "api_key", apiKey: "sk-test-deepseek" }
      : undefined,
})

const modelRequest = (): ModelRequest => ({
  providerId: "deepseek",
  modelId: "deepseek-v4-pro",
  system: "You are Socrates.",
  messages: [{ role: "user", content: "say hi" }],
  runtimeConfig: {
    providerId: "deepseek",
    authMode: "api_key",
    modelId: "deepseek-v4-pro",
    thinkingEnabled: true,
    thinkingEffort: "xhigh",
    approvalMode: "manual",
    sandboxMode: "workspace_write",
  },
  tools: [{ name: "current_time", description: "Get current time.", inputSchema: z.object({}).strict() }],
})

const sseResponse = (values: unknown[]): Response =>
  new Response(`${values.map((value) => `data: ${JSON.stringify(value)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
