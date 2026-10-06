import { describe, expect, it } from "vitest";
import type { ModelClient } from "@socrates/contracts";
import { ScriptedModel } from "@socrates/providers";
import { SCRIPTED, home, server } from "./helpers";

/** The models asked for, by provider and name, each a scripted model that says who it is. */
function recorder() {
  const built: string[] = [];
  const made = new Map<string, ModelClient>();
  const makeModel = (provider: string, model: string): ModelClient => {
    built.push(`${provider}:${model}`);
    const client = new ScriptedModel(`${provider}:${model}`, []);
    made.set(`${provider}:${model}`, client);
    return client;
  };
  return { built, made, makeModel };
}
const compactorOf = (rt: { socrates: unknown }) => ((rt.socrates as { options: { compactorModel?: ModelClient } }).options.compactorModel);

describe("the compaction model", () => {
  it("is the chat model unless one is chosen: no model is built for it and the status says so", async () => {
    const { built, makeModel } = recorder();
    const { rt, request } = await server(home({ settings: SCRIPTED }), { makeModel });
    expect(rt.settings.compactor).toBeNull();
    expect(compactorOf(rt)).toBeUndefined();
    expect(built.sort()).toEqual(["gemini:chat", "gemini:router"]);
    expect((await request("GET", "/api/status")).json().models.compactor).toBeNull();
  });

  it("is built from the setting, given to Socrates, reported in the status, and kept across a restart", async () => {
    const config = home({ settings: SCRIPTED });
    const first = recorder();
    const { rt, request } = await server(config, { makeModel: first.makeModel });
    const saved = await request("PUT", "/api/settings", { compactor: { provider: "deepseek", model: "deepseek-v4-pro" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().compactor).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(first.built).toContain("deepseek:deepseek-v4-pro");
    // The model is wrapped to record its calls, so it is known by its id.
    expect(compactorOf(rt)?.id).toBe(first.made.get("deepseek:deepseek-v4-pro")!.id);
    expect((await request("GET", "/api/status")).json().models.compactor).toEqual({ provider: "deepseek", model: "deepseek-v4-pro", source: "settings" });
    await rt.close();
    const again = await server(config, { makeModel: recorder().makeModel });
    expect(again.rt.settings.compactor).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
    // Choosing "automatic" again takes it away.
    await again.request("PUT", "/api/settings", { compactor: null });
    expect(compactorOf(again.rt)).toBeUndefined();
  });

  it("refuses a model that is not a provider and model name", async () => {
    const { request } = await server(home({ settings: SCRIPTED }), { makeModel: recorder().makeModel });
    expect((await request("PUT", "/api/settings", { compactor: { provider: "nowhere", model: "x" } })).statusCode).toBe(400);
    expect((await request("PUT", "/api/settings", { compactor: { provider: "gemini", model: "" } })).statusCode).toBe(400);
  });
});
