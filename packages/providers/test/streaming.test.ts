import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ModelMessage } from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";
import { AnthropicModel, ChatReply, GeminiInteractionsModel, OpenAICompatibleModel, serverSentEvents } from "../src";

/** An event-stream reply whose body arrives in the given pieces (a piece may end anywhere). */
function sse(events: { event?: string; data: unknown }[], options: { pieces?: number; end?: boolean; signal?: AbortSignal | null } = {}): Response {
  const text = events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / (options.pieces ?? 1));
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // A real connection fails when its request is aborted.
      options.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    },
    pull(controller) {
      if (at >= bytes.length) return options.end === false ? new Promise(() => {}) : controller.close();
      controller.enqueue(bytes.slice(at, (at += size)));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseFetch(reply: (signal: AbortSignal | null) => Response, captured: Record<string, unknown>[] = []) {
  return (async (_url: unknown, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body ?? "{}")));
    return reply(init?.signal ?? null);
  }) as typeof fetch;
}

describe("server-sent events", () => {
  it("reads events split anywhere, joined data lines, and a last event without a blank line", async () => {
    const body = new Response('event: a\ndata: {"x":\ndata: 1}\n\ndata: [DONE]').body!;
    const out = [];
    for await (const e of serverSentEvents(body)) out.push(e);
    expect(out).toEqual([{ event: "a", data: '{"x":\n1}' }, { event: null, data: "[DONE]" }]);
  });
});

describe("Anthropic streaming", () => {
  const events = [
    { event: "message_start", data: { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking at " } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the file." } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];

  it("sends text as it arrives and returns the same response a plain request gives", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: sseFetch((signal) => sse(events, { pieces: 7, signal }), bodies) });
    const pieces: string[] = [];
    const res = await new AnthropicModel({ model: "claude-opus-5-5", client }).complete({ system: "s", messages: [{ role: "user", content: "go" }], onText: (d) => pieces.push(d) });
    expect(bodies[0]!.stream).toBe(true);
    expect(pieces.join("")).toBe("Looking at the file.");
    expect(pieces.length).toBeGreaterThan(1);
    expect(res.text).toBe("Looking at the file.");
    expect(res.toolCalls).toEqual([{ id: "tu_1", name: "read", input: { path: "a.txt" } }]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toMatchObject({ promptTokens: 14, outputTokens: 12, cacheReadTokens: 4 });
    expect((res.raw!.content as { type: string }[]).map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("does not stream without onText", async () => {
    const bodies: Record<string, unknown>[] = [];
    const reply = { id: "m", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: sseFetch(() => new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } }), bodies) });
    await new AnthropicModel({ model: "claude-haiku-4-5", client }).complete({ system: "s", messages: [{ role: "user", content: "go" }] });
    expect(bodies[0]!.stream).toBeUndefined();
  });

  it("maps a user cancellation and a silent stream", async () => {
    const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: sseFetch((signal) => sse(events.slice(0, 3), { end: false, signal })) });
    const controller = new AbortController();
    const model = new AnthropicModel({ model: "claude-haiku-4-5", client, idleMs: 60 });
    await expect(model.complete({ system: "s", messages: [{ role: "user", content: "go" }], onText: () => {} })).rejects.toMatchObject({ kind: "network" });
    const pending = model.complete({ system: "s", messages: [{ role: "user", content: "go" }], onText: () => controller.abort(), signal: controller.signal });
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("OpenAI-compatible streaming", () => {
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ data: { id: "c", object: "chat.completion.chunk", created: 0, model: "deepseek-reasoner", choices: [{ index: 0, delta, finish_reason: null }], ...extra } });
  const events = [
    chunk({ role: "assistant", content: "", reasoning_content: "think " }),
    chunk({ reasoning_content: "hard" }),
    chunk({ content: "Reading " }),
    chunk({ content: "now." }),
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path"' } }, { index: 1, id: "call_2", type: "function", function: { name: "ls", arguments: "{}" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ':"a.txt"}' } }] }),
    { data: { id: "c", object: "chat.completion.chunk", created: 0, model: "deepseek-reasoner", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } },
    { data: { id: "c", object: "chat.completion.chunk", created: 0, model: "deepseek-reasoner", choices: [], usage: { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39, prompt_cache_hit_tokens: 20 } } },
    { data: "[DONE]" },
  ];

  it("joins text, reasoning and tool calls into the response a plain request gives", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: sseFetch(() => sse(events, { pieces: 5 }), bodies) });
    const model = new OpenAICompatibleModel({ model: "deepseek-reasoner", provider: "deepseek", maxTokensParam: "max_tokens", client });
    const pieces: string[] = [];
    const res = await model.complete({ system: "s", messages: [{ role: "user", content: "go" }], onText: (d) => pieces.push(d) });
    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(pieces).toEqual(["Reading ", "now."]);
    expect(res.text).toBe("Reading now.");
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "read", input: { path: "a.txt" } }, { id: "call_2", name: "ls", input: {} }]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ promptTokens: 30, outputTokens: 9, cacheReadTokens: 20, cacheWriteTokens: 0 });
    // The message that is replayed on the next step keeps the provider's reasoning whole.
    expect(res.raw!.content).toMatchObject({ role: "assistant", content: "Reading now.", reasoning_content: "think hard" });
  });

  it("replays a streamed reply on the next step", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: sseFetch(() => sse(events), bodies) });
    const model = new OpenAICompatibleModel({ model: "deepseek-reasoner", provider: "deepseek", maxTokensParam: "max_tokens", client });
    const first = await model.complete({ system: "s", messages: [{ role: "user", content: "go" }], onText: () => {} });
    const messages: ModelMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: first.text, toolCalls: first.toolCalls, raw: first.raw! }, { role: "tool", toolCallId: "call_1", toolName: "read", content: "x" }];
    await model.complete({ system: "s", messages, onText: () => {} });
    const sent = (bodies[1]!.messages as Record<string, unknown>[])[2]!;
    expect(sent.reasoning_content).toBe("think hard");
    expect(sent.tool_calls).toHaveLength(2);
  });

  it("merges OpenRouter reasoning details by index", () => {
    const reply = new ChatReply();
    const detail = (d: unknown[]) => ({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { reasoning_details: d }, finish_reason: null }] }) as never;
    reply.add(detail([{ type: "reasoning.text", index: 0, text: "step " }]));
    reply.add(detail([{ type: "reasoning.text", index: 0, text: "one", signature: "sig", format: "google-gemini-v1" }]));
    reply.add(detail([{ type: "reasoning.encrypted", index: 1, data: "opaque" }]));
    expect((reply.completion().choices[0]!.message as unknown as Record<string, unknown>).reasoning_details).toEqual([
      { type: "reasoning.text", index: 0, text: "step one", signature: "sig", format: "google-gemini-v1" },
      { type: "reasoning.encrypted", index: 1, data: "opaque" },
    ]);
  });

  it("gives up on a silent stream", async () => {
    const client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: sseFetch((signal) => sse(events.slice(0, 3), { end: false, signal })) });
    const model = new OpenAICompatibleModel({ model: "m", client, idleMs: 60 });
    await expect(model.complete({ system: "s", messages: [{ role: "user", content: "go" }], onText: () => {} })).rejects.toMatchObject({ kind: "network" });
  });
});

