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
  it("is GPT-6 Luna on OpenRouter with thinking off when there is an OpenRouter key and none is chosen", async () => {
    const { built, makeModel } = recorder();
    const { rt, request } = await server(home({ settings: { chat: { provider: "deepseek", model: "deepseek-flash" } } }), { makeModel, env: { OPENROUTER_API_KEY: "sk-or-test", DEEPSEEK_API_KEY: "sk-test" } });
    expect(built).toContain("openrouter:openai/gpt-6-luna");
    expect((await request("GET", "/api/status")).json().models.router).toEqual({ provider: "openrouter", model: "openai/gpt-6-luna", source: "detected" });
    expect(effortOf(rt)).toBe("off");
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
});
