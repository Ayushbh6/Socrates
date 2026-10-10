import type { DeciderClient, DecisionRequest } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { createGoal } from "../../../packages/router/test/helpers";
import { Responder, liveServer } from "./helpers";

const isResult = (id: string) => (m: Record<string, any>) => m.type === "result" && m.id === id;
const naming = (request: { system: string }) => request.system.startsWith("You name a chat");
const isMemory = (change: string) => (m: Record<string, any>) => m.type === "activity" && m.kind === "memory" && m.change === change;

describe("memory", () => {
  it("shows what an answer saved, lists it for the Memory page, and lets the page undo, edit, add and switch it off", async () => {
    const router = new Responder("r", (_m, request) => (naming(request) ? { text: "Tooling" } : createGoal("Shop", "Set up tooling")));
    const agent = new Responder("a", () => final({ full_answer: "Noted: pnpm from now on.", memory: { save: [{ text: "Prefers pnpm over npm.", kind: "preference", scope: "user" }], forget: [] } }));
    const live = await liveServer(router, agent);
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await live.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${live.token}`, host: `127.0.0.1:${live.port}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
      return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
    };
    const p = await live.page();
    p.send({ type: "send", id: "m1", text: "Use pnpm, always.", to: "main" });
    const saved = await p.next(isMemory("saved"));
    await p.next(isResult("m1"));
    const turnId = live.rt.store.listEvents({ type: "turn_bound" }).at(-1)!.turn_id!;
    expect(saved).toMatchObject({ turnId, memory: { handle: "m1", number: 1, text: "Prefers pnpm over npm.", kind: "preference", everywhere: true } });

    const listed = await call("GET", "/api/memories");
    expect(listed.body).toEqual([expect.objectContaining({ number: 1, handle: "m1", kind: "preference", text: "Prefers pnpm over npm.", by: "agent", goal: null, alwaysOn: true, source: expect.objectContaining({ goal: { number: 1, title: "Shop" }, task: { number: 1, title: "Set up tooling" } }) })]);
    // The exchange's history keeps the note.
    const history = await call("GET", "/api/history");
    expect(history.body.items[0].activities.filter((a: { kind: string }) => a.kind === "memory")).toMatchObject([{ change: "saved", memory: { number: 1 } }]);

    // Undo from under the answer: recorded on that turn, so its exchange shows it.
    expect((await call("DELETE", "/api/memories/1")).status).toBe(204);
    expect(await p.next(isMemory("forgotten"))).toMatchObject({ turnId, memory: { number: 1 } });
    expect((await call("GET", "/api/memories")).body).toEqual([]);
    expect((await call("DELETE", "/api/memories/1")).status).toBe(404);

    const added = await call("POST", "/api/memories", { text: "Lives in Berlin.", kind: "about", goal: null });
    expect(added).toMatchObject({ status: 200, body: { number: 2, by: "user", source: null, alwaysOn: true } });
    expect((await call("PATCH", "/api/memories/2", { text: "Lives in Berlin (CET)." })).body).toMatchObject({ text: "Lives in Berlin (CET)." });
    expect(await call("POST", "/api/memories", { text: "My token is abcd1234", kind: "about", goal: null })).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("does not remember secrets") } } });
    expect((await call("POST", "/api/memories", { text: "Uses tabs.", kind: "preference", goal: 99 })).status).toBe(404);
    expect((await call("POST", "/api/memories", { text: "Uses tabs.", kind: "preference", goal: 1 })).body).toMatchObject({ goal: { number: 1, title: "Shop" } });

    // The switches change at once, one at a time, without a restart.
    const socrates = live.rt.socrates;
    expect((await call("PUT", "/api/settings", { memory: { save: false } })).body.memory).toEqual({ save: false, use: true, decider: true });
    expect(live.rt.socrates).toBe(socrates);
    p.send({ type: "send", id: "m2", text: "And use pnpm again.", to: "main" });
    await p.next(isResult("m2"));
    expect(live.rt.store.listMemories().map((m) => m.handle)).toEqual(["m3", "m2"]);
  });

  it("asks the decider about each message, records the call with its price, and follows the switch and the key", async () => {
    const asked: DecisionRequest[] = [];
    const decider: DeciderClient = {
      id: "openrouter:perplexity/pplx-decider-v1.1-27b",
      async decide(request) {
        asked.push(request);
        return { model: "perplexity/pplx-decider-v1.1-27b-20261006", probabilities: { recall: 0.2, save: 0.95 }, usage: { inputTokens: 40, outputTokens: 1, costUsd: 0.0000008 }, id: "gen-dec-1" };
      },
    };
    const router = new Responder("r", (_m, request) => (naming(request) ? { text: "Tooling" } : createGoal("Shop", "Set up tooling")));
    const agent = new Responder("a", () => final({ full_answer: "Noted." }));
    const live = await liveServer(router, agent, { deps: { makeDecider: () => decider } });
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await live.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${live.token}`, host: `127.0.0.1:${live.port}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
      return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
    };
    expect((await call("GET", "/api/status")).body.decider).toBe("ready");
    const p = await live.page();
    p.send({ type: "send", id: "m1", text: "I always want short answers.", to: "main" });
    await p.next(isResult("m1"));
    await live.rt.flushCalls();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.state).toBe("I always want short answers.");
    expect(Object.keys(asked[0]!.questions)).toEqual(["recall", "save"]);
    const [decision] = live.rt.calls!.list({ role: "decision" });
    expect(decision).toMatchObject({ role: "decision", model: "openrouter:perplexity/pplx-decider-v1.1-27b", ok: true, promptTokens: 40, costUsd: 0.0000008, userEventId: expect.any(String) });
    expect(live.rt.calls!.get(decision!.id)?.response?.text).toBe('{"recall":0.2,"save":0.95}');

    // The Inspect page's rates: a likely save the agent did not take up shows as such.
    expect((await call("GET", "/api/observe/decider?range=all")).body).toMatchObject({
      answered: 1, failed: 0, medianMs: expect.any(Number), costUsd: 0.0000008,
      recall: { likely: 0, likelyOffered: 0, unlikely: 1, unlikelyOffered: 0 },
      save: { likely: 1, likelySaved: 0, unlikely: 0, unlikelySaved: 0 },
    });

    // Switched off in settings: not asked, no rebuild.
    const socrates = live.rt.socrates;
    expect((await call("PUT", "/api/settings", { memory: { decider: false } })).body.memory).toEqual({ save: true, use: true, decider: false });
    expect(live.rt.socrates).toBe(socrates);
    expect((await call("GET", "/api/status")).body.decider).toBe("off");
    p.send({ type: "send", id: "m2", text: "And again.", to: "main" });
    await p.next(isResult("m2"));
    expect(asked).toHaveLength(1);
  });

  it("reports no decider without an OpenRouter key", async () => {
    const live = await liveServer(new Responder("r", () => createGoal("Shop", "x")), new Responder("a", () => final()), { deps: { makeDecider: () => null } });
    const response = await live.app.inject({ method: "GET", url: "/api/status", headers: { authorization: `Bearer ${live.token}`, host: `127.0.0.1:${live.port}` } });
    expect(JSON.parse(response.body).decider).toBe("no_key");
  });
});
