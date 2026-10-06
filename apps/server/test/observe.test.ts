import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ModelClient, ModelUsage } from "@socrates/contracts";
import { ScriptedModel } from "@socrates/providers";
import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { continueTask, createGoal } from "../../../packages/router/test/helpers";
import { SCRIPTED, home, server } from "./helpers";

/** A scripted model whose replies report this usage and provider metadata, the way a provider's would. */
function metered(inner: ScriptedModel, usage: ModelUsage, meta: Record<string, unknown> = { id: "resp_1" }): ModelClient {
  return { id: inner.id, complete: async (request) => ({ ...(await inner.complete(request)), usage, meta, servedBy: "served-1" }) };
}

const USAGE = { promptTokens: 2000, outputTokens: 100, cacheReadTokens: 1500, cacheWriteTokens: 0 };
const PRICE = { input: 1, cachedInput: 0.1, cacheWrite: null, output: 5 };

function observed(options: { router?: Parameters<typeof createGoal>[0][]; prices?: boolean } = {}) {
  const router = new ScriptedModel("test:router", [createGoal("Shop", "Fix checkout"), continueTask()]);
  const chat = new ScriptedModel("test:chat", [final({ full_answer: "Fixed." }), final({ full_answer: "Fixed again." })]);
  const makeModel = (_p: string, model: string): ModelClient => metered(model === "router" ? router : chat, USAGE);
  return { router, chat, deps: { makeModel, listPrice: async () => PRICE } };
}

