import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerStore } from "@socrates/store";
import { RunState, ToolRunner, WorkspaceRoot, mcpCatalogName, mcpPublicName } from "@socrates/tools";
import { InstalledCatalog } from "../src";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function home() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "socrates-capability-closure-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(root: string, relative: string, content: string) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); return file;
}
const skill = (body = "Read template.txt.") => `---\nname: notes\ndescription: Write notes\n---\n${body}\n`;
const schema = { type: "object" as const, properties: {} };
async function service(tool = "get", readOnly = true) {
  const state = { available: true, requests: 0, lists: 0, calls: [] as string[], holdList: false, onList: () => {}, release: () => {} };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    state.requests++;
    let body = ""; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (!state.available) { res.writeHead(503).end(); return; }
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: tool, version: "1" } };
    else if (message.method === "tools/list") {
      state.lists++;
      const wait = state.holdList ? new Promise<void>((resolve) => { state.release = resolve; }) : Promise.resolve();
      state.onList(); await wait;
      result = { tools: [{ name: tool, description: tool, inputSchema: schema, annotations: { readOnlyHint: readOnly } }] };
    } else if (message.method === "tools/call") {
      state.calls.push(message.params.name); result = { content: [{ type: "text", text: tool }] };
    } else { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { state.release(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { state, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` };
}
async function harness(dir: string, options: { now?: () => number; seed?: boolean } = {}) {
  const store = LedgerStore.open({ path: ":memory:" }); cleanup.push(() => store.close());
  if (options.seed) store.recordMcpToolSnapshot({ server: "tracker", digest: "seed", tools: [{ name: "get", description: "get", input_schema: schema, read_only: true }] });
  const catalog = await InstalledCatalog.open({ store, home: dir, connectTimeoutMs: 1000, ...(options.now ? { now: options.now } : {}) }); cleanup.push(() => catalog.close());
  const approvals: string[] = [];
  const runner = new ToolRunner({ store, catalog, timeZone: "UTC", approve: async (r) => { approvals.push(r.subject!); return true; } }); cleanup.push(() => runner.close());
  const goal = store.createGoal({ title: "Capabilities", objective: "Test capabilities" });
  const task = store.createTask(goal.id, { title: "Work", objective: "Work" });
  const turn = store.bindTurn({ userEventId: store.recordUserMessage("Work").id, taskId: task.id, route: "continue_current", gateArmed: false, workspaceConfidence: "high" });
  const scope = { binding: { goalId: goal.id, taskId: task.id, chatId: turn.chatId, turnId: turn.id }, workspace: null as WorkspaceRoot | null, run: new RunState(), signal: new AbortController().signal };
  let n = 0;
  const call = (name: string, input: unknown) => runner.run({ id: `c${++n}`, name, input }, scope);
  const activate = async (name: string) => {
    const search = JSON.parse((await call("capability_search", { query: name })).content);
    return call("capability_control", { action: "activate", ref: search.matches.find((m: { name: string }) => m.name === name).ref });
  };
  return { store, catalog, runner, goal, scope, call, activate, approvals };
}

describe("PR4 lifecycle regressions", () => {
  it("keeps dotted identities, approvals, restart and event replay separate", async () => {
    const a = await service("team.get", false), b = await service("get", false);
    const dir = home(); write(dir, "mcp.json", JSON.stringify({ mcpServers: { tracker: { url: a.url }, "tracker.team": { url: b.url } } }));
    const h = await harness(dir);
    const first = mcpCatalogName("tracker", "team.get"), second = mcpCatalogName("tracker.team", "get");
    expect(first).not.toBe(second);
    const found = JSON.parse((await h.call("capability_search", { query: "tracker.team.get" })).content);
    expect(found.matches).toHaveLength(2);
    for (const name of [first, second]) expect((await h.activate(name)).isError).toBe(false);
    expect((await h.call(mcpPublicName("tracker", "team.get"), {})).content).toBe("team.get");
    expect(h.approvals).toEqual([first]);
    expect((await h.call(mcpPublicName("tracker.team", "get"), {})).content).toBe("get");
    expect(h.approvals).toEqual([first, second]);
    expect(a.state.calls).toEqual(["team.get"]); expect(b.state.calls).toEqual(["get"]);
    await expect(h.catalog.loadMcpTool("tracker.team.get")).rejects.toThrow("No configured MCP server");
    // Ambiguous legacy activations cannot be rebound to either newly encoded identity.
    h.store.activateCapability(h.goal.id, { kind: "mcp", name: "tracker.team.get", version: "legacy", digest: "legacy" });
    expect(first).not.toContain("."); expect(second).not.toContain(".");
    await h.catalog.close();
    const restored = LedgerStore.open({ path: ":memory:" }); cleanup.push(() => restored.close()); restored.restoreEvents(h.store.listEvents());
    const catalog = await InstalledCatalog.open({ store: restored, home: dir }); cleanup.push(() => catalog.close());
    const runner = new ToolRunner({ store: restored, catalog, timeZone: "UTC", approve: async () => { throw Error("approval should survive"); } }); cleanup.push(() => runner.close());
    expect(await runner.mcpDefinitions(h.goal.id)).toHaveLength(2);
    expect((await runner.run({ id: "restart", name: mcpPublicName("tracker", "team.get"), input: {} }, h.scope)).content).toBe("team.get");
    expect(restored.mcpToolApproved(h.goal.id, first)).toBe(true);
    expect(mcpCatalogName("tracker%2Eteam", "get")).not.toBe(second);
  });

  it("retries unknown listings after backoff without connecting from search", async () => {
    const s = await service(); s.state.available = false;
    const dir = home(); write(dir, "mcp.json", JSON.stringify({ mcpServers: { tracker: { url: s.url } } }));
    let now = 1; const h = await harness(dir, { now: () => now });
    const requests = s.state.requests; s.state.available = true;
    await h.catalog.refresh(); expect(s.state.requests).toBe(requests);
    now += 30_001;
    expect(JSON.parse((await h.call("capability_search", { query: "tracker" })).content).returned).toBe(0);
    expect(s.state.requests).toBe(requests);
    await h.catalog.refresh(); expect(h.catalog.entries().map((e) => e.name)).toEqual(["tracker.get"]);
    expect((await h.activate("tracker.get")).isError).toBe(false);
    expect((await h.call("mcp__tracker__get", {})).content).toBe("get");
  });

  it("cancels discovery and activation listing without publishing late snapshots or active state", async () => {
    const s = await service(); const dir = home(); write(dir, "mcp.json", JSON.stringify({ mcpServers: { tracker: { url: s.url } } }));
    const h = await harness(dir, { seed: true });
    s.state.holdList = true; const controller = new AbortController(); h.scope.signal = controller.signal;
    s.state.onList = () => controller.abort();
    const result = await h.activate("tracker.get");
    expect(JSON.parse(result.content).error.code).toBe("cancelled");
    expect(h.store.listActiveCapabilities(h.goal.id)).toEqual([]);
    expect(h.store.mcpToolSnapshots().get("tracker")!.digest).toBe("seed");
    s.state.release(); s.state.holdList = false; s.state.onList = () => {};
    h.scope.signal = new AbortController().signal;
    await expect.poll(async () => (await h.activate("tracker.get")).isError).toBe(false);
    expect((await h.call("mcp__tracker__get", {})).content).toBe("get");
  });

  it("reads only resources of valid active Skills, including without a workspace", async () => {
    const dir = home(); const source = write(dir, "skills/notes/SKILL.md", skill());
    const resource = write(dir, "skills/notes/template.txt", "TEMPLATE"); const secret = write(dir, "unrelated.txt", "PRIVATE");
    symlinkSync(secret, path.join(dir, "skills/notes/escape.txt"));
    const h = await harness(dir);
    expect((await h.call("read", { path: resource })).isError).toBe(true);
    expect((await h.activate("notes")).isError).toBe(false);
    expect((await h.call("read", { path: resource })).content).toContain("TEMPLATE");
    expect((await h.call("read", { path: secret })).isError).toBe(true);
    expect((await h.call("read", { path: path.join(dir, "skills/notes/escape.txt") })).isError).toBe(true);
    expect((await h.call("read", { path: path.join(dir, "skills/notes/../../unrelated.txt") })).isError).toBe(true);
    const project = path.join(dir, "project"); mkdirSync(project); h.scope.workspace = WorkspaceRoot.open("project", project);
    expect((await h.call("read", { path: resource })).content).toContain("TEMPLATE");
    expect((await h.call("edit", { path: resource, old_string: "TEMPLATE", new_string: "BAD" })).isError).toBe(true);
    const originalGoal = h.scope.binding.goalId; h.scope.binding.goalId = h.store.createGoal({ title: "Other", objective: "Other" }).id;
    expect((await h.call("read", { path: resource })).isError).toBe(true); h.scope.binding.goalId = originalGoal;
    await h.call("capability_control", { action: "deactivate", name: "notes" });
    expect((await h.call("read", { path: resource })).isError).toBe(true);
    await h.activate("notes"); writeFileSync(source, skill("Changed instructions"));
    expect((await h.call("read", { path: resource })).isError).toBe(true);
    expect(h.runner.capabilities.current(h.goal.id).skills).toEqual([]);
    expect(h.runner.capabilities.current(h.goal.id).staleSkills).toEqual(["notes"]);
    await h.activate("notes"); expect((await h.call("read", { path: resource })).isError).toBe(false);
    writeFileSync(source, "---\nname: wrong\n---\nInvalid");
    expect((await h.activate("notes")).isError).toBe(true);
  });
});
