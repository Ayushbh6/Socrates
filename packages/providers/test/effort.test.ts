import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { AnthropicModel, EFFORT_BODY, GeminiInteractionsModel, NO_EFFORTS, OpenAICompatibleModel, detectEfforts, listModels, openRouterId } from "../src";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** Answers each URL with its payload, and records what was asked. */
function fakeFetch(routes: Record<string, unknown>, captured: Captured[] = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    captured.push({ url: String(url), headers, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const route = Object.keys(routes).find((prefix) => String(url).startsWith(prefix));
    if (route === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(routes[route]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const openRouter = {
  data: [
    { id: "anthropic/claude-opus-5.5", supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "high" } },
    { id: "anthropic/claude-opus-4.8", supported_parameters: ["tools"], reasoning: { mandatory: false, supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "high" } },
    { id: "anthropic/claude-haiku-4.5", supported_parameters: ["tools"], reasoning: { mandatory: false, supported_efforts: null } },
    { id: "openai/gpt-5.1", supported_parameters: ["tools"], reasoning: { mandatory: false, supported_efforts: ["high", "medium", "low", "none"], default_effort: "none" } },
    { id: "google/gemini-3.8-flash", supported_parameters: ["tools"], reasoning: { mandatory: true, supported_efforts: ["high", "medium", "low"], default_effort: "medium" } },
    { id: "google/gemini-2.5-flash", supported_parameters: ["tools"], reasoning: { mandatory: false, supported_efforts: ["high", "low"], default_effort: "low" } },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"], default_effort: "max" } },
    { id: "z-ai/glm-5.3-flash:batch", supported_parameters: ["tools"] },
    { id: "some/no-tools", supported_parameters: ["temperature"] },
  ],
};
const deepSeek = { data: [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", effort: { supported_levels: ["low", "high", "max"], default_level: "high" } }, { id: "deepseek-old" }] };

describe("thinking levels", () => {
  it("reads each model's levels from DeepSeek's list or OpenRouter's, weakest first, with Socrates' default", async () => {
    const fetcher = fakeFetch({ "https://openrouter.ai/api/v1/models": openRouter, "https://api.deepseek.com/models": deepSeek });
    const env = { DEEPSEEK_API_KEY: "k" };
    // DeepSeek can always think less or not at all; Socrates starts it low, as before.
    expect(await detectEfforts("deepseek", "deepseek-flash", env, fetcher)).toEqual({ levels: ["off", "low", "high", "max"], default: "low" });
    expect(await detectEfforts("deepseek", "deepseek-old", env, fetcher)).toEqual(NO_EFFORTS);
    // Claude: Opus 5.5 cannot stop thinking, Opus 4.8 can, Haiku 4.5 has no levels.
    expect(await detectEfforts("anthropic", "claude-opus-5-5", env, fetcher)).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], default: "high" });
    expect((await detectEfforts("anthropic", "claude-opus-4-8", env, fetcher)).levels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(await detectEfforts("anthropic", "claude-haiku-4-5-20251001", env, fetcher)).toEqual(NO_EFFORTS);
    // OpenAI's "none" is "off".
    expect(await detectEfforts("openai", "gpt-5.1", env, fetcher)).toEqual({ levels: ["off", "low", "medium", "high"], default: "off" });
    // Gemini starts low, and its own API cannot turn thinking off.
    expect(await detectEfforts("gemini", "gemini-3.8-flash", env, fetcher)).toEqual({ levels: ["low", "medium", "high"], default: "low" });
    expect((await detectEfforts("gemini", "gemini-2.5-flash", env, fetcher)).levels).toEqual(["low", "high"]);
    expect(await detectEfforts("openrouter", "z-ai/glm-5.3-flash", env, fetcher)).toEqual({ levels: ["low", "high", "max"], default: "max" });
    expect(await detectEfforts("openrouter", "unknown/model", env, fetcher)).toEqual(NO_EFFORTS);
    // A list that cannot be read leaves the model's own default in place.
    expect(await detectEfforts("deepseek", "deepseek-flash", env, fakeFetch({}))).toEqual(NO_EFFORTS);
  });

  it("finds a direct model under its OpenRouter name", () => {
    expect([openRouterId("anthropic", "claude-opus-5-5"), openRouterId("anthropic", "claude-sonnet-5"), openRouterId("anthropic", "claude-haiku-4-5-20251001"), openRouterId("openai", "gpt-6.1-sol"), openRouterId("gemini", "gemini-3.8-flash"), openRouterId("deepseek", "deepseek-flash")])
      .toEqual(["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4.5", "openai/gpt-6.1-sol", "google/gemini-3.8-flash", null]);
  });

  it("asks each provider in its own words, with a request's level over the client's default", async () => {
    expect(EFFORT_BODY.deepseek!("off")).toEqual({ thinking: { type: "disabled" } });
    expect(EFFORT_BODY.deepseek!("max")).toEqual({ reasoning_effort: "max" });
    expect(EFFORT_BODY.openai!("off")).toEqual({ reasoning_effort: "none" });
    expect(EFFORT_BODY.openai!("xhigh")).toEqual({ reasoning_effort: "xhigh" });
    expect(EFFORT_BODY.openrouter!("off")).toEqual({ reasoning: { enabled: false } });
    expect(EFFORT_BODY.openrouter!("high")).toEqual({ reasoning: { effort: "high" } });

    const completion = { id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
    const captured: Captured[] = [];
    const model = new OpenAICompatibleModel({ model: "deepseek-flash", provider: "deepseek", effort: "low", effortBody: EFFORT_BODY.deepseek!, client: new OpenAI({ apiKey: "test", maxRetries: 0, fetch: fakeFetch({ "": completion }, captured) }) });
    await model.complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    await model.complete({ system: "s", messages: [{ role: "user", content: "hi" }], effort: "off" });
    expect(captured.map((c) => [c.body.reasoning_effort, c.body.thinking])).toEqual([["low", undefined], [undefined, { type: "disabled" }]]);

    const reply = { id: "m", type: "message", role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    const sent: Captured[] = [];
    const claude = new AnthropicModel({ model: "claude-opus-4-8", client: new Anthropic({ apiKey: "test", maxRetries: 0, fetch: fakeFetch({ "": reply }, sent) }) });
    await claude.complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    await claude.complete({ system: "s", messages: [{ role: "user", content: "hi" }], effort: "xhigh" });
    await claude.complete({ system: "s", messages: [{ role: "user", content: "hi" }], effort: "off" });
    expect(sent.map((c) => [c.body.output_config, c.body.thinking])).toEqual([[undefined, undefined], [{ effort: "xhigh" }, undefined], [undefined, { type: "disabled" }]]);

    const asked: Captured[] = [];
    const gemini = new GeminiInteractionsModel({ model: "gemini-3.8-flash", apiKey: "test", fetch: fakeFetch({ "": { status: "completed", steps: [] } }, asked) });
    await gemini.complete({ system: "s", messages: [{ role: "user", content: "hi" }] });
    await gemini.complete({ system: "s", messages: [{ role: "user", content: "hi" }], effort: "high" });
    expect(asked.map((c) => (c.body.generation_config as { thinking_level: string }).thinking_level)).toEqual(["low", "high"]);
  });
});

describe("model lists", () => {
  it("offers only models that can call tools, from each provider's own list, keeping keys in headers", async () => {
    const captured: Captured[] = [];
    const fetcher = fakeFetch({
      "https://openrouter.ai/api/v1/models": openRouter,
      "https://api.deepseek.com/models": deepSeek,
      "https://api.openai.com/v1/models": { data: [{ id: "gpt-6.1-sol" }, { id: "gpt-realtime" }, { id: "text-embedding-3-small" }, { id: "o3" }, { id: "gpt-image-2" }] },
      "https://generativelanguage.googleapis.com/v1beta/models": { models: [{ name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] }, { name: "models/imagen-5", supportedGenerationMethods: ["predict"] }, { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3-pro-image", supportedGenerationMethods: ["generateContent"] }] },
      "https://api.anthropic.com/v1/models": { data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-opus-5-5" },
    }, captured);
    const env = { DEEPSEEK_API_KEY: "ds-key", OPENAI_API_KEY: "oa-key", GEMINI_API_KEY: "gm-key", ANTHROPIC_API_KEY: "an-key" };
    expect(await listModels("openrouter", env, fetcher)).toEqual([
      { id: "anthropic/claude-opus-5.5" }, { id: "anthropic/claude-opus-4.8" }, { id: "anthropic/claude-haiku-4.5" }, { id: "openai/gpt-5.1" },
      { id: "google/gemini-3.8-flash" }, { id: "google/gemini-2.5-flash" }, { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    ]);
    expect(await listModels("deepseek", env, fetcher)).toEqual([{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" }, { id: "deepseek-old" }]);
    expect(await listModels("openai", env, fetcher)).toEqual([{ id: "gpt-6.1-sol" }, { id: "o3" }]);
    expect(await listModels("gemini", env, fetcher)).toEqual([{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }]);
    expect(await listModels("anthropic", env, fetcher)).toEqual([{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }]);
    for (const c of captured) expect(c.url).not.toMatch(/key/);
    expect(captured.find((c) => c.url.startsWith("https://api.openai.com"))!.headers.authorization).toBe("Bearer oa-key");
    expect(captured.find((c) => c.url.startsWith("https://generativelanguage"))!.headers["x-goog-api-key"]).toBe("gm-key");
    expect(captured.find((c) => c.url.startsWith("https://api.anthropic.com"))!.headers["x-api-key"]).toBe("an-key");
    // A list is kept for a while: asking again does not fetch again.
    const before = captured.length;
    await listModels("openai", env, fetcher);
    expect(captured.length).toBe(before);
  });
});