describe("the model-call log", () => {
  it("records the router's and the working agent's calls for a message, with their cost", async () => {
    const { deps } = observed();
    const { rt, request } = await server(home({ settings: SCRIPTED }), deps);
    const result = await rt.socrates!.handle("Fix the checkout in my shop.");
    expect(result.kind).toBe("answered");
    await rt.flushCalls();

    const turn = result.kind === "answered" ? result.parts[0]!.turn : null;
    const list = (await request("GET", "/api/observe/questions?range=all")).json();
    expect(list.questions).toHaveLength(1);
    const q = list.questions[0];
    expect(q).toMatchObject({ userEventId: turn!.userEventId, message: "Fix the checkout in my shop.", outcome: "routed", lane: null, calls: 2 });
    expect(q.parts).toEqual([{ to: { goal: { number: 1, title: "Shop" }, task: { number: 1, title: "Fix checkout" } }, move: "new_goal" }]);
    // 2 calls of 2000 prompt tokens (1500 cached) and 100 output: (500*1 + 1500*0.1 + 100*5) / 1e6 each.
    expect(q).toMatchObject({ promptTokens: 4000, cacheReadTokens: 3000, cacheHitRate: 0.75, outputTokens: 200, priced: 2 });
    expect(q.costUsd).toBeCloseTo(2 * (500 + 150 + 500) / 1e6, 10);

    const detail = (await request("GET", `/api/observe/questions/${q.userEventId}`)).json();
    expect(detail.calls.map((c: { role: string }) => c.role)).toEqual(["router", "work"]);
    expect(detail.calls[1]).toMatchObject({ turnId: turn!.id, goalId: turn!.goalId, taskId: turn!.taskId, chatId: turn!.chatId, step: 1, model: "test:chat", servedBy: "served-1", costSource: "price" });
    expect(detail.routing).toMatchObject({ attempts: 1, escalated: false, fallback: null, reason: "test" });
    expect(detail.parts[0]).toMatchObject({ move: "new_goal", from: null, to: { task: { title: "Fix checkout" } } });
  });

  it("shows the context a call was given, cut into its blocks, and how big each message is", async () => {
    const { deps } = observed();
    const { rt, request } = await server(home({ settings: { ...SCRIPTED, profile: { name: "Ada", onboarded: true } } }), deps);
    await rt.socrates!.handle("Fix the checkout in my shop.");
    await rt.flushCalls();
    const [work] = (await request("GET", "/api/observe/questions?range=all")).json().questions;
    const calls = (await request("GET", `/api/observe/questions/${work.userEventId}`)).json().calls;
    const call = (await request("GET", `/api/observe/calls/${calls[1].id}`)).json();
    const names = call.blocks.map((b: { name: string | null }) => b.name);
    expect(names).toEqual(expect.arrayContaining(["USER", "GOAL", "CURRENT_TASK", "CURRENT_USER_MESSAGE"]));
    expect(call.blocks.find((b: { name: string }) => b.name === "USER").text).toContain("Ada");
    expect(call.blocks.every((b: { tokens: number }) => b.tokens > 0)).toBe(true);
    expect(call.sizes.system).toBeGreaterThan(100);
    expect(call.sizes.tools).toBeGreaterThan(100);
    expect(call.sizes.messages[0]).toMatchObject({ index: 0, role: "user" });
    expect(call.request.system).toContain("Socrates");
    expect(call.request.tools.length).toBeGreaterThan(5);
    expect(call.response).toMatchObject({ meta: { id: "resp_1" } });
    expect(call.response.text).toContain("Fixed.");

    const router = (await request("GET", `/api/observe/calls/${calls[0].id}`)).json();
    expect(router.role).toBe("router");
    expect(router.response.text).toContain("create_new");
  });

  it("says where a message moved the work: continued, in the same task", async () => {
    const { deps } = observed();
    const { rt, request } = await server(home({ settings: SCRIPTED }), deps);
    await rt.socrates!.handle("Fix the checkout in my shop.");
    await rt.socrates!.handle("Now check the cart too.");
    await rt.flushCalls();
    const [second] = (await request("GET", "/api/observe/questions?range=all")).json().questions;
    expect(second.message).toBe("Now check the cart too.");
    const detail = (await request("GET", `/api/observe/questions/${second.userEventId}`)).json();
    expect(detail.parts[0]).toMatchObject({ move: "continued", from: { task: { number: 1 } }, to: { task: { number: 1 } } });
  });

  it("adds up the day: cache hit rate, the working agent on its own, and the models with no price", async () => {
    const { deps } = observed();
    const { rt, request } = await server(home({ settings: SCRIPTED }), { ...deps, listPrice: async (_p, model) => (model === "router" ? null : PRICE) });
    await rt.socrates!.handle("Fix the checkout in my shop.");
    await rt.flushCalls();
    const s = (await request("GET", "/api/observe/summary?range=24h")).json();
    expect(s.totals).toMatchObject({ failed: 0, promptTokens: 4000, cacheReadTokens: 3000, cacheHitRate: 0.75 });
    expect(s.work).toMatchObject({ calls: 1, promptTokens: 2000, cacheHitRate: 0.75, priced: 1 });
    expect(s.byModel.map((r: { role: string; model: string }) => `${r.role}:${r.model}`).sort()).toEqual(expect.arrayContaining(["router:test:router", "work:test:chat"]));
    expect(s.unpriced).toEqual(["test:router"]);
    expect(s.unpricedCalls).toBe(1);
    expect(s.retentionDays).toBe(30);
    expect((await request("GET", "/api/observe/summary?range=weekly")).statusCode).toBe(400);
  });

  it("prices calls from the user's own price over the list price, and takes a change at once", async () => {
    const { deps } = observed();
    const { rt, request } = await server(home({ settings: SCRIPTED }), deps);
    await request("PUT", "/api/settings", { prices: { "test:chat": { input: 10, cachedInput: 1, output: 50 } } });
    await rt.socrates!.handle("Fix the checkout in my shop.");
    await rt.flushCalls();
    const [q] = (await request("GET", "/api/observe/questions?range=all")).json().questions;
    const work = (await request("GET", `/api/observe/questions/${q.userEventId}`)).json().calls[1];
    // 500 plain at 10, 1500 cached at 1, 100 output at 50.
    expect(work.costUsd).toBeCloseTo((5000 + 1500 + 5000) / 1e6, 10);
    const table = (await request("GET", "/api/observe/prices")).json();
    expect(table).toEqual(expect.arrayContaining([{ model: "test:chat", source: "settings", price: { input: 10, cachedInput: 1, cacheWrite: null, output: 50 } }, { model: "test:router", source: "list", price: PRICE }]));
  });

  it("uses the cost a provider reports in preference to any price", async () => {
    const router = new ScriptedModel("test:router", [createGoal("Shop", "Fix checkout")]);
    const chat = new ScriptedModel("test:chat", [final()]);
    const { rt, request } = await server(home({ settings: SCRIPTED }), { makeModel: (_p, model) => metered(model === "router" ? router : chat, USAGE, { usage: { cost: 0.5 } }), listPrice: async () => PRICE });
    await rt.socrates!.handle("Fix the checkout in my shop.");
    await rt.flushCalls();
    const [q] = (await request("GET", "/api/observe/questions?range=all")).json().questions;
    expect(q.costUsd).toBe(1);
    expect((await request("GET", `/api/observe/questions/${q.userEventId}`)).json().calls[0]).toMatchObject({ costSource: "reported", costUsd: 0.5 });
  });

  it("logs the embeddings it makes, without tokens", async () => {
    const { deps } = observed();
    const { rt, request } = await server(home({ settings: SCRIPTED }), deps);
    await rt.flushCalls();
    const s = (await request("GET", "/api/observe/summary?range=all")).json();
    expect(s.byModel.find((r: { role: string }) => r.role === "embedding")).toMatchObject({ calls: 1, failed: 0, promptTokens: 0 });
    // They are not in the unpriced list: an embedding model has no token price here.
    expect(s.unpriced).toEqual([]);
    expect(s.unpricedCalls).toBe(0);
  });

  it("answers 404 for what does not exist", async () => {
    const { request } = await server(home({ settings: SCRIPTED }), observed().deps);
    expect((await request("GET", "/api/observe/calls/call_nope")).statusCode).toBe(404);
    expect((await request("GET", "/api/observe/questions/evt_nope")).statusCode).toBe(404);
  });

  it("keeps Socrates working when the call log cannot be opened", async () => {
    const config = home({ settings: SCRIPTED });
    // A folder where the file belongs.
    mkdirSync(path.join(config.home, "calls.db"), { recursive: true });
    const { rt, request, logs } = await server(config, observed().deps);
    expect(rt.calls).toBeNull();
    expect(logs.some((l) => l.startsWith("the call log is unavailable"))).toBe(true);
    expect((await rt.socrates!.handle("Fix the checkout in my shop.")).kind).toBe("answered");
    expect((await request("GET", "/api/observe/summary")).statusCode).toBe(503);
  });

  it("forgets calls older than the retention period when it starts", async () => {
    const config = home({ settings: SCRIPTED });
    const first = await server(config, observed().deps);
    await first.rt.socrates!.handle("Fix the checkout in my shop.");
    await first.rt.flushCalls();
    expect(first.rt.calls!.list({ role: "router" })).toHaveLength(1);
    await first.rt.close();
    // Thirty-one days later (the test clock stands at 2026-10-04).
    const later = await server(config, { ...observed().deps, clock: { now: () => new Date("2026-11-10T00:00:00Z") } });
    // Only what the restart itself made (its embedding probe) remains.
    expect(later.rt.calls!.list().map((c) => c.role)).toEqual(["embedding"]);
  });
});
