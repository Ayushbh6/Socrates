import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ModelClient } from "@socrates/contracts";
import { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { continueTask, createGoal } from "../../../packages/router/test/helpers";
import { final } from "../../../packages/agent/test/helpers";
import { RuntimeBusyError } from "../src";
import { SCRIPTED, home, models, runtime, tempDir } from "./helpers";

describe("the runtime", () => {
  it("starts without a key, says what setup is needed, and becomes ready when a key is added", async () => {
    const { rt } = await runtime(home());
    expect(rt.socrates).toBeNull();
    expect(rt.setup).toEqual([expect.stringContaining("Add an API key")]);
    await rt.setKey("GEMINI_API_KEY", "test-key");
    expect(rt.setup).toEqual([]);
    expect(rt.models).toEqual({ chat: { provider: "gemini", model: "gemini-3.8-flash", source: "detected", vision: true }, router: { provider: "gemini", model: "gemini-3.8-flash", source: "detected" } });
    expect(rt.socrates).not.toBeNull();
  });

  it("uses the chosen models, and reports a chosen provider without its key", async () => {
    const { rt } = await runtime(home({ settings: { chat: { provider: "anthropic", model: "claude-opus-5-5" } }, keys: { GEMINI_API_KEY: "k" } }));
    expect(rt.models.chat).toEqual({ provider: "anthropic", model: "claude-opus-5-5", source: "settings", vision: true });
    expect(rt.models.router).toEqual({ provider: "anthropic", model: "claude-haiku-4-5", source: "settings" });
    expect(rt.socrates).toBeNull();
    expect(rt.setup).toEqual(["Missing ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN. Add it in settings."]);
  });

  it("works without embeddings, with keyword search only", async () => {
    const { rt, logs } = await runtime(home({ settings: SCRIPTED }), { ...models(), makeEmbedder: () => { throw new Error("Ollama is not installed."); } });
    expect(rt.socrates).not.toBeNull();
    expect(rt.embeddings).toEqual({ state: "unavailable", detail: "Ollama is not installed. Memory search uses keywords only." });
    expect(logs).toContain("embeddings unavailable: Ollama is not installed.");
    expect(await rt.embeddingStatus()).toBeNull();
  });

  it("interrupts turns a stopped process left running, so they can be continued", async () => {
    const config = home({ settings: SCRIPTED });
    mkdirSync(config.home, { recursive: true });
    const before = LedgerStore.open({ path: config.dbPath });
    const goal = before.createGoal({ title: "Server" });
    const task = before.createTask(goal.id, { title: "Run tests" });
    const turn = before.bindTurn({ userEventId: before.recordUserMessage("Run the tests.").id, taskId: task.id, route: "test" });
    before.close();

    const { rt, logs } = await runtime(config, models());
    expect(rt.recovered).toBe(1);
    expect(rt.store.requireTurn(turn.id).status).toBe("interrupted");
    expect(rt.store.interruption(turn.id)).toMatchObject({ reason: "restarted", tool_calls: 0 });
    expect(rt.store.requireTask(task.id).continuationNote).toBe("Interrupted when Socrates stopped after 0 tool calls.");
    expect(logs).toContain("interrupted 1 turn(s) left running when Socrates last stopped");
  });

  it("binds new work to the chosen working folder, and refuses setting changes while Socrates works", async () => {
    const folder = path.join(tempDir(), "shop");
    mkdirSync(folder);
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const { routerModel, chatModel } = models([createGoal("Shop", "Fix checkout"), continueTask()], [final()]);
    // The agent's answer waits until the test lets it through, so the turn is running meanwhile.
    const gated: ModelClient = { id: chatModel.id, complete: async (request) => (await held, chatModel.complete(request)) };
    const makeModel = (_provider: string, model: string) => (model === "router" ? routerModel : gated);
    const { rt } = await runtime(home({ settings: SCRIPTED }), { makeModel });
    const workspace = rt.store.createWorkspace("shop", folder);
    await rt.updateSettings({ workingFolder: workspace.id });

    // Changing one setting keeps the others.
    expect(rt.settings.chat).toEqual(SCRIPTED.chat);
    const running = rt.socrates!.handle("Fix the checkout in my shop.");
    await new Promise((done) => setTimeout(done, 20));
    expect(rt.busy()).toBe(true);
    await expect(rt.updateSettings({ timeZone: "Europe/Berlin" })).rejects.toThrow(RuntimeBusyError);
    await expect(rt.setKey("GEMINI_API_KEY", "x")).rejects.toThrow(RuntimeBusyError);
    release();
    const result = await running;
    expect(result.kind === "answered" && rt.store.requireGoal(result.parts[0]!.turn.goalId!).workspaceId).toBe(workspace.id);
    expect(routerModel.requests).toHaveLength(1);
    expect(chatModel.requests.length).toBeGreaterThan(0);
    await expect(rt.updateSettings({ workingFolder: "ws_missing" })).rejects.toThrow("That workspace does not exist.");
  });
});
