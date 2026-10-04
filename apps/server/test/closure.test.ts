import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HashEmbedder } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { createGoal, decision, defineTask } from "../../../packages/router/test/helpers";
import { call, final } from "../../../packages/agent/test/helpers";
import { Runtime, RuntimeBusyError, Settings, conversationHistory, fileLog, prepareHome, readKeys, resolveConfig, writeKey } from "../src";
import { PORT, SCRIPTED, home, models, runtime, server, tempDir } from "./helpers";

function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("S1 review regressions", () => {
  it("refuses aliases and new subfolders of classic data before creating anything", () => {
    const root = tempDir();
    const classic = path.join(root, "classic");
    mkdirSync(classic);
    writeFileSync(path.join(classic, "socrates.sqlite"), "old data");
    const alias = path.join(root, "alias");
    symlinkSync(classic, alias);
    for (const folder of [classic, alias, path.join(alias, "new-v2")]) {
      expect(() => prepareHome(resolveConfig({ SOCRATES_HOME: folder }))).toThrow("belongs to Socrates 0.1");
    }
    expect(existsSync(path.join(classic, "new-v2"))).toBe(false);
    expect(readFileSync(path.join(classic, "socrates.sqlite"), "utf8")).toBe("old data");
    for (const folder of [homedir(), path.dirname(homedir()), "/"]) expect(() => prepareHome(resolveConfig({ SOCRATES_HOME: folder }))).toThrow("dedicated data folder");
  });

  it("makes an existing home private and refuses managed paths pointing outside it", () => {
    const config = home();
    mkdirSync(path.join(config.home, "logs"));
    writeFileSync(config.keysPath, "");
    chmodSync(config.home, 0o755);
    chmodSync(path.join(config.home, "logs"), 0o755);
    chmodSync(config.keysPath, 0o644);
    prepareHome(config);
    expect(statSync(config.home).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(config.home, "logs")).mode & 0o777).toBe(0o700);
    expect(statSync(config.keysPath).mode & 0o777).toBe(0o600);
    rmSync(config.keysPath);
    const outside = path.join(tempDir(), "keys");
    writeFileSync(outside, "preserve me", { mode: 0o644 });
    symlinkSync(outside, config.keysPath);
    expect(() => prepareHome(config)).toThrow("must not be a symbolic link");
    expect(readFileSync(outside, "utf8")).toBe("preserve me");
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  });

  it("round-trips literal backslashes and env metacharacters in keys", () => {
    const file = path.join(tempDir(), ".env");
    const value = String.raw`token\n\r\end#$value=other`;
    writeKey(file, "GEMINI_API_KEY", value);
    expect(readKeys(file).GEMINI_API_KEY).toBe(value);
    writeKey(file, "OPENAI_API_KEY", "another-key");
    expect(readKeys(file).GEMINI_API_KEY).toBe(value);
  });

  it("rejects unusable or credential-bearing embedding URLs", () => {
    for (const url of ["file:///tmp/index", "https://user:password@example.com", "https://example.com?key=secret", "https://example.com#x"]) {
      expect(() => Settings.parse({ embeddings: { provider: "custom", model: "test", url } })).toThrow("HTTP or HTTPS base URL");
    }
  });

  it("holds one data-home owner before recovery, and releases ownership on close", async () => {
    const config = home();
    const { rt } = await runtime(config);
    const goal = rt.store.createGoal({ title: "Live owner" });
    const task = rt.store.createTask(goal.id, { title: "Still working" });
    const turn = rt.store.bindTurn({ userEventId: rt.store.recordUserMessage("Work.").id, taskId: task.id, route: "test" });
    await expect(Runtime.open(config, { env: {} })).rejects.toThrow("already using");
    expect(rt.store.requireTurn(turn.id).status).toBe("in_progress");
    await Promise.all([rt.close(), rt.close()]);
    const restarted = await runtime(config);
    expect(restarted.rt.recovered).toBe(1);
    expect(restarted.rt.store.requireTurn(turn.id).status).toBe("interrupted");
  });

  it("does not recover turns with invalid settings, and releases a failed startup's lock", async () => {
    const config = home();
    const store = LedgerStore.open({ path: config.dbPath });
    const goal = store.createGoal({ title: "Keep evidence" });
    const task = store.createTask(goal.id, { title: "Interrupted work" });
    const turn = store.bindTurn({ userEventId: store.recordUserMessage("Work.").id, taskId: task.id, route: "test" });
    store.close();
    writeFileSync(config.settingsPath, "{broken");
    await expect(Runtime.open(config, { env: {} })).rejects.toThrow("not valid JSON");
    const inspection = LedgerStore.open({ path: config.dbPath });
    expect(inspection.requireTurn(turn.id).status).toBe("in_progress");
    inspection.close();
    writeFileSync(config.settingsPath, "{}");
    expect((await runtime(config)).rt.recovered).toBe(1);
  });

  it("probes a real embedding request instead of equating an open index with readiness", async () => {
    const client = new HashEmbedder();
    client.failing = true;
    const { rt } = await runtime(home({ settings: SCRIPTED }), { ...models(), makeEmbedder: () => client });
    expect(client.calls).toBe(1);
    expect(rt.socrates).not.toBeNull();
    expect(rt.embeddings.state).toBe("unavailable");
    expect(await rt.embeddingStatus()).toBeNull();
  });

  it("bounds an embedding probe even when the client ignores cancellation", async () => {
    const { rt } = await runtime(home(), { embeddingProbeTimeoutMs: 20, makeEmbedder: () => ({ id: "stalled", embed: () => new Promise(() => {}) }) });
    expect(rt.embeddings.state).toBe("unavailable");
    expect(rt.embeddings.detail).toContain("keywords only");
  });

  it("cancels startup and releases its data-home ownership", async () => {
    const config = home();
    const started = held();
    const abort = new AbortController();
    const opening = Runtime.open(config, { env: {}, signal: abort.signal, makeEmbedder: () => ({ id: "stalled", embed: () => { started.release(); return new Promise(() => {}); } }) });
    const rejected = expect(opening).rejects.toThrow();
    await started.promise;
    abort.abort();
    await rejected;
    expect((await runtime(config)).rt).toBeDefined();
  });

  it("claims the whole rebuild, rejects overlapping changes, and drains it before closing", async () => {
    const started = held();
    const gate = held();
    let builds = 0;
    const config = home({ settings: SCRIPTED });
    const { rt } = await runtime(config, { ...models(), makeEmbedder: () => {
      const client = new HashEmbedder();
      if (++builds !== 2) return client;
      return { id: client.id, embed: async (texts, purpose, signal) => { started.release(); await gate.promise; return client.embed(texts, purpose, signal); } };
    } });
    const changing = rt.updateSettings({ timeZone: "Europe/Vienna" });
    await started.promise;
    expect(rt.busy()).toBe(true);
    expect(rt.socrates).toBeNull();
    await expect(rt.updateSettings({ timeZone: "Europe/Berlin" })).rejects.toThrow(RuntimeBusyError);
    await expect(rt.setKey("GEMINI_API_KEY", "overlapping-key")).rejects.toThrow(RuntimeBusyError);
    const closing = rt.close();
    gate.release();
    await changing;
    await closing;
    expect(readKeys(config.keysPath)).toEqual({});
    expect(JSON.parse(readFileSync(config.settingsPath, "utf8")).timeZone).toBe("Europe/Vienna");
    expect((await runtime(config, models())).rt.settings.timeZone).toBe("Europe/Vienna");
  });

  it("denies changes when only a lane is working and records shutdown interruption", async () => {
    const started = held();
    const { routerModel } = models([createGoal("Lane", "Run work")]);
    const { rt } = await runtime(home({ settings: SCRIPTED }), { makeModel: (_provider, model) => model === "router" ? routerModel : { id: "stalled-chat", complete: () => { started.release(); return new Promise(() => {}); } } });
    const running = rt.socrates!.handle("Do the work.", { lane: "new" });
    await started.promise;
    expect(rt.socrates!.busy).toBe(false);
    expect(rt.busy()).toBe(true);
    await expect(rt.updateSettings({ timeZone: "Europe/Berlin" })).rejects.toThrow(RuntimeBusyError);
    const lane = rt.lanes()[0]!;
    await rt.close();
    expect((await running).kind).toBe("answered");
    const reopened = await runtime(rt.config, models());
    expect(reopened.rt.recovered).toBe(0);
    expect(reopened.rt.lanes()[0]).toMatchObject({ running: false, waitingForApproval: false });
    expect(conversationHistory(reopened.rt.store, lane.id).items[0]!.parts[0]).toMatchObject({ status: "interrupted", interrupted: "cancelled" });
  });

  it("denies an approval-gated mutation before any web approval connection exists", async () => {
    const scripted = models([
      { text: decision({ decision: "create_new", new_goal_title: "Uncertain project", new_goal_objective: "Verify approvals.", task_decision: "create_task", new_task_title: "Write a file", ...defineTask("Write a file"), workspace_confidence: "low" }) },
    ], [ { toolCalls: [call("edit", { path: "blocked.txt", old_text: "before", new_text: "after" })] }, final({ full_answer: "The change was refused." }) ]);
    const { rt } = await runtime(home({ settings: SCRIPTED }), scripted);
    const folder = tempDir();
    writeFileSync(path.join(folder, "blocked.txt"), "before");
    const workspace = rt.store.createWorkspace("project", folder);
    await rt.updateSettings({ workingFolder: workspace.id });
    const result = await rt.socrates!.handle("Write a file in that project.");
    expect(result.kind).toBe("answered");
    expect(readFileSync(path.join(folder, "blocked.txt"), "utf8")).toBe("before");
    const approvals = rt.store.listEvents({ type: "approval_decided" });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.payload).toMatchObject({ kind: "action", granted: false, detail: "Edit blocked.txt" });
    if (result.kind === "answered") expect(rt.store.evidenceForTurn(result.parts[0]!.turn.id)[0]!.result?.error?.code).toBe("approval_denied");
  });

  it("reports inherited keys and redacts provider failures from status and diagnostics", async () => {
    const secret = "private-test-provider-key";
    const { request, logs } = await server(home({ keys: { GEMINI_API_KEY: secret } }), { env: { OPENAI_API_KEY: "inherited-test-key" }, makeModel: () => { throw new Error(`Provider echoed ${secret}`); }, makeEmbedder: () => { throw new Error(`Embedding echoed ${secret}`); } });
    expect((await request("GET", "/api/keys")).json()).toMatchObject({ GEMINI_API_KEY: true, OPENAI_API_KEY: true });
    const status = await request("GET", "/api/status");
    expect(status.body).not.toContain(secret);
    expect(status.body).toContain("[redacted]");
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("rejects invalid folder selections, including changed aliases and data ancestors", async () => {
    const { rt, request } = await server(home({ settings: SCRIPTED }), models());
    expect((await request("POST", "/api/workspaces", { path: path.dirname(rt.config.home) })).statusCode).toBe(400);
    const root = path.join(tempDir(), "project");
    mkdirSync(root);
    const added = (await request("POST", "/api/workspaces", { path: root })).json();
    expect((await request("PUT", "/api/settings", { workingFolder: added.id })).statusCode).toBe(200);
    rmSync(root, { recursive: true });
    symlinkSync(rt.config.home, root);
    expect(rt.workingFolder()).toBeNull();
    expect((await request("PUT", "/api/settings", { workingFolder: added.id })).statusCode).toBe(400);
    rmSync(root);
    writeFileSync(root, "a file now");
    expect(rt.workingFolder()).toBeNull();
    expect((await request("PUT", "/api/settings", { workingFolder: added.id })).statusCode).toBe(400);
    const virtual = rt.store.createWorkspace("virtual");
    expect((await request("PUT", "/api/settings", { workingFolder: virtual.id })).statusCode).toBe(400);
  });

  it("keeps error envelopes consistent and rejects malformed query parameters", async () => {
    const { request, app } = await server(home());
    for (const url of ["/api/folders?path=/tmp&path=/", "/api/history?conversation=main&conversation=other"]) {
      const response = await request("GET", url);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_request");
    }
    const auth = await app.inject({ url: "/auth?token=one&token=two", headers: { host: `127.0.0.1:${PORT}` } });
    expect(auth.statusCode).toBe(400);
    expect((await request("GET", "/api/missing")).json()).toEqual({ error: { code: "not_found", message: "There is no such route." } });
    const response = await request("GET", "/api/status");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("rotates logs during a long-running process", () => {
    const file = path.join(tempDir(), "server.log");
    writeFileSync(file, "a".repeat(5 * 1024 * 1024 - 10));
    const log = fileLog(file);
    log("next record");
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(readFileSync(file, "utf8")).toContain("next record");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("pages interleaved compound messages once without skipping intervening messages", async () => {
    const { rt } = await runtime(home());
    const goal = rt.store.createGoal({ title: "Compound history" });
    const task = rt.store.createTask(goal.id, { title: "Parts" });
    const message = (text: string) => rt.store.recordUserMessage(text).id;
    const bind = (userEventId: string) => rt.store.bindTurn({ userEventId, taskId: task.id, route: "test" });
    const old = message("Old."); bind(old);
    const compound = message("Compound."); bind(compound);
    const middle = message("Middle."); bind(middle);
    bind(compound);
    const newest = message("Newest."); bind(newest);
    const first = conversationHistory(rt.store, null, undefined, 2);
    expect(first.items.map((item) => item.message)).toEqual(["Newest.", "Middle."]);
    const second = conversationHistory(rt.store, null, first.next!, 2);
    expect(second.items.map((item) => item.message)).toEqual(["Compound."]);
    expect(second.items[0]!.parts).toHaveLength(2);
    const third = conversationHistory(rt.store, null, second.next!, 2);
    expect(third.items.map((item) => item.message)).toEqual(["Old."]);
    expect(third.next).toBeNull();
    expect(conversationHistory(rt.store, null, undefined, 5).next).toBeNull();
  });

  it("shows and pages messages saved before routing, including a lane's queued messages", async () => {
    const { request, rt } = await server(home());
    for (let i = 0; i < 35; i++) rt.store.recordUserMessage(`Unrouted ${i}.`);
    const lane = rt.store.openLane();
    rt.store.recordUserMessage("Queued in a lane.", lane.id);
    const first = (await request("GET", "/api/history")).json();
    expect(first.items).toHaveLength(30);
    expect(first.items[0]).toMatchObject({ message: "Unrouted 34.", unrouted: true, parts: [], question: null });
    const second = (await request("GET", `/api/history?before=${first.next}`)).json();
    expect(second.items).toHaveLength(5);
    expect(second.next).toBeNull();
    const inLane = (await request("GET", `/api/history?conversation=${lane.id}`)).json();
    expect(inLane.items).toHaveLength(1);
    expect(inLane.items[0]).toMatchObject({ message: "Queued in a lane.", unrouted: true });
  });
});
