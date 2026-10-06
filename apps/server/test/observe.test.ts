import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CallRecord, ModelClient, ModelMessage, ModelUsage } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import { ScriptedModel } from "@socrates/providers";
import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { continueTask, createGoal } from "../../../packages/router/test/helpers";
import { SCRIPTED, home, server, tempDir } from "./helpers";
import { series as chartSeries, summary as overviewSummary } from "../src/observe";

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
    expect(s.totals.calls).toBe(0);
    expect(s.totals.failed).toBe(0);
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
    // Close the live hub before its ledger, as the executable does on restart.
    await first.app.close();
    await first.rt.close();
    // Thirty-one days later (the test clock stands at 2026-10-04).
    const later = await server(config, { ...observed().deps, clock: { now: () => new Date("2026-11-10T00:00:00Z") } });
    // Only what the restart itself made (its embedding probe) remains.
    expect(later.rt.calls!.list().map((c) => c.role)).toEqual(["embedding"]);
  });
});

describe("the trace of a message", () => {
  it("lists what happened in order: the message, the router, its decision, the agent's steps with their tool results, and the answer", async () => {
    const folder = path.join(tempDir(), "shop");
    mkdirSync(folder);
    writeFileSync(path.join(folder, "notes.txt"), "the vault code is ORBIT-6382\n");
    const router = new ScriptedModel("test:router", [createGoal("Shop", "Read the notes")]);
    const chat = new ScriptedModel("test:chat", [
      { toolCalls: [{ name: "read", input: { path: path.join(folder, "notes.txt") } }], reasoning: "I should read the notes first." },
      final({ full_answer: "The code is ORBIT-6382." }),
    ]);
    const { rt, request } = await server(home({ settings: SCRIPTED }), { makeModel: (_p, model) => metered(model === "router" ? router : chat, USAGE), listPrice: async () => PRICE });
    const workspace = rt.store.createWorkspace("shop", folder);
    await rt.updateSettings({ workingFolder: workspace.id });
    const result = await rt.socrates!.handle("What is the vault code in my notes?");
    expect(result.kind).toBe("answered");
    await rt.flushCalls();
    const [q] = (await request("GET", "/api/observe/questions?range=all")).json().questions;

    const trace = (await request("GET", `/api/observe/questions/${q.userEventId}/trace`)).json();
    expect(trace.items.map((i: { kind: string }) => i.kind)).toEqual(["user", "call", "routing", "turn", "call", "call", "answer"]);
    expect(trace.items[0]).toMatchObject({ kind: "user", text: "What is the vault code in my notes?", lane: null });
    const [, routerCall, routing, turn, first, second, answer] = trace.items;
    expect(routerCall).toMatchObject({ group: "router", call: { role: "router" } });
    expect(routerCall.context.map((b: { name: string }) => b.name)).toEqual(expect.arrayContaining(["RECENT_EXACT_HISTORY", "KNOWN_GOALS", "CURRENT_USER_MESSAGE"]));
    expect(routing).toMatchObject({ routing: { attempts: 1 } });
    expect(turn.part).toMatchObject({ move: "new_goal", to: { task: { title: "Read the notes" } } });

    // The first agent step: its context in blocks, its thinking, and the read it called with the file as the tool answered.
    expect(first).toMatchObject({ group: "turn", reasoning: "I should read the notes first.", entered: [], rebuilt: false });
    expect(first.context.map((b: { name: string }) => b.name)).toEqual(expect.arrayContaining(["GOAL", "CURRENT_TASK", "CURRENT_USER_MESSAGE"]));
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]).toMatchObject({ name: "read", result: { isError: false } });
    expect(first.toolCalls[0].result.content).toContain("ORBIT-6382");
    expect(first.toolCalls[0].result.tokens).toBe(countTokens(first.toolCalls[0].result.content));
    expect(first.reasoningTextTokens).toBe(countTokens(first.reasoning));
    // The second step was sent its own reply back and the tool's result, and nothing else.
    expect(second.context).toBeNull();
    expect(second.entered.map((e: { label: string }) => e.label)).toEqual(["its own reply, sent back", "tool result · read"]);
    expect(second.entered[1].text).toContain("ORBIT-6382");
    expect(second.entered.every((e: { tokens: number }) => e.tokens > 0)).toBe(true);
    expect(answer).toMatchObject({ kind: "answer", status: "completed", text: "The code is ORBIT-6382." });
    expect((await request("GET", "/api/observe/questions/evt_nope/trace")).statusCode).toBe(404);
  });

  it("shows rewritten messages of unchanged length and keeps tool results after a context update", async () => {
    const { rt, request } = await server(home({ settings: SCRIPTED }), observed().deps);
    await rt.socrates!.handle("Fix the checkout in my shop.");
    await rt.flushCalls();
    const original = rt.calls!.get(rt.calls!.list({ role: "work" })[0]!.id)!;
    const tool = { id: "tool_read", name: "read", input: { path: "notes.txt" } };
    const record = (id: string, messages: ModelMessage[], toolCalls: NonNullable<CallRecord["response"]>["toolCalls"]): CallRecord => ({
      id, startedAt: id === "call_before" ? "2026-10-04T10:00:01.000Z" : "2026-10-04T10:00:02.000Z", model: "test:chat", servedBy: null,
      trace: { role: "work", userEventId: original.userEventId, turnId: original.turnId }, streamed: false,
      request: { ...original.request, toolChoice: "auto", messages },
      response: { text: "", toolCalls, reasoning: null, stopReason: "tool_use", usage: USAGE, meta: null },
      error: null, ms: 100, firstTokenMs: null, tokensPerSecond: 1000, cost: null,
    });
    const oldAssistant: ModelMessage = { role: "assistant", content: "Reading.", raw: { provider: "gemini", content: [{ type: "text", text: "old" }] } };
    const newAssistant: ModelMessage = { ...oldAssistant, content: "Updated reading." };
    const firstContext = original.request.messages[0]!;
    rt.calls!.record(record("call_before", [firstContext, oldAssistant], [tool]));
    rt.calls!.record(record("call_after", [firstContext, newAssistant], [tool]));
    let trace = (await request("GET", `/api/observe/questions/${original.userEventId}/trace`)).json();
    expect(trace.items.find((i: { call?: { id: string } }) => i.call?.id === "call_after").entered).toMatchObject([{ text: "Updated reading." }]);

    const updated = record("call_updated", [{ role: "user", content: "<CURRENT_TASK>\nUpdated task\n</CURRENT_TASK>" }, newAssistant, { role: "tool", toolCallId: tool.id, toolName: "read", content: "the exact result" }], []);
    updated.startedAt = "2026-10-04T10:00:03.000Z";
    rt.calls!.record(updated);
    trace = (await request("GET", `/api/observe/questions/${original.userEventId}/trace`)).json();
    expect(trace.items.find((i: { call?: { id: string } }) => i.call?.id === "call_after").toolCalls[0].result).toMatchObject({ content: "the exact result", tokens: countTokens("the exact result") });
    expect(trace.items.find((i: { call?: { id: string } }) => i.call?.id === updated.id)).toMatchObject({ rebuilt: true, entered: [{ text: "Updated reading." }, { text: "the exact result" }] });
  });
});

