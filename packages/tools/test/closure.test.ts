import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LedgerStore } from "@socrates/store";
import { StaticCatalog, type LoadedMcpTool } from "../src";
import { enforceBounds } from "../src/tools/context-retrieve";
import { harness } from "./helpers";

const read = (root: string, rel: string) => readFileSync(path.join(root, rel), "utf8");
const patch = (body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

function interruptedPatch(cancel: boolean) {
  const h = harness({ files: { "a.txt": "alpha\n", "b.txt": "beta\n" } });
  const controller = new AbortController();
  const body = ["*** Update File: a.txt", "-alpha", "+ALPHA", ...Array.from({ length: 40 }, (_, i) => [`*** Add File: gap/f${i}.txt`, "+gap"]).flat(), "*** Update File: b.txt", "-beta", "+BETA"];
  let interrupted = false;
  const timer = setInterval(() => {
    if (!interrupted && existsSync(path.join(h.root, "gap/f0.txt"))) {
      interrupted = true;
      writeFileSync(path.join(h.root, "gap/user.txt"), "USER FILE\n");
      if (cancel) controller.abort();
      else {
        writeFileSync(path.join(h.root, "a.txt"), "USER EDIT\n");
        writeFileSync(path.join(h.root, "b.txt"), "USER EDIT\n");
      }
    }
  }, 1);
  return { h, controller, body, timer, interrupted: () => interrupted };
}

describe("patch cancellation and rollback", () => {
  it("preserves indentation when matching Unicode punctuation drift", async () => {
    const h = harness({ files: { "a.py": 'def f():\n    return “value”\n' } });
    const r = await h.call("edit", { path: "a.py", old_text: 'return "value"', new_text: 'return "updated"' });
    expect(r.json.match).toBe("unicode_punctuation");
    expect(read(h.root, "a.py")).toBe('def f():\n    return "updated"\n');
  });
  it("cancels a patch during commit and preserves an unrelated user file in its new directory", async () => {
    const t = interruptedPatch(true);
    try {
      const r = await t.h.call("apply_patch", { patch: patch(t.body) }, { signal: t.controller.signal });
      expect(t.interrupted()).toBe(true);
      expect(r.json.error.code).toBe("cancelled");
      expect(read(t.h.root, "a.txt")).toBe("alpha\n");
      expect(read(t.h.root, "b.txt")).toBe("beta\n");
      expect(read(t.h.root, "gap/user.txt")).toBe("USER FILE\n");
      expect(existsSync(path.join(t.h.root, "gap/f0.txt"))).toBe(false);
    } finally { clearInterval(t.timer); }
  });

  it("reports rollback conflicts without overwriting concurrent changes or removing user files", async () => {
    const t = interruptedPatch(false);
    try {
      const r = await t.h.call("apply_patch", { patch: patch(t.body) });
      expect(t.interrupted()).toBe(true);
      expect(r.json.error.code).toBe("patch_rollback_conflict");
      expect(r.json.error.message).toContain("a.txt");
      expect(read(t.h.root, "a.txt")).toBe("USER EDIT\n");
      expect(read(t.h.root, "gap/user.txt")).toBe("USER FILE\n");
    } finally { clearInterval(t.timer); }
  });
});

describe.skipIf(process.platform === "win32")("terminal lifecycle", () => {
  it("reaps descendants holding inherited pipes open when their shell exits", async () => {
    const h = harness();
    const r = await h.call("terminal", { command: "sleep 30 & echo $!", yield_ms: 3000 });
    expect(r.json.status).toBe("completed");
    expect(r.json.output).toContain("they were stopped");
  });

  it("cancels a restart's readiness and stops the replacement", async () => {
    const h = harness();
    await h.call("terminal", { command: "sleep 30", background: true, name: "svc", ready: { pattern: "NEVER", timeout_ms: 1 } });
    h.runner.terminals(h.workspace).find("svc").spec.ready!.timeoutMs = 1000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await h.call("terminal_control", { action: "restart", terminal: "svc" }, { signal: controller.signal });
    expect(r.json.error.code).toBe("cancelled");
    expect(h.runner.terminals(h.workspace).list().filter((s) => s.status === "running")).toEqual([]);
  });

  it("applies the first mutation gate to control actions in a newly uncertain task", async () => {
    const h = harness({ approve: false });
    await h.call("terminal", { command: "cat", background: true, name: "svc" });
    const task = h.store.createTask(h.binding.goalId, { title: "Other task", objective: "Control service" });
    const user = h.store.recordUserMessage("Restart the service");
    const turn = h.store.bindTurn({ userEventId: user.id, taskId: task.id, route: "resume_existing", gateArmed: true, workspaceConfidence: "low" });
    const binding = { ...h.binding, taskId: task.id, turnId: turn.id, chatId: turn.chatId };
    expect((await h.call("terminal_control", { action: "list" }, { binding })).isError).toBe(false);
    const r = await h.call("terminal_control", { action: "write", terminal: "svc", input: "mutate" }, { binding });
    expect(r.json.error.code).toBe("approval_denied");
    expect(h.approvals.map((a) => a.kind)).toEqual(["first_mutation"]);
  });

  it("keeps escaped output as valid JSON and pages it without losing characters", async () => {
    const h = harness();
    const source = '"\\'.repeat(12000);
    await h.call("terminal", { command: `node -e 'process.stdout.write(${JSON.stringify('"\\')}.repeat(12000));setTimeout(()=>{},30000)'`, background: true, name: "escaped" });
    await h.call("terminal_control", { action: "wait", terminal: "escaped", event: "output" });
    await new Promise((done) => setTimeout(done, 100));
    let cursor = "c0", output = "";
    for (let i = 0; i < 10; i++) {
      const r = await h.call("terminal_control", { action: "read", terminal: "escaped", cursor });
      expect(r.json).not.toBeNull();
      output += r.json.output;
      cursor = r.json.cursor;
      if (!r.json.truncated) break;
    }
    expect(output).toBe(source);
  });
});

const ENTRY = { kind: "mcp" as const, name: "demo.create", server: "demo", tool: "create", description: "Create a synthetic record", tags: [], aliases: [], availability: "available" as const };
const TOOL: LoadedMcpTool = { schemaVersion: "1", description: ENTRY.description, connection: "connected", inputSchema: { type: "object", properties: { count: { type: "integer", minimum: 1 }, config: { type: "object", properties: { mode: { enum: ["safe"] } }, required: ["mode"], additionalProperties: false } }, required: ["count", "config"], additionalProperties: false } };
async function activate(h: ReturnType<typeof harness>) {
  const ref = (await h.call("capability_search", { query: ENTRY.name })).json.matches[0].ref;
  return h.call("capability_control", { action: "activate", ref });
}

describe("MCP dispatch", () => {
  it("checks refreshed aggregate schema size before persisting any replacement", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ ...ENTRY, name: `demo.tool${i}`, tool: `tool${i}` }));
    const tools = Object.fromEntries(entries.map((e) => [e.name, { ...TOOL }]));
    const h = harness({ catalog: new StaticCatalog(entries, {}, tools) });
    for (const entry of entries) {
      const ref = (await h.call("capability_search", { query: entry.name })).json.matches[0].ref;
      expect((await h.call("capability_control", { action: "activate", ref })).isError).toBe(false);
    }
    for (const entry of entries) tools[entry.name] = { ...TOOL, schemaVersion: "2", inputSchema: { type: "object", description: "word ".repeat(3500) } };
    await expect(h.runner.mcpDefinitions(h.binding.goalId)).rejects.toMatchObject({ code: "too_many_active_tools" });
    expect(h.store.listActiveCapabilities(h.binding.goalId).every((c) => c.version === "1")).toBe(true);
  });
  it("makes server failure details recoverable through the evidence handle", async () => {
    const failure = "synthetic server diagnostic";
    const h = harness({ catalog: new StaticCatalog([ENTRY], {}, { [ENTRY.name]: TOOL }, { [ENTRY.name]: () => ({ content: failure, isError: true }) }) });
    await activate(h);
    const r = await h.call("mcp__demo__create", { count: 1, config: { mode: "safe" } });
    expect(r.json.error.code).toBe("mcp_tool_error");
    const inspected = await h.call("context_retrieve", { action: "inspect", ref: r.handle });
    expect(JSON.parse(inspected.json.output.content).failure_detail.content).toBe(failure);
  });

  it("rejects Skill content changed without a version bump until reactivation", async () => {
    const entry = { kind: "skill" as const, name: "demo", description: "Synthetic demo Skill", tags: [], aliases: [], provider: "test", availability: "available" as const };
    const skills = { demo: { version: "1", instructions: "Original", resourceBase: { kind: "opaque" as const, description: "Test" }, dependencies: [] } };
    const h = harness({ catalog: new StaticCatalog([entry], skills) });
    const ref = (await h.call("capability_search", { query: "demo" })).json.matches[0].ref;
    await h.call("capability_control", { action: "activate", ref });
    skills.demo.instructions = "Updated";
    expect(await h.runner.capabilities.activeSkills(h.binding.goalId)).toEqual({ skills: [], stale: ["demo"] });
    expect((await h.call("capability_control", { action: "activate", ref })).json.instructions).toBe("Updated");
    expect((await h.runner.capabilities.activeSkills(h.binding.goalId)).stale).toEqual([]);
  });
  it("enforces the complete advertised JSON Schema before server invocation", async () => {
    const calls: unknown[] = [];
    const h = harness({ catalog: new StaticCatalog([ENTRY], {}, { [ENTRY.name]: TOOL }, { [ENTRY.name]: (input) => (calls.push(input), { content: "ok", isError: false }) }) });
    await activate(h);
    for (const input of [{ count: "1", config: { mode: "safe" } }, { count: 0, config: { mode: "safe" } }, { count: 1, config: { mode: "unsafe" } }, { count: 1, config: { mode: "safe", extra: true } }, { count: 1, config: { mode: "safe" }, extra: true }]) {
      expect((await h.call("mcp__demo__create", input)).json.error.code).toBe("invalid_parameters");
    }
    expect(calls).toEqual([]);
    expect((await h.call("mcp__demo__create", { count: 1, config: { mode: "safe" } })).isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("fails closed when a schema changes or a catalog tool becomes unavailable", async () => {
    const entries = [{ ...ENTRY }];
    const tools = { [ENTRY.name]: TOOL };
    let calls = 0;
    const h = harness({ catalog: new StaticCatalog(entries, {}, tools, { [ENTRY.name]: () => (calls++, { content: "ok", isError: false }) }) });
    await activate(h);
    tools[ENTRY.name] = { ...TOOL, schemaVersion: "2", inputSchema: { type: "object", properties: { count: { type: "string" } }, required: ["count"] } };
    expect((await h.call("mcp__demo__create", { count: 1, config: { mode: "safe" } })).json.error.code).toBe("tool_schema_changed");
    const defs = await h.runner.mcpDefinitions(h.binding.goalId);
    expect((defs[0]!.inputSchema.properties as any).count.type).toBe("string");
    entries[0]!.availability = "offline" as any;
    expect((await h.call("mcp__demo__create", { count: "1" })).json.error.code).toBe("capability_unavailable");
    expect(await h.runner.mcpDefinitions(h.binding.goalId)).toEqual([]);
    expect(calls).toBe(0);
  });

  it("does not invoke an MCP mutation when the workspace gate is denied", async () => {
    let called = false;
    const h = harness({ gateArmed: true, approve: false, catalog: new StaticCatalog([ENTRY], {}, { [ENTRY.name]: TOOL }, { [ENTRY.name]: () => (called = true, { content: "ok", isError: false }) }) });
    await activate(h);
    const r = await h.call("mcp__demo__create", { count: 1, config: { mode: "safe" } });
    expect(r.json.error.code).toBe("approval_denied");
    expect(called).toBe(false);
  });

  it("rejects malformed server schemas at activation", async () => {
    const h = harness({ catalog: new StaticCatalog([ENTRY], {}, { [ENTRY.name]: { ...TOOL, inputSchema: { type: "object", properties: { count: { type: "not-a-type" } } } } }) });
    expect((await activate(h)).json.error.code).toBe("invalid_tool_schema");
    expect(h.store.listActiveCapabilities(h.binding.goalId)).toEqual([]);
  });
});

describe("discovery and aggregate bounds", () => {
  it("replays tool evidence, observations, and command/test facts with stable identities", async () => {
    const h = harness({ files: { "a.txt": "original\n" } });
    await h.call("read", { path: "a.txt" });
    await h.call("edit", { path: "a.txt", old_text: "original", new_text: "updated" });
    await h.call("terminal", { command: "printf synthetic" });
    h.store.recordTerminalExited({ task_id: h.binding.taskId, goal_id: h.binding.goalId }, { session_id: "synthetic-session", exit_code: 0, signal: null, reason: "exited", facts: [{ kind: "test", value: "Synthetic outcome" }] });
    const recovered = LedgerStore.open({ path: ":memory:" });
    try {
      recovered.restoreEvents(JSON.parse(JSON.stringify(h.store.listEvents())));
      for (const table of ["events", "evidence", "file_observations", "task_facts"]) {
        expect(recovered.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(h.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      }
    } finally { recovered.close(); }
  });
  it("uses ripgrep's glob dialect and excludes explicitly selected ignored files", async () => {
    const h = harness({ files: { ".gitignore": "ignored.ts\n", "ignored.ts": "needle\n", "visible.ts": "needle\n", "src/a.ts": "needle\n" } });
    expect((await h.call("grep", { path: "ignored.ts", pattern: "needle" })).json.returned).toBe(0);
    expect((await h.call("glob", { pattern: "!ignored.ts" })).json.matches).toContain("visible.ts");
    expect((await h.call("glob", { pattern: "{" })).json.error.code).toBe("invalid_pattern");
  });

  it("keeps collection-cap metadata when paging a frozen search set", async () => {
    const h = harness();
    for (let i = 0; i < 501; i++) {
      const user = h.store.recordUserMessage(`Exchange ${i}`);
      const turn = h.store.bindTurn({ userEventId: user.id, taskId: h.binding.taskId, route: "continue_current" });
      const response = h.store.recordResponse("reply", { task_id: h.binding.taskId, turn_id: turn.id });
      h.store.completeTurn(turn.id, { responseEventId: response.id, continuationNote: "done" });
    }
    let cursor: string | undefined;
    let last: any;
    for (let i = 0; i < 50; i++) {
      last = (await h.call("context_retrieve", { action: "search", from: "2026-09-01", top_n: 10, ...(cursor ? { cursor } : {}) })).json;
      cursor = last.next_cursor;
    }
    expect(last.next_cursor).toBeNull();
    expect(last.more_matches).toBe(true);
    expect(last.note).toContain("500");
  });

  it("preserves list item shapes and truthful completeness under aggregate reduction", () => {
    const view = { action: "inspect", user_message: { content: "x".repeat(100000), complete: true, omitted: null }, tool_activity: Array.from({ length: 1000 }, (_, i) => ({ ref: `e${i + 1}`, tool: "read", input: "x".repeat(120) })), bounded: true };
    const result = enforceBounds(view);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50 * 1024);
    expect(result.user_message.complete).toBe(false);
    expect(result.tool_activity.every((x) => typeof x === "object" && !!x.ref)).toBe(true);
  });

  it("rejects nonexistent calendar dates and permits filenames starting with two dots", async () => {
    const h = harness({ files: { "..config": "valid\n" } });
    expect((await h.call("context_retrieve", { action: "search", from: "2026-02-31" })).json.error.code).toBe("invalid_parameters");
    expect((await h.call("read", { path: "..config" })).isError).toBe(false);
  });
});
