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
