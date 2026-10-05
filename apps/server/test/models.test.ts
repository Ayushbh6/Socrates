import { NO_EFFORTS } from "@socrates/providers";
import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { general } from "../../../packages/router/test/helpers";
import { Responder, liveServer } from "./helpers";

const levels = { levels: ["low", "medium", "high"] as const, default: "low" as const };

describe("model and thinking choices", () => {
  async function setup() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const router = new Responder("r", () => general());
    const agent = new Responder("a", async (m) => {
      if (m.startsWith("Hold")) await held;
      return final({ full_answer: "Done." });
    });
    const s = await liveServer(router, agent, {
      deps: {
        env: { GEMINI_API_KEY: "test-key" },
        detectEfforts: async (_provider, model) => (model === "chat" ? { levels: [...levels.levels], default: levels.default, maxOutputTokens: 30_000 } : NO_EFFORTS),
        listModels: async (provider) => (provider === "gemini" ? [{ id: "chat", name: "Chat" }, { id: "other" }] : []),
      },
    });
    const request = (method: "GET" | "PUT", url: string, body?: object) =>
      s.app.inject({ method, url, headers: { host: `127.0.0.1:${s.port}`, authorization: `Bearer ${s.token}` }, ...(body ? { payload: body } : {}) });
    return { ...s, router, agent, release, request };
  }

  it("reports the chat model's thinking levels and asks the chat model, not the router, at the one in use", async () => {
    const { page, router, agent, request } = await setup();
    expect((await request("GET", "/api/status")).json().models.chat.effort).toEqual({ levels: ["low", "medium", "high"], default: "low", maxOutputTokens: 30_000, current: "low" });
    const p = await page();
    p.send({ type: "hello" });
    p.send({ type: "send", id: "m1", text: "First.", to: "main" });
    await p.next((m) => m.type === "result" && m.id === "m1");
    expect(agent.requests.map((r) => r.effort)).toEqual(["low"]);
    expect(router.requests.every((r) => r.effort === undefined)).toBe(true);
  });

  it("changes the thinking level at once, even while Socrates works, and the model only when it is idle", async () => {
    const { page, rt, agent, release, request } = await setup();
    const p = await page();
    p.send({ type: "hello" });
    p.send({ type: "send", id: "hold", text: "Hold on.", to: "main" });
    await p.next((m) => m.type === "state" && m.busy);
    const running = rt.socrates;

    const changed = await request("PUT", "/api/settings", { chat: { provider: "gemini", model: "chat", effort: "high" } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().chat).toEqual({ provider: "gemini", model: "chat", effort: "high" });
    expect(rt.socrates).toBe(running);
    expect((await request("GET", "/api/status")).json().models.chat).toMatchObject({ source: "settings", effort: { current: "high" } });
    // Pages hear of it, so every tab shows the new level.
    await p.next((m) => m.type === "state" && m.settings?.chat?.effort === "high");

    const unknown = await request("PUT", "/api/settings", { chat: { provider: "gemini", model: "chat", effort: "max" } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toBe('chat cannot think at "max"; choose low, medium, high.');
    const model = await request("PUT", "/api/settings", { chat: { provider: "gemini", model: "other" } });
    expect(model.statusCode).toBe(409);

    release();
    await p.next((m) => m.type === "result" && m.id === "hold");
    p.send({ type: "send", id: "next", text: "Next.", to: "main" });
    await p.next((m) => m.type === "result" && m.id === "next");
    expect(agent.requests.map((r) => r.effort)).toEqual(["low", "high"]);
    // Thinking harder gets room to reply, within the model's own limit.
    expect(agent.requests.map((r) => r.maxOutputTokens)).toEqual([16_000, 30_000]);
  });

  it("lists a provider's models for the pickers, and says why it cannot", async () => {
    const { request } = await setup();
    expect((await request("GET", "/api/models?provider=gemini")).json()).toEqual({ models: [{ id: "chat", name: "Chat" }, { id: "other" }] });
    const keyless = await request("GET", "/api/models?provider=deepseek");
    expect(keyless.statusCode).toBe(400);
    expect(keyless.json().error.message).toBe("Add DEEPSEEK_API_KEY to list its models.");
    expect((await request("GET", "/api/models?provider=nope")).json().error.message).toBe('Unknown provider "nope".');
  });

  it("returns a step's complete thinking, which activity cuts at 20,000 characters", async () => {
    const long = Array.from({ length: 2_500 }, (_, i) => `thought ${String(i).padStart(4, "0")}\n`).join("");
    const { page, app, token, port } = await liveServer(new Responder("r", () => general()), new Responder("a", () => ({ ...final({ full_answer: "Done." }), reasoning: long })));
    const p = await page();
    p.send({ type: "hello" });
    p.send({ type: "send", id: "m1", text: "Think long.", to: "main" });
    await p.next((m) => m.type === "result" && m.id === "m1");
    const step = p.received.find((m) => m.type === "activity" && m.kind === "step")!;
    expect(step.thinking).toHaveLength(20_000);
    expect(step.thinkingTruncated).toBe(true);
    const get = (url: string) => app.inject({ method: "GET", url, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } });
    expect((await get(`/api/thinking?seq=${step.seq}`)).json()).toEqual({ seq: step.seq, text: long.trim() });
    const message = p.received.find((m) => m.type === "activity" && m.kind === "message")!;
    expect((await get(`/api/thinking?seq=${message.seq}`)).statusCode).toBe(404);
    expect((await get("/api/thinking?seq=abc")).statusCode).toBe(400);
  });
});
