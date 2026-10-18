import type { ModelClient } from "@socrates/contracts";
import { ScriptedModel } from "@socrates/providers";
import { describe, expect, it } from "vitest";
import { home, server } from "./helpers";

function recorder() {
  const built: string[] = [];
  const makeModel = (provider: string, model: string): ModelClient => {
    built.push(`${provider}:${model}`);
    return new ScriptedModel(`${provider}:${model}`, []);
  };
  return { built, makeModel };
}
const effortOf = (rt: { socrates: unknown }) => (rt.socrates as { router: { effort?: string } }).router.effort;

describe("the routing model", () => {
  it("is GPT-6 Luna on OpenRouter with low thinking when there is an OpenRouter key and none is chosen", async () => {
    const { built, makeModel } = recorder();
    const { rt, request } = await server(home({ settings: { chat: { provider: "deepseek", model: "deepseek-flash" } } }), { makeModel, env: { OPENROUTER_API_KEY: "sk-or-test", DEEPSEEK_API_KEY: "sk-test" } });
    expect(built).toContain("openrouter:openai/gpt-6-luna");
    expect((await request("GET", "/api/status")).json().models.router).toEqual({ provider: "openrouter", model: "openai/gpt-6-luna", source: "detected" });
    expect(effortOf(rt)).toBe("low");
  });

  it("is the chat provider's router model without an OpenRouter key, and the chosen one when there is one", async () => {
    const plain = recorder();
    const a = await server(home({ settings: { chat: { provider: "deepseek", model: "deepseek-flash" } } }), { makeModel: plain.makeModel, env: { DEEPSEEK_API_KEY: "sk-test" } });
    expect((await a.request("GET", "/api/status")).json().models.router).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(effortOf(a.rt)).toBeUndefined();

    const chosen = recorder();
    const b = await server(home({ settings: { chat: { provider: "deepseek", model: "deepseek-flash" }, router: { provider: "deepseek", model: "deepseek-v4-pro" } } }), { makeModel: chosen.makeModel, env: { OPENROUTER_API_KEY: "sk-or-test", DEEPSEEK_API_KEY: "sk-test" } });
    expect((await b.request("GET", "/api/status")).json().models.router).toEqual({ provider: "deepseek", model: "deepseek-v4-pro", source: "settings" });
    expect(effortOf(b.rt)).toBeUndefined();
  });
  it("saves routing thinking independently, validates it and records it on router calls", async () => {
    const { makeModel } = recorder();
    const levels = { levels: ["off", "low", "high"] as ("off" | "low" | "high")[], default: "off" as const };
    const { rt, request } = await server(home({ settings: { chat: { provider: "deepseek", model: "deepseek-flash" } } }), {
      makeModel, env: { OPENROUTER_API_KEY: "test" }, detectEfforts: async () => levels,
    });
    expect((await request("GET", "/api/model-efforts?provider=openrouter&model=openai%2Fgpt-6-luna")).json()).toEqual(levels);
    expect((await request("GET", "/api/model-efforts?provider=unknown&model=x")).statusCode).toBe(400);
    const router = { provider: "openrouter", model: "openai/gpt-6-luna", effort: "low" };
    expect((await request("PUT", "/api/settings", { router })).statusCode).toBe(200);
    expect(rt.settings.router).toEqual(router);
    expect(rt.models.router?.effort?.current).toBe("low");
    expect(rt.models.chat?.effort?.current).toBe("off");
    expect(effortOf(rt)).toBe("low");
    await rt.socrates!.handle("Hello"); // Empty scripted model fails, but the attempted request is still recorded.
    const row = rt.calls!.list({ role: "router" }).at(-1);
    expect(row).toBeDefined();
    expect(rt.calls!.get(row!.id)?.request.effort).toBe("low");
    expect((await request("PUT", "/api/settings", { router: { ...router, effort: "max" } })).statusCode).toBe(400);
    expect(rt.settings.router?.effort).toBe("low");
    expect((await request("PUT", "/api/settings", { router: { ...router, effort: "off" } })).statusCode).toBe(200);
    expect(effortOf(rt)).toBe("off");
  });

});
