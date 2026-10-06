import { type CallRecord, type ModelClient, type ModelRequest, type ModelResponse, ModelError } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { costOf, listPrice, reportedCost, splitModelId, withRecording } from "../src";

const usage = { promptTokens: 1000, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 0 };
const reply = (over: Partial<ModelResponse> = {}): ModelResponse => ({ text: "ok", toolCalls: [], stopReason: "end", usage, ...over });

/** A model that waits, streams its text in two pieces, then answers. */
function slow(response: ModelResponse, waitMs = 80): ModelClient {
  return {
    id: "test:slow",
    complete: async (request: ModelRequest) => {
      await new Promise((r) => setTimeout(r, waitMs));
      request.onReasoning?.("hm");
      request.onText?.("o");
      await new Promise((r) => setTimeout(r, waitMs));
      request.onText?.("k");
      return response;
    },
  };
}

describe("recording model calls", () => {
  it("hands over the request as it was sent, the reply and its timings", async () => {
    const calls: CallRecord[] = [];
    const model = withRecording(slow(reply({ servedBy: "slow-1", meta: { id: "r1", usage: { cost: 0.5 } } })), (c) => calls.push(c));
    const messages: ModelRequest["messages"] = [{ role: "user", content: "hi" }];
    const seen: string[] = [];
    const response = await model.complete({ system: "be brief", messages, maxOutputTokens: 500, effort: "low", onText: (t) => seen.push(t), trace: { role: "work", userEventId: "evt_1", turnId: "turn_1", step: 2 } });
    messages.push({ role: "assistant", content: "later change" });

    expect(response.text).toBe("ok");
    expect(seen).toEqual(["o", "k"]);
    const [call] = calls;
    expect(calls).toHaveLength(1);
    expect(call).toMatchObject({ model: "test:slow", servedBy: "slow-1", streamed: true, error: null, trace: { role: "work", userEventId: "evt_1", turnId: "turn_1", step: 2 } });
    expect(call!.request).toMatchObject({ system: "be brief", maxOutputTokens: 500, effort: "low", toolChoice: "auto", temperature: null });
    expect(call!.request.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(call!.response).toMatchObject({ text: "ok", reasoning: null, usage, meta: { id: "r1" } });
    expect(call!.firstTokenMs).toBeGreaterThanOrEqual(70);
    expect(call!.ms).toBeGreaterThan(call!.firstTokenMs!);
    // Usage includes all output, so the denominator is the whole call.
    expect(call!.tokensPerSecond).toBe(Math.round(200 / (call!.ms / 1000) * 10) / 10);
  });

  it("records a call that was not streamed without a time to the first token", async () => {
    const calls: CallRecord[] = [];
    const model = withRecording({ id: "test:quick", complete: async () => { await new Promise((r) => setTimeout(r, 60)); return reply(); } }, (c) => calls.push(c));
    await model.complete({ system: "s", messages: [] });
    expect(calls[0]).toMatchObject({ streamed: false, firstTokenMs: null, trace: { role: "other" } });
    // Without a first token the whole call is the generation time: 200 tokens in about 60 ms.
    expect(calls[0]!.tokensPerSecond).toBeLessThan(4000);
  });

  it("does not stream a request that did not ask for it", async () => {
    let streamed: boolean | null = null;
    const model = withRecording({ id: "test:q", complete: async (r) => { streamed = r.onText !== undefined; return reply(); } }, () => {});
    await model.complete({ system: "s", messages: [] });
    expect(streamed).toBe(false);
  });

  it("records a failed call and still throws the failure", async () => {
    const calls: CallRecord[] = [];
    const model = withRecording({ id: "test:bad", complete: async () => { throw new ModelError("Rate limit reached.", "rate_limit", 429); } }, (c) => calls.push(c));
    await expect(model.complete({ system: "s", messages: [] })).rejects.toThrow("Rate limit reached.");
    expect(calls[0]).toMatchObject({ response: null, error: { kind: "rate_limit", status: 429, message: "Rate limit reached." }, tokensPerSecond: null });
  });

  it("never lets a failing sink disturb the call", async () => {
    const model = withRecording({ id: "test:ok", complete: async () => reply() }, () => { throw new Error("disk full"); });
    await expect(model.complete({ system: "s", messages: [] })).resolves.toMatchObject({ text: "ok" });
  });

  it("freezes nested messages, tool schemas and trace when sending, even if the caller changes them mid-call", async () => {
    const calls: CallRecord[] = [];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const model = withRecording({ id: "test:snapshot", complete: async () => { await pending; return reply(); } }, (c) => calls.push(c));
    const request: ModelRequest = { system: "s", messages: [{ role: "user", content: [{ text: "original" }] }], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }], trace: { role: "work", step: 1 } };
    const result = model.complete(request);
    (request.messages[0]!.content as { text: string }[])[0]!.text = "changed";
    request.tools![0]!.description = "changed";
    request.trace!.step = 99;
    finish();
    await result;
    expect(calls[0]!.request.messages[0]!.content).toEqual([{ text: "original" }]);
    expect(calls[0]!.request.tools[0]!.description).toBe("Read");
    expect(calls[0]!.trace.step).toBe(1);
  });
});

describe("what a call costs", () => {
  const price = { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 };

  it("charges cache reads and writes at their own rates, and the rest of the prompt at the input rate", () => {
    // 400 plain, 600 cached, 200 output: (400*2 + 600*0.2 + 200*10) / 1e6
    expect(costOf(usage, price)).toBeCloseTo(0.00292, 8);
    expect(costOf({ promptTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 400 }, price)).toBeCloseTo((600 * 2 + 400 * 2.5) / 1e6, 8);
  });

  it("charges the input rate when a model lists no cache price", () => {
    expect(costOf(usage, { input: 2, cachedInput: null, cacheWrite: null, output: 10 })).toBeCloseTo((1000 * 2 + 200 * 10) / 1e6, 8);
  });

  it("takes the cost a provider reported", () => {
    expect(reportedCost({ usage: { cost: 0.0123 } })).toBe(0.0123);
    expect(reportedCost({ usage: {} })).toBeNull();
    expect(reportedCost(null)).toBeNull();
  });

  it("splits a client id at its first colon", () => {
    expect(splitModelId("openrouter:z-ai/glm-5.3-flash:free")).toEqual(["openrouter", "z-ai/glm-5.3-flash:free"]);
    expect(splitModelId("gemini:interactions:gemini-3.8-flash")).toEqual(["gemini", "gemini-3.8-flash"]);
  });

  it("reads a model's price from OpenRouter's list, per million tokens", async () => {
    const list = { data: [{ id: "google/gemini-3.8-flash", pricing: { prompt: "0.00000075", completion: "0.00000375", input_cache_read: "0.000000075" } }, { id: "deepseek/deepseek-v4.1-flash", pricing: { prompt: "0.0000001", completion: "0.0000004" } }] };
    const fetcher = (async (url: unknown) => new Response(JSON.stringify(String(url).includes("deepseek.com") ? { data: [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" }] } : list))) as typeof fetch;
    expect(await listPrice("gemini", "gemini-3.8-flash", {}, fetcher)).toEqual({ input: 0.75, output: 3.75, cachedInput: 0.075, cacheWrite: null });
    expect(await listPrice("deepseek", "deepseek-flash", {}, fetcher)).toMatchObject({ input: 0.1, output: 0.4 });
    expect(await listPrice("gemini", "gemini-9", {}, fetcher)).toBeNull();
    expect(await listPrice("gemini", "gemini-3.8-flash", {}, (async () => { throw new Error("offline"); }) as typeof fetch)).toBeNull();
  });
});