describe("Gemini Interactions streaming", () => {
  const event = (event_type: string, rest: Record<string, unknown>) => ({ event: event_type, data: { ...rest, event_type } });
  const events = [
    event("interaction.created", { interaction: { object: "interaction", model: "gemini-3.8-flash" } }),
    event("step.start", { index: 0, step: { type: "thought" } }),
    event("step.delta", { index: 0, delta: { type: "thought_signature", signature: "sig-a" } }),
    event("step.stop", { index: 0 }),
    event("step.start", { index: 1, step: { type: "model_output" } }),
    event("step.delta", { index: 1, delta: { type: "text", text: "Checking" } }),
    event("step.delta", { index: 1, delta: { type: "text", text: " it." } }),
    event("step.stop", { index: 1 }),
    event("step.start", { index: 2, step: { id: "call_7", type: "function_call", name: "read_file", signature: "sig-b", arguments: {} } }),
    event("step.delta", { index: 2, delta: { type: "arguments_delta", arguments: '{"path":' } }),
    event("step.delta", { index: 2, delta: { type: "arguments_delta", arguments: '"a.txt"}' } }),
    event("step.stop", { index: 2 }),
    event("interaction.completed", { interaction: { status: "requires_action", model: "gemini-3.8-flash", usage: { total_input_tokens: 60, total_output_tokens: 19, total_thought_tokens: 3, total_cached_tokens: 5 } } }),
    { data: "[DONE]" },
  ];

  it("rebuilds the steps a plain request returns, signatures included, and streams the text", async () => {
    const bodies: Record<string, unknown>[] = [];
    const model = new GeminiInteractionsModel({ model: "gemini-3.8-flash", apiKey: "test", fetch: sseFetch(() => sse(events, { pieces: 9 }), bodies) });
    const pieces: string[] = [];
    const res = await model.complete({ system: "s", messages: [{ role: "user", content: "go" }], onText: (d) => pieces.push(d) });
    expect(bodies[0]!.stream).toBe(true);
    expect(pieces).toEqual(["Checking", " it."]);
    expect(res.text).toBe("Checking it.");
    expect(res.toolCalls).toEqual([{ id: "call_7", name: "read_file", input: { path: "a.txt" } }]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ promptTokens: 60, outputTokens: 22, cacheReadTokens: 5, cacheWriteTokens: 0 });
    expect(res.raw!.content).toEqual([
      { type: "thought", signature: "sig-a" },
      { type: "model_output", content: [{ type: "text", text: "Checking it." }] },
      { id: "call_7", type: "function_call", name: "read_file", signature: "sig-b", arguments: { path: "a.txt" } },
    ]);
  });

  it("does not stream without onText", async () => {
    const bodies: Record<string, unknown>[] = [];
    const reply = () => new Response(JSON.stringify({ status: "completed", steps: [] }), { headers: { "content-type": "application/json" } });
    await new GeminiInteractionsModel({ model: "g", apiKey: "test", fetch: sseFetch(reply, bodies) }).complete({ system: "s", messages: [] });
    expect(bodies[0]!.stream).toBe(false);
  });

  it("fails clearly when the stream reports an error, ends early or goes quiet", async () => {
    const failing = new GeminiInteractionsModel({ model: "g", apiKey: "test", fetch: sseFetch(() => sse([event("error", { code: "x", message: "private detail" })])) });
    const error = await failing.complete({ system: "s", messages: [], onText: () => {} }).catch((e: unknown) => e) as Error;
    expect(error).toMatchObject({ kind: "server" });
    expect(error.message).not.toContain("private detail");
    const early = new GeminiInteractionsModel({ model: "g", apiKey: "test", fetch: sseFetch(() => sse(events.slice(0, 6))) });
    await expect(early.complete({ system: "s", messages: [], onText: () => {} })).rejects.toMatchObject({ kind: "network" });
    const quiet = new GeminiInteractionsModel({ model: "g", apiKey: "test", timeoutMs: 60, fetch: sseFetch((signal) => sse(events.slice(0, 6), { end: false, signal })) });
    await expect(quiet.complete({ system: "s", messages: [], onText: () => {} })).rejects.toMatchObject({ kind: "network" });
  });

  it("maps a user cancellation during the stream", async () => {
    const controller = new AbortController();
    const model = new GeminiInteractionsModel({ model: "g", apiKey: "test", fetch: sseFetch((signal) => sse(events.slice(0, 6), { end: false, signal })) });
    await expect(model.complete({ system: "s", messages: [], signal: controller.signal, onText: () => controller.abort() })).rejects.toMatchObject({ kind: "aborted" });
  });

  it("honors cancellation even when completion is already in the same network chunk", async () => {
    const controller = new AbortController();
    const model = new GeminiInteractionsModel({ model: "g", apiKey: "test", fetch: sseFetch(() => sse(events)) });
    await expect(model.complete({ system: "s", messages: [], signal: controller.signal, onText: () => controller.abort() })).rejects.toMatchObject({ kind: "aborted" });
  });

  it("counts heartbeat bytes as traffic during a reply longer than its idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const model = new GeminiInteractionsModel({ model: "g", apiKey: "test", timeoutMs: 60,
        fetch: sseFetch((signal) => {
          const encoder = new TextEncoder();
          let timer: ReturnType<typeof setInterval>;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              let count = 0;
              timer = setInterval(() => {
                if (++count < 8) controller.enqueue(encoder.encode(": heartbeat\n\n"));
                else {
                  clearInterval(timer);
                  controller.enqueue(encoder.encode('data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}\n\n'));
                  controller.close();
                }
              }, 20);
              signal?.addEventListener("abort", () => { clearInterval(timer); controller.error(new DOMException("aborted", "AbortError")); }, {once:true});
            },
            cancel() { clearInterval(timer); },
          });
          return new Response(body);
        }),
      });
      const pending = model.complete({system:"s",messages:[],onText:()=>{}});
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(160);
      expect((await pending).stopReason).toBe("end");
    } finally { vi.useRealTimers(); }
  });

  it("keeps thought text private and accepts an initially empty content list", async () => {
    const reply = [event("step.start", { index: 0, step: { type: "thought", content: [] } }),
      event("step.delta", { index: 0, delta: { type: "text", text: "Private thinking" } }),
      event("step.start", { index: 1, step: { type: "model_output", content: [] } }),
      event("step.delta", { index: 1, delta: { type: "text", text: "Public 😀" } }),
      event("interaction.completed", { interaction: { status: "completed" } })];
    const model = new GeminiInteractionsModel({ model: "g", apiKey: "test", fetch: sseFetch(() => sse(reply, { pieces: 50 })) });
    const pieces: string[] = [];
    const result = await model.complete({ system: "s", messages: [], onText: (text) => pieces.push(text) });
    expect(pieces).toEqual(["Public 😀"]);
    expect(result.text).toBe("Public 😀");
    expect(result.raw!.content).toMatchObject([{ content: [{ text: "Private thinking" }] }, { content: [{ text: "Public 😀" }] }]);
  });

  it("assembles tool arguments at completion when the stop event is absent", async () => {
    const model = new GeminiInteractionsModel({ model: "g", apiKey: "test", fetch: sseFetch(() => sse(events.filter(e => !(typeof e.data === "object" && e.data.event_type === "step.stop")))) });
    expect((await model.complete({ system: "s", messages: [], onText: () => {} })).toolCalls[0]!.input).toEqual({ path: "a.txt" });
  });
});