describe("the charts' series", () => {
  it("keeps the same rolling cutoff as the totals, even inside an hour bucket", async () => {
    const { rt } = await server(home({ settings: SCRIPTED }), observed().deps);
    for (const minute of [15, 45]) rt.calls!.record({
      id: `call_${minute}`, startedAt: `2026-10-03T10:${minute}:00.000Z`, model: "test:m", servedBy: null, streamed: false, trace: { role: "other" },
      request: { system: "", messages: [], tools: [], toolChoice: "auto", maxOutputTokens: null, temperature: null, effort: null },
      response: { text: "ok", toolCalls: [], reasoning: null, stopReason: "end", usage: USAGE, meta: null }, error: null,
      ms: 1000, firstTokenMs: null, tokensPerSecond: 100, cost: null,
    });
    const now = new Date("2026-10-04T10:30:00Z");
    const summary = overviewSummary(rt.calls!, "24h", now, 30);
    const series = chartSeries(rt.calls!, "24h", now);
    expect(summary.totals.calls).toBe(1);
    expect(series.buckets.reduce((n: number, b: { calls: number }) => n + b.calls, 0)).toBe(1);
    expect(series.buckets[0]!.at).toBe("2026-10-03T10:00:00.000Z");
  });

  it("covers the range with its buckets and sums the model calls into them", async () => {
    const { deps } = observed();
    const { rt, request } = await server(home({ settings: SCRIPTED }), deps);
    await rt.socrates!.handle("Fix the checkout in my shop.");
    await rt.flushCalls();
    const s = (await request("GET", "/api/observe/series?range=24h")).json();
    expect(s.bucketMs).toBe(3_600_000);
    expect(s.at.length).toBeGreaterThanOrEqual(24);
    const roles = new Map<string, number>();
    for (const b of s.buckets) roles.set(b.role, (roles.get(b.role) ?? 0) + b.calls);
    expect([...roles]).toEqual(expect.arrayContaining([["router", 1], ["work", 1]]));
    expect(s.buckets.some((b: { role: string }) => b.role === "embedding")).toBe(false);
    expect((await request("GET", "/api/observe/series?range=1y")).statusCode).toBe(400);
    const recent = (await request("GET", "/api/observe/recent?limit=50")).json() as { role: string }[];
    expect(recent.map((c) => c.role)).toEqual(expect.arrayContaining(["router", "work", "embedding"]));
    expect((await request("GET", "/api/observe/recent?limit=2")).json()).toHaveLength(2);
    const costly = (await request("GET", "/api/observe/costly?range=all")).json();
    expect(costly).toHaveLength(1);
    expect(costly[0]).toMatchObject({ message: "Fix the checkout in my shop." });
  });
});

