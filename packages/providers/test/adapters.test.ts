import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ModelError, type ModelMessage } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { AnthropicModel, OpenAICompatibleModel, TokenCalibration } from "../src";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function fakeFetch(status: number, payload: unknown, captured: Captured[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    captured.push({ url: String(url), headers, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const conversation: ModelMessage[] = [
  { role: "user", content: "route this" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "tu_1", name: "ledger_query", input: { match: "german" } },
      { id: "tu_2", name: "ledger_query", input: { match: "website" } },
    ],
    raw: {
      provider: "anthropic",
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "tool_use", id: "tu_1", name: "ledger_query", input: { match: "german" } },
        { type: "tool_use", id: "tu_2", name: "ledger_query", input: { match: "website" } },
      ],
    },
  },
  { role: "tool", toolCallId: "tu_1", toolName: "ledger_query", content: "row a" },
  { role: "tool", toolCallId: "tu_2", toolName: "ledger_query", content: "bad", isError: true },
];

describe("AnthropicModel", () => {
  const reply = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "s2" },
      { type: "text", text: '{"decision":"continue_current"}' },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 500 },
  };

  it("replays raw content, groups tool results, and normalizes usage", async () => {
    const captured: Captured[] = [];
    const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: fakeFetch(200, reply, captured) });
    const model = new AnthropicModel({ model: "claude-opus-5-5", client });
    const res = await model.complete({
      system: "sys",
      messages: conversation,
      tools: [{ name: "ledger_query", description: "d", inputSchema: { type: "object", properties: {} } }],
      temperature: 0,
      maxOutputTokens: 8000,
    });

    const body = captured[0]!.body;
    expect(body.system).toBe("sys");
    expect(body.max_tokens).toBe(8000);
    expect(body.temperature).toBeUndefined();
    expect(body.fallbacks).toBe("default");
    expect(captured[0]!.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages).toHaveLength(3);
    expect(messages[1]!.content).toEqual((conversation[1] as { raw: { content: unknown } }).raw.content);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "row a" },
        { type: "tool_result", tool_use_id: "tu_2", content: "bad", is_error: true },
      ],
    });
    expect(body.tools).toEqual([{ name: "ledger_query", description: "d", input_schema: { type: "object", properties: {} } }]);

    expect(res.text).toBe('{"decision":"continue_current"}');
    expect(res.stopReason).toBe("end");
    expect(res.usage).toEqual({ promptTokens: 630, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 30 });
    expect(res.raw).toEqual({ provider: "anthropic", content: reply.content });
  });

  it("omits fallbacks on models that do not accept them and maps errors", async () => {
    const captured: Captured[] = [];
    const ok = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: fakeFetch(200, { ...reply, model: "claude-haiku-4-5" }, captured) });
    await new AnthropicModel({ model: "claude-haiku-4-5", client: ok }).complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(captured[0]!.body.fallbacks).toBeUndefined();

    const limited = new Anthropic({
      apiKey: "test",
      maxRetries: 0,
      fetch: fakeFetch(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, []),
    });
    const err = await new AnthropicModel({ model: "claude-haiku-4-5", client: limited })
      .complete({ system: "s", messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe("rate_limit");
  });
});

describe("OpenAICompatibleModel", () => {
  it("converts messages and tools and parses tool calls", async () => {
    const captured: Captured[] = [];
    const completion = {
      id: "c1",
      object: "chat.completion",
      created: 0,
      model: "deepseek-chat",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_9", type: "function", function: { name: "ledger_query", arguments: '{"match":"x"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, prompt_tokens_details: { cached_tokens: 10 } },
    };
    const client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: fakeFetch(200, completion, captured) });
    const model = new OpenAICompatibleModel({ model: "deepseek-chat", provider: "deepseek", maxTokensParam: "max_tokens", client });
    const res = await model.complete({
      system: "sys",
      messages: conversation,
      tools: [{ name: "ledger_query", description: "d", inputSchema: { type: "object" } }],
      temperature: 0,
      maxOutputTokens: 1000,
    });

    const body = captured[0]!.body;
    expect(model.id).toBe("deepseek:deepseek-chat");
    expect(body.max_tokens).toBe(1000);
    expect(body.temperature).toBe(0);
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[0]).toEqual({ role: "system", content: "sys" });
    expect(messages[2]).toMatchObject({ role: "assistant", content: null });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "row a" });
    expect(res.toolCalls).toEqual([{ id: "call_9", name: "ledger_query", input: { match: "x" } }]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ promptTokens: 50, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 0 });
  });
});

