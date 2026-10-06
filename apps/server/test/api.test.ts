import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { HISTORY_PAGE_TURNS } from "../src";
import { PORT, SCRIPTED, home, models, server, tempDir } from "./helpers";

describe("security", () => {
  it("asks for the session everywhere but health and the launch link, and only from this server's own address", async () => {
    const { app, token, request } = await server(home());
    const raw = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { host: `127.0.0.1:${PORT}`, ...headers } });

    expect((await raw("/api/health")).json()).toEqual({ ok: true });
    expect((await raw("/api/status")).statusCode).toBe(401);
    expect((await raw("/api/status", { authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect((await request("GET", "/api/status")).statusCode).toBe(200);

    // A rebound domain or another site never reaches the API.
    expect((await raw("/api/health", { host: `evil.example:${PORT}` })).statusCode).toBe(403);
    expect((await request("GET", "/api/status", undefined, { origin: "http://evil.example" })).statusCode).toBe(403);
    expect((await request("GET", "/api/status", undefined, { origin: `http://localhost:${PORT}` })).statusCode).toBe(200);

    // The printed link becomes a strict, script-proof cookie and leaves the address bar.
    expect((await raw("/auth?token=stale")).statusCode).toBe(401);
    const login = await raw(`/auth?token=${token}`);
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe("/");
    expect(login.headers["set-cookie"]).toBe(`socrates_v2_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
    expect((await raw("/api/status", { cookie: `other=1; socrates_v2_session=${token}` })).statusCode).toBe(200);
  });
});

describe("status, settings and keys", () => {
  it("reports what is set up and never returns a key", async () => {
    const { request } = await server(home());
    expect((await request("GET", "/api/status")).json()).toMatchObject({ ready: false, setup: [expect.stringContaining("Add an API key")], busy: false, lanes: [], workingFolder: null, recovered: 0, embeddings: { provider: "ollama", state: "ready", index: { documents: 0 } } });

    expect((await request("PUT", "/api/keys/GEMINI_API_KEY", { value: " secret-value-123 " })).statusCode).toBe(204);
    const keys = await request("GET", "/api/keys");
    expect(keys.json()).toMatchObject({ GEMINI_API_KEY: true, OPENAI_API_KEY: false });
    const status = await request("GET", "/api/status");
    expect(status.json()).toMatchObject({ ready: true, setup: [], models: { chat: { provider: "gemini", source: "detected" } } });
    for (const body of [keys.body, status.body, (await request("GET", "/api/settings")).body]) expect(body).not.toContain("secret-value-123");

    expect((await request("PUT", "/api/keys/PATH", { value: "x" })).json()).toEqual({ error: { code: "invalid_request", message: expect.stringContaining("Unknown key PATH") } });
    expect((await request("DELETE", "/api/keys/GEMINI_API_KEY")).statusCode).toBe(204);
    expect((await request("GET", "/api/status")).json()).toMatchObject({ ready: false });
  });

  it("validates settings and keeps the ones not sent", async () => {
    const { request } = await server(home({ settings: SCRIPTED }), models());
    const bad = await request("PUT", "/api/settings", { timeZone: "Mars/Base" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain("IANA time zone");
    expect((await request("PUT", "/api/settings", { unknown: true })).statusCode).toBe(400);
    const saved = await request("PUT", "/api/settings", { timeZone: "Europe/Berlin" });
    expect(saved.json()).toMatchObject({ chat: SCRIPTED.chat, timeZone: "Europe/Berlin" });
    expect((await request("GET", "/api/status")).json()).toMatchObject({ ready: true, timeZone: "Europe/Berlin" });
  });
});

describe("workspaces and folders", () => {
  it("adds real project folders once, refuses the disk, the home folder and the data folder, and selects the working folder", async () => {
    const { request, rt } = await server(home({ settings: SCRIPTED }), models());
    const root = tempDir();
    const shop = path.join(root, "shop");
    const other = path.join(root, "other", "shop");
    mkdirSync(shop);
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(root, "file.txt"), "x");

    const added = (await request("POST", "/api/workspaces", { path: shop })).json();
    expect(added).toMatchObject({ name: "shop", path: shop });
    expect((await request("POST", "/api/workspaces", { path: `${shop}/` })).json()).toEqual(added);
    expect((await request("POST", "/api/workspaces", { path: other })).json()).toMatchObject({ name: "shop-2", path: other });
    const refused = async (folder: string) => (await request("POST", "/api/workspaces", { path: folder })).json().error.message;
    expect(await refused("relative/path")).toBe("Give the folder's full path.");
    expect(await refused(path.join(root, "missing"))).toBe("That folder does not exist.");
    expect(await refused(path.join(root, "file.txt"))).toBe("That folder does not exist.");
    expect(await refused("/")).toContain("not the whole disk or your home folder");
    expect(await refused(homedir())).toContain("not the whole disk or your home folder");
    expect(await refused(path.join(rt.config.home, "logs"))).toBe("That folder is Socrates' own data folder.");

    expect((await request("GET", "/api/workspaces")).json()).toHaveLength(2);
    await request("PUT", "/api/settings", { workingFolder: added.id });
    expect((await request("GET", "/api/status")).json().workingFolder).toEqual({ id: added.id, name: "shop", path: shop });
  });

  it("lists visible subfolders for the folder picker", async () => {
    const { request } = await server(home());
    const root = tempDir();
    for (const name of ["b-project", "a-project", ".hidden"]) mkdirSync(path.join(root, name));
    writeFileSync(path.join(root, "notes.txt"), "x");
    const listed = (await request("GET", `/api/folders?path=${encodeURIComponent(root)}`)).json();
    expect(listed).toEqual({ path: root, parent: path.dirname(root), folders: [{ name: "a-project", path: path.join(root, "a-project") }, { name: "b-project", path: path.join(root, "b-project") }] });
    expect((await request("GET", "/api/folders?path=relative")).statusCode).toBe(400);
    expect((await request("GET", "/api/folders")).json().path).toBe(homedir());
  });
});

describe("history and goals", () => {
  /** A finished exchange in a task, sent to main or a lane, with the given tool calls. */
  function exchange(store: LedgerStore, taskId: string, text: string, laneId: string | null = null, calls: { tool: string; input: unknown; ok: boolean }[] = []) {
    const turn = store.bindTurn({ userEventId: store.recordUserMessage(text, laneId).id, taskId, route: "test" });
    const refs = { goal_id: turn.goalId!, task_id: taskId, chat_id: turn.chatId, turn_id: turn.id };
    for (const [i, c] of calls.entries()) {
      const evidence = store.recordToolCall(refs, { callId: `call_${turn.id}_${i}`, tool: c.tool, input: c.input });
      store.recordToolResult(refs, { call_id: `call_${turn.id}_${i}`, handle: evidence.handle, tool: c.tool, status: c.ok ? "ok" : "error", content: "{}", result: null, error: c.ok ? null : { code: "failed", message: "failed" }, diagnostics: null, observed: [], facts: [], wall_time_ms: 5 } as never);
    }
    store.completeTurn(turn.id, { responseEventId: store.recordResponse(`Re: ${text}`, { turn_id: turn.id }).id });
    return store.requireTurn(turn.id);
  }

  it("shows each conversation's messages with goal, task, lane, tool calls and handoffs, newest first and paged", async () => {
    const { request, rt } = await server(home({ settings: SCRIPTED }), models());
    const store = rt.store;
    const goal = store.createGoal({ title: "Shop" });
    const checkout = store.createTask(goal.id, { title: "Checkout" });
    const docs = store.createTask(goal.id, { title: "Docs" });
    const lane = store.openLane();

    const first = exchange(store, checkout.id, "Fix checkout.", null, [{ tool: "read", input: { path: "src/cart.js" }, ok: true }, { tool: "terminal", input: { command: "npm test" }, ok: false }]);
    const inLane = exchange(store, docs.id, "Write the docs.", lane.id);
    const handed = exchange(store, docs.id, "Also add a changelog.");
    store.moveTurnToLane(handed.id, lane.id);
    const asked = store.recordUserMessage("Open the other one.");
    store.recordClarification(asked.id, "Which one?");

    const main = (await request("GET", "/api/history")).json();
    expect(main.seq).toBe(store.latestEventSeq());
    expect(main.items.every((i: {throughSeq:number}) => i.throughSeq === main.seq)).toBe(true);
    expect(main.items[2].parts[0].turnId).toBe(first.id);
    expect(main.items[2].activities.map((a: {kind:string}) => a.kind)).toEqual(["routed", "tool_started", "tool_finished", "tool_started", "tool_finished"]);
    expect(main.next).toBeNull();
    expect(main.items.map((i: { message: string }) => i.message)).toEqual(["Open the other one.", "Also add a changelog.", "Fix checkout."]);
    expect(main.items[0]).toMatchObject({ question: "Which one?", parts: [] });
    expect(main.items[1].parts[0]).toMatchObject({ lane: 1, handedOff: true, task: { number: 2, title: "Docs" }, answer: "Re: Also add a changelog." });
    expect(main.items[2].parts[0]).toMatchObject({ projectTurn: first.projectTurn, lane: null, handedOff: false, goal: { number: 1, title: "Shop" }, status: "completed", interrupted: null, toolCalls: [{ handle: "e1", line: "read src/cart.js", status: "ok" }, { handle: "e2", line: "terminal: npm test", status: "error" }] });

    const laneHistory = (await request("GET", `/api/history?conversation=${lane.id}`)).json();
    expect(laneHistory.items.map((i: { message: string; parts: { handedOff: boolean }[] }) => [i.message, i.parts[0]!.handedOff])).toEqual([["Also add a changelog.", false], ["Write the docs.", false]]);
    expect(laneHistory.items[1].parts[0].projectTurn).toBe(inLane.projectTurn);
    expect((await request("GET", "/api/history?conversation=lane_missing")).statusCode).toBe(404);
  });

  it("pages by project turn without splitting a message, and lists goals with their tasks", async () => {
    const { request, rt } = await server(home({ settings: SCRIPTED }), models());
    const store = rt.store;
    const goal = store.createGoal({ title: "Shop" });
    const task = store.createTask(goal.id, { title: "Checkout", objective: "Review checkout", completionCriteria: "Checkout review complete" });
    for (let i = 1; i <= HISTORY_PAGE_TURNS + 5; i++) exchange(store, task.id, `Message ${i}.`);
    const page1 = (await request("GET", "/api/history")).json();
    expect(page1.items).toHaveLength(HISTORY_PAGE_TURNS);
    expect(page1.items[0].message).toBe(`Message ${HISTORY_PAGE_TURNS + 5}.`);
    const page2 = (await request("GET", `/api/history?before=${page1.next}`)).json();
    expect(page2.items.map((i: { message: string }) => i.message)).toEqual(["Message 5.", "Message 4.", "Message 3.", "Message 2.", "Message 1."]);
    expect(page2.next).toBeNull();
    expect((await request("GET", "/api/history?before=zero")).statusCode).toBe(400);

    expect((await request("GET", "/api/goals")).json()).toEqual([
      expect.objectContaining({ number: goal.number, title: "Shop", workspace: null, tasks: [expect.objectContaining({ number: 1, title: "Checkout", status: "open", objective: "Review checkout", completionCriteria: "Checkout review complete" })] }),
    ]);
  });
});