describe("the database view", () => {
  it("counts the databases, tables and records, and the files beside them", async () => {
    const { deps } = observed();
    const { rt, request } = await server(home({ settings: SCRIPTED }), deps);
    await rt.socrates!.handle("Fix the checkout in my shop.");
    await rt.flushCalls();
    const data = (await request("GET", "/api/observe/db")).json();
    expect(data.databases.map((d: { id: string }) => d.id)).toEqual(["ledger", "calls"]);
    const ledger = data.databases[0];
    const events = ledger.tables.find((t: { name: string }) => t.name === "events");
    expect(events).toMatchObject({ kind: "table" });
    expect(events.rows).toBe(rt.store.latestEventSeq());
    expect(ledger.tables.find((t: { name: string }) => t.name === "ledger_fts")).toMatchObject({ kind: "virtual" });
    expect(ledger.tables.find((t: { name: string }) => t.name === "ledger_fts_data")).toMatchObject({ kind: "internal" });
    expect(ledger.records).toBe(ledger.tables.filter((t: { kind: string }) => t.kind !== "internal").reduce((n: number, t: { rows: number }) => n + t.rows, 0));
    expect(data.totals.databases).toBe(2);
    expect(data.totals.tables).toBe(data.databases.reduce((n: number, d: { tables: { kind: string }[] }) => n + d.tables.filter((t) => t.kind !== "internal").length, 0));
    expect(data.totals.records).toBeGreaterThan(events.rows);
    expect(data.files.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(["ledger.db.lance", "logs"]));
  });

  it("pages, orders and searches a table, and opens one row whole", async () => {
    const { deps } = observed();
    const { rt, request } = await server(home({ settings: SCRIPTED }), deps);
    await rt.socrates!.handle("Fix the checkout in my shop.");
    await rt.flushCalls();
    const page = (await request("GET", "/api/observe/db/ledger/events?limit=3&order=seq&dir=asc")).json();
    expect(page.columns.map((c: { name: string }) => c.name)).toEqual(["seq", "id", "type", "at", "goal_id", "task_id", "chat_id", "turn_id", "payload"]);
    expect(page.rows).toHaveLength(3);
    expect(page.rows.map((r: unknown[]) => r[0])).toEqual([1, 2, 3]);
    expect(page.total).toBe(rt.store.latestEventSeq());
    const found = (await request("GET", "/api/observe/db/ledger/events?q=Fix%20the%20checkout&limit=10")).json();
    expect(found.matched).toBeGreaterThan(0);
    expect(found.matched).toBeLessThan(found.total);
    expect(found.rows.some((r: unknown[]) => r[2] === "user_message")).toBe(true);
    // A search for text with LIKE wildcards in it is a search for that text.
    expect((await request("GET", "/api/observe/db/ledger/events?q=%25&limit=5")).json().matched).toBe(0);
    const whole = (await request("GET", `/api/observe/db/ledger/events/${page.ids[0]}`)).json();
    expect(whole.values[0]).toBe(1);
    expect(whole.columns).toHaveLength(whole.values.length);
  });

  it("opens the compressed parts of a request as the text they hold", async () => {
    const { deps } = observed();
    const { rt, request } = await server(home({ settings: SCRIPTED }), deps);
    await rt.socrates!.handle("Fix the checkout in my shop.");
    await rt.flushCalls();
    const blobs = (await request("GET", "/api/observe/db/calls/blobs?limit=200")).json();
    const data = blobs.columns.findIndex((c: { name: string }) => c.name === "data");
    expect(blobs.rows.some((r: string[]) => String(r[data]).startsWith("‹compressed"))).toBe(true);
    const index = blobs.rows.findIndex((r: string[]) => String(r[data]).includes("Fix the checkout"));
    expect(index).toBeGreaterThanOrEqual(0);
    const whole = (await request("GET", `/api/observe/db/calls/blobs/${blobs.ids[index]}`)).json();
    expect(String(whole.values[data])).toContain("Fix the checkout in my shop.");
  });

  it("opens only the two databases, and only tables and columns they list", async () => {
    const { request } = await server(home({ settings: SCRIPTED }), observed().deps);
    expect((await request("GET", "/api/observe/db/keys/events")).statusCode).toBe(404);
    expect((await request("GET", "/api/observe/db/ledger/no_such_table")).statusCode).toBe(400);
    expect((await request("GET", `/api/observe/db/ledger/${encodeURIComponent('events"; DROP TABLE events; --')}`)).statusCode).toBe(400);
    // An order that is not a column is ignored, not put in the query.
    const page = await request("GET", `/api/observe/db/ledger/events?order=${encodeURIComponent("seq; DROP TABLE events")}`);
    expect(page.statusCode).toBe(200);
    expect((await request("GET", "/api/observe/db/ledger/events/1abc")).statusCode).toBe(404);
    expect((await request("GET", "/api/observe/db/ledger/events/999999")).statusCode).toBe(404);
    expect((await request("GET", "/api/observe/db/ledger/events?limit=9999")).statusCode).toBe(400);
  });
});