describe("TokenCalibration", () => {
  it("learns a smoothed per-model ratio from provider usage", () => {
    const cal = new TokenCalibration(0.5);
    expect(cal.measure("m", 1000)).toBe(1000);
    cal.observe("m", 1000, { promptTokens: 1200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(cal.ratio("m")).toBeCloseTo(1.2);
    cal.observe("m", 1000, { promptTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(cal.ratio("m")).toBeCloseTo(1.1);
    expect(cal.measure("other", 500)).toBe(500);
  });
});

describe("reasoning replay regression", () => {
  it("preserves DeepSeek reasoning_content when continuing after a tool call", async () => {
    const bodies: Record<string, any>[] = [];
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (bodies.length === 2 && !body.messages.find((m: any) => m.role === "assistant")?.reasoning_content) {
        return new Response(JSON.stringify({ error: { message: "Missing reasoning_content", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "c1", object: "chat.completion", created: 0, model: "deepseek-reasoner",
        choices: [{ index: 0, finish_reason: "tool_calls", message: {
          role: "assistant", content: null, reasoning_content: "provider reasoning fixture",
          tool_calls: [{ id: "call1", type: "function", function: { name: "ledger_query", arguments: "{}" } }],
        } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new OpenAI({ apiKey: "test-only", maxRetries: 0, fetch: fakeFetch });
    const model = new OpenAICompatibleModel({ model: "deepseek-reasoner", provider: "deepseek", maxTokensParam: "max_tokens", client });
    const tools = [{ name: "ledger_query", description: "query", inputSchema: { type: "object" } }];
    const first = await model.complete({ system: "s", messages: [{ role: "user", content: "route" }], tools });
    await expect(model.complete({ system: "s", tools, messages: [
      { role: "user", content: "route" },
      { role: "assistant", content: first.text, toolCalls: first.toolCalls, ...(first.raw ? { raw: first.raw } : {}) },
      { role: "tool", toolCallId: "call1", toolName: "ledger_query", content: "row" },
    ] })).resolves.toBeDefined();
  });
});

describe("Gemini Interactions", () => {
  it("replays all signed steps verbatim across multiple function rounds and maps usage", async () => {
    const {GeminiInteractionsModel} = await import("../src");
    const captured: Captured[] = [];
    const steps = [{type: "thought", signature: "signed-thought", summary: []}, {type: "function_call", id: "call1", name: "ledger_query", arguments: {match: "German"}}];
    const model = new GeminiInteractionsModel({model: "gemini-3.8-flash", apiKey: "test", fetch: fakeFetch(200, {model: "gemini-3.8-flash", status: "requires_action", steps, usage: {total_input_tokens: 80, total_output_tokens: 10, total_thought_tokens: 20, total_cached_tokens: 50}}, captured)});
    const tools = [{name: "ledger_query", description: "search", inputSchema: {type: "object", properties: {match: {type: "string"}}}}];
    const first = await model.complete({system: "router", messages: [{role: "user", content: "Resume German"}], tools});
    const second = await model.complete({system: "router", messages: [{role: "user", content: "Resume German"}, {role: "assistant", content: first.text, toolCalls: first.toolCalls, raw: first.raw!}, {role: "tool", toolCallId: "call1", toolName: "ledger_query", content: "g1 German", isError: true}], tools});
    expect(captured[0]!.url).toBe("https://generativelanguage.googleapis.com/v1/interactions");
    expect(captured[0]!.body.store).toBe(false);
    expect(captured[0]!.body.previous_interaction_id).toBeUndefined();
    expect((captured[1]!.body.input as unknown[]).slice(1, 3)).toEqual(steps);
    expect((captured[1]!.body.input as unknown[]).at(-1)).toMatchObject({type: "function_result", call_id: "call1", is_error: true});
    expect(first.raw?.content).toEqual(steps);
    expect(second.toolCalls).toEqual([{id: "call1", name: "ledger_query", input: {match: "German"}}]);
    expect(first.usage).toEqual({promptTokens: 80, outputTokens: 30, cacheReadTokens: 50, cacheWriteTokens: 0});
  });

  it("keeps foreign signatures out of Gemini requests", async () => {
    const {toGeminiSteps} = await import("../src");
    const steps = toGeminiSteps(conversation, "gemini:interactions:gemini-3.8-flash");
    expect(JSON.stringify(steps)).not.toContain('"signature"');
    expect(steps.filter(s => s.type === "function_call")).toHaveLength(2);
  });

  it.each([[400, "invalid_request"], [401, "authentication"], [429, "rate_limit"], [503, "server"]])("normalizes HTTP %i without echoing sensitive response bodies", async (status, kind) => {
    const {GeminiInteractionsModel} = await import("../src");
    const model = new GeminiInteractionsModel({model: "gemini-3.8-flash", apiKey: "test-secret", fetch: fakeFetch(status as number, {error: {message: "test-secret"}}, [])});
    const error = await model.complete({system: "s", messages: []}).catch((e: unknown) => e) as ModelError;
    expect(error.kind).toBe(kind); expect(error.message).not.toContain("test-secret");
  });

  it("propagates cancellation rather than routing a fallback", async () => {
    const {GeminiInteractionsModel} = await import("../src");
    const controller = new AbortController(); controller.abort();
    const model = new GeminiInteractionsModel({model: "gemini-3.8-flash", apiKey: "test", fetch: (async () => {throw new Error("abort");}) as typeof fetch});
    await expect(model.complete({system: "s", messages: [], signal: controller.signal})).rejects.toMatchObject({kind: "aborted"});
  });
});

describe("OpenRouter signed reasoning", () => {
  it("preserves opaque reasoning details on the same model, excluding foreign raw content", async () => {
    const details = [{type: "reasoning.encrypted", data: "opaque", signature: "sig", format: "google-gemini-v1"}];
    const reply = {id: "c", object: "chat.completion", created: 0, model: "google/gemini-3.8-flash", choices: [{index: 0, finish_reason: "tool_calls", message: {role: "assistant", content: null, reasoning: "summary", reasoning_details: details, tool_calls: [{id: "call1", type: "function", function: {name: "ledger_query", arguments: "{}"}}]}}]};
    const captured: Captured[] = [];
    const client = new OpenAI({apiKey: "test", maxRetries: 0, fetch: fakeFetch(200, reply, captured)});
    const model = new OpenAICompatibleModel({provider: "openrouter", model: reply.model, client});
    const first = await model.complete({system: "s", messages: [{role: "user", content: "route"}]});
    const messages: ModelMessage[] = [{role: "user", content: "route"}, {role: "assistant", content: first.text, toolCalls: first.toolCalls, raw: first.raw!}, {role: "tool", toolCallId: "call1", toolName: "ledger_query", content: "result"}];
    await model.complete({system: "s", messages});
    expect((captured[1]!.body.messages as Record<string, unknown>[])[2]!.reasoning_details).toEqual(details);
    const other = new OpenAICompatibleModel({provider: "deepseek", model: "other", client});
    await other.complete({system: "s", messages});
    expect((captured[2]!.body.messages as Record<string, unknown>[])[2]!.reasoning_details).toBeUndefined();
  });
});

describe("prompt-cache breakpoints and tool-less requests", () => {
  const cached: ModelMessage[] = [
    { role: "user", content: [{ text: "goal " }, { text: "history ", cache: true }, { text: "message" }] },
    { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "read", input: {} }] },
    { role: "tool", toolCallId: "tu_1", toolName: "read", content: "file", cache: true },
    { role: "user", content: "wrap up" },
  ];
  const tools = [{ name: "read", description: "d", inputSchema: { type: "object" } }];

  it("marks Anthropic breakpoints, caches the system prompt, and forbids calls without dropping tools", async () => {
    const captured: Captured[] = [];
    const reply = { id: "m", type: "message", role: "assistant", model: "test-model", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: fakeFetch(200, reply, captured) });
    await new AnthropicModel({ model: "test-model", client }).complete({ system: "sys", messages: cached, tools, toolChoice: "none" });
    const body = captured[0]!.body;
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    expect(body.tool_choice).toEqual({ type: "none" });
    expect(body.tools).toHaveLength(1);
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages[0]!.content).toEqual([
      { type: "text", text: "goal " },
      { type: "text", text: "history ", cache_control: { type: "ephemeral" } },
      { type: "text", text: "message" },
    ]);
    // The harness's request joins the user turn that carries the tool results.
    expect(messages).toHaveLength(3);
    expect(messages[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "file", cache_control: { type: "ephemeral" } },
      { type: "text", text: "wrap up" },
    ]);
  });

  it("joins parts for OpenAI-compatible APIs and sets tool_choice none", async () => {
    const captured: Captured[] = [];
    const completion = { id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{}" } }] };
    const client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: fakeFetch(200, completion, captured) });
    await new OpenAICompatibleModel({ model: "m", client }).complete({ system: "s", messages: cached, tools, toolChoice: "none" });
    const body = captured[0]!.body;
    expect((body.messages as { content: unknown }[])[1]).toEqual({ role: "user", content: "goal history message" });
    expect(body.tool_choice).toBe("none");
  });

  it("sends Gemini no tools when calls are forbidden", async () => {
    const { GeminiInteractionsModel } = await import("../src");
    const captured: Captured[] = [];
    const model = new GeminiInteractionsModel({ model: "g", apiKey: "test", fetch: fakeFetch(200, { status: "completed", steps: [] }, captured) });
    await model.complete({ system: "s", messages: cached, tools, toolChoice: "none" });
    expect(captured[0]!.body.tools).toBeUndefined();
    expect((captured[0]!.body.input as { content: unknown }[])[0]!.content).toEqual([{ type: "text", text: "goal history message" }]);
  });
});
