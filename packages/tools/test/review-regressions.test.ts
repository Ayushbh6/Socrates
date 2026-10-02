import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { countTokens, truncateToTokens } from "@socrates/shared";
import { describe, expect, it } from "vitest";
import { type LoadedMcpTool, StaticCatalog, ToolRunner, mcpPublicName } from "../src";
import { settles } from "../src/terminals";
import { type Harness, harness } from "./helpers";

/** Regressions for the review of the tools stage at 3c4716a; each mirrors the reviewer's reproduction. */

const read = (root: string, rel: string) => readFileSync(path.join(root, rel), "utf8");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exchange(h: Harness, at: string, response = "A matching response") {
  h.clock.set(at);
  const user = h.store.recordUserMessage("Historical exchange");
  const turn = h.store.bindTurn({ userEventId: user.id, taskId: h.binding.taskId, route: "continue_current" });
  const reply = h.store.recordResponse(response, { goal_id: h.binding.goalId, task_id: h.binding.taskId, turn_id: turn.id });
  h.store.completeTurn(turn.id, { responseEventId: reply.id, continuationNote: "Completed exchange" });
}

describe("P1 cancellation", () => {
  it("a call cancelled before it runs changes nothing", async () => {
    const h = harness({ files: { "a.txt": "one\n" } });
    const controller = new AbortController();
    controller.abort();
    const r = await h.call("edit", { path: "a.txt", old_text: "one", new_text: "two" }, { signal: controller.signal });
    expect(r.json.error).toMatchObject({ code: "cancelled", retryable: false });
    expect(read(h.root, "a.txt")).toBe("one\n");
  });

  it("a mutation cancelled while waiting for approval changes nothing", async () => {
    const controller = new AbortController();
    const h = harness({ files: { "a.txt": "one\n" }, gateArmed: true, approve: () => (controller.abort(), true) });
    const r = await h.call("edit", { path: "a.txt", old_text: "one", new_text: "two" }, { signal: controller.signal });
    expect(r.json.error.code).toBe("cancelled");
    expect(read(h.root, "a.txt")).toBe("one\n");
  });

  it.skipIf(process.platform === "win32")("a background launch cancelled during readiness is stopped", async () => {
    const h = harness();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const r = await h.call("terminal", { command: "sleep 30", name: "cancelled-service", background: true, ready: { pattern: "NEVER", timeout_ms: 5000 } }, { signal: controller.signal });
    expect(r.json.error.code).toBe("cancelled");
    expect(h.runner.terminals(h.workspace).list().filter((s) => s.status === "running")).toEqual([]);
  });
});

describe("P1 apply_patch revalidates each file at commit time", () => {
  it("does not overwrite a file the user changed after the patch was planned", async () => {
    const h = harness({ files: { "a.txt": "alpha\n", "b.txt": "beta\n" } });
    await h.call("read", { path: "b.txt" });
    const patch = ["*** Begin Patch", "*** Update File: a.txt", "-alpha", "+ALPHA", ...Array.from({ length: 40 }, (_, i) => [`*** Add File: gap/f${i}.txt`, "+gap"]).flat(), "*** Update File: b.txt", "-beta", "+BETA", "*** End Patch"].join("\n");
    let concurrentWrite = false;
    const interval = setInterval(() => {
      if (!concurrentWrite && read(h.root, "a.txt") === "ALPHA\n") {
        writeFileSync(path.join(h.root, "b.txt"), "USER EDIT\n");
        concurrentWrite = true;
      }
    }, 1);
    const r = await h.call("apply_patch", { patch });
    clearInterval(interval);
    expect(concurrentWrite).toBe(true);
    expect(r.json.error.code).toBe("stale_file");
    expect(read(h.root, "b.txt")).toBe("USER EDIT\n");
    expect(read(h.root, "a.txt")).toBe("alpha\n");
  });
});

describe.skipIf(process.platform === "win32")("P1 process ownership", () => {
  it("stops background processes a finished command left in its process group", async () => {
    const h = harness();
    const r = await h.call("terminal", { command: "sleep 30 >/dev/null 2>&1 & echo $!" });
    const child = Number(r.json.output.trim().split("\n")[0]);
    expect(r.json.output).toContain("they were stopped");
    await new Promise((done) => setTimeout(done, 300));
    expect(alive(child)).toBe(false);
  });

  it("shutdown leaves nothing behind even when a descendant ignores SIGTERM", async () => {
    const h = harness();
    const terminals = h.runner.terminals(h.workspace);
    const r = await h.call("terminal", { command: "(trap '' TERM; sleep 30) >/dev/null 2>&1 & echo $!; sleep 0.2" });
    const child = Number(r.json.output.trim().split("\n")[0]);
    await terminals.shutdown();
    await new Promise((done) => setTimeout(done, 200));
    expect(alive(child)).toBe(false);
  });
});

describe("P1 resolved-path protection", () => {
  it("a symlink alias cannot be used to modify .git", async () => {
    const h = harness({ files: { ".git/HEAD": "ref: refs/heads/review\n" } });
    symlinkSync(".git", path.join(h.root, "metadata-alias"));
    const r = await h.call("edit", { path: "metadata-alias/HEAD", old_text: "review", new_text: "changed" });
    expect(r.json.error.code).toBe("protected_path");
    expect(read(h.root, ".git/HEAD")).toBe("ref: refs/heads/review\n");
  });

  it("stale-edit observations follow the real file, not its alias", async () => {
    const h = harness({ files: { "src/real.ts": "x = 1\n" } });
    symlinkSync("src", path.join(h.root, "alias"));
    expect((await h.call("read", { path: "alias/real.ts" })).content).toContain("src/real.ts");
    writeFileSync(path.join(h.root, "src/real.ts"), "x = 1\n// changed by user\n");
    expect((await h.call("edit", { path: "src/real.ts", old_text: "x = 1", new_text: "x = 2" })).json.error.code).toBe("stale_file");
  });
});

describe("P2 matching and search", () => {
  it("replace_all re-indents each occurrence by its own indentation", async () => {
    const h = harness({ files: { "a.py": "  if x:\n    return 1\n\n    if x:\n      return 1\n" } });
    const r = await h.call("edit", { path: "a.py", old_text: "if x:\n  return 1", new_text: "if x:\n  return 2", replace_all: true });
    expect(r.json).toMatchObject({ replacements: 2, match: "indentation" });
    expect(read(h.root, "a.py")).toBe("  if x:\n    return 2\n\n    if x:\n      return 2\n");
  });

  it("refuses an indentation-tolerant match whose relative indentation differs", async () => {
    const h = harness({ files: { "a.py": "def f():\n    if x:\n        return 1\n" } });
    const r = await h.call("edit", { path: "a.py", old_text: "if x:\nreturn 1", new_text: "if x:\nreturn 2" });
    expect(r.json.error.code).toBe("old_text_indentation_mismatch");
    expect(read(h.root, "a.py")).toBe("def f():\n    if x:\n        return 1\n");
  });

  it("positive globs never bring back files ignored by .gitignore", async () => {
    const h = harness({ files: { ".gitignore": "ignored.ts\nbuild/\n", "ignored.ts": "needle\n", "visible.ts": "needle\n", "build/out.ts": "needle\n", "src/deep.ts": "needle\n" } });
    expect((await h.call("glob", { pattern: "**/*.ts" })).json.matches).toEqual(["src/deep.ts", "visible.ts"]);
    expect((await h.call("glob", { pattern: "*.ts" })).json.matches).toEqual(["src/deep.ts", "visible.ts"]);
    expect((await h.call("glob", { pattern: "src/*.ts" })).json.matches).toEqual(["src/deep.ts"]);
    expect((await h.call("grep", { pattern: "needle", glob: "*.ts" })).json.matches.map((m: any) => m.path)).toEqual(["src/deep.ts", "visible.ts"]);
    expect((await h.call("grep", { pattern: "needle", glob: "src/**/*.ts" })).json.matches.map((m: any) => m.path)).toEqual(["src/deep.ts"]);
  });

  it("applies date filters before the collection limit, in the user's time zone", async () => {
    const h = harness();
    exchange(h, "2026-09-01T10:00:00Z");
    for (let i = 0; i < 501; i++) exchange(h, "2026-10-01T10:00:00Z");
    const r = await h.call("context_retrieve", { action: "search", from: "2026-09-01", to: "2026-09-01" });
    expect(r.json.returned).toBe(1);
    const all = await h.call("context_retrieve", { action: "search", from: "2026-10-01" });
    expect(all.json).toMatchObject({ more_matches: true });
    expect(all.json.note).toContain("500");
  });

  it("finds tasks by their mechanically derived files", async () => {
    const h = harness();
    await h.call("apply_patch", { patch: "*** Begin Patch\n*** Add File: rare-unicorn.ts\n+hello\n*** End Patch" });
    const hybrid = await h.call("context_retrieve", { action: "ledger_search", query: "rare-unicorn" });
    expect(hybrid.json.results.map((r: any) => r.selector)).toEqual(["g1/t1"]);
    const exact = await h.call("context_retrieve", { action: "ledger_search", query: "rare-unicorn.ts", match: "exact" });
    expect(exact.json.results.map((r: any) => r.selector)).toEqual(["g1/t1"]);
  });

  it("matches identical non-ASCII text in exact search", async () => {
    const h = harness();
    exchange(h, "2026-09-01T10:00:00Z", "Heute: Übung zu Präpositionen.");
    for (const query of ["Übung", "übung", "PRÄPOSITIONEN", "Übung".normalize("NFD")]) {
      expect((await h.call("context_retrieve", { action: "search", query, match: "exact" })).json.returned).toBe(1);
    }
  });
});

describe.skipIf(process.platform === "win32")("P2 terminal output integrity", () => {
  it("reports truthfully when a foreground command's output exceeds what is retained", async () => {
    const h = harness();
    const runner = new ToolRunner({ store: h.store, timeZone: "UTC", approve: async () => true, terminals: { foregroundRetainChars: 100_000 } });
    const r = await runner.run(
      { id: "big", name: "terminal", input: { command: `node -e "process.stdout.write('BEGIN\\n'+'x'.repeat(200000)+'\\nEND\\n')"` } },
      { binding: h.binding, workspace: h.workspace, run: h.run, signal: new AbortController().signal },
    );
    const body = JSON.parse(r.content);
    expect(body).toMatchObject({ status: "completed", output_lost: true, truncated: true });
    expect(body.lost_characters).toBeGreaterThan(100_000);
    const stored = h.store.getEvidence(h.binding.taskId, 1)!.result!.result as any;
    expect(stored.output_lost).toBe(true);
    expect(stored.output_full.endsWith("END\n")).toBe(true);
    await runner.close();
  });

  it("keeps the complete output of a large foreground command by default", async () => {
    const h = harness();
    await h.call("terminal", { command: `node -e "process.stdout.write('BEGIN\\n'+'x'.repeat(4100000)+'\\nEND\\n')"` });
    const stored = h.store.getEvidence(h.binding.taskId, 1)!.result!.result as any;
    expect(stored.output_lost).toBe(false);
    expect(stored.output_full.startsWith("BEGIN")).toBe(true);
  });

  it("pages through an oversized single line instead of skipping its middle", async () => {
    const h = harness();
    await h.call("terminal", { command: `node -e "process.stdout.write('0123456789'.repeat(6000)); setTimeout(() => {}, 30000)"`, background: true, name: "long-line" });
    await h.call("terminal_control", { action: "wait", terminal: "long-line", event: "output" });
    await new Promise((done) => setTimeout(done, 200));
    let cursor = "c0";
    let seen = "";
    for (let i = 0; i < 20; i++) {
      const r = await h.call("terminal_control", { action: "read", terminal: "long-line", cursor });
      expect(countTokens(r.content)).toBeLessThanOrEqual(10_000);
      seen += r.json.output;
      cursor = r.json.cursor;
      if (!r.json.truncated) break;
      expect(r.json.output).not.toContain("omitted");
    }
    expect(seen).toBe("0123456789".repeat(6000));
  });

  it("records a test outcome when the run finishes after becoming a session", async () => {
    const h = harness();
    const t = await h.call("terminal", { command: "sleep 0.6; pytest --version >/dev/null 2>&1; exit 7", yield_ms: 250 });
    expect(t.json.status).toBe("running");
    const done = await h.call("terminal_control", { action: "wait", terminal: t.json.terminal, event: "exit" });
    expect(done.json.exit_code).toBe(7);
    expect(h.store.taskFacts(h.binding.taskId).filter((f) => f.kind === "test").map((f) => f.value)).toEqual(["sleep 0.6; pytest --version >/dev/null 2>&1; exit 7 → exit 7"]);
    // A foreground test run records its outcome exactly once.
    await h.call("terminal", { command: "pytest --version >/dev/null 2>&1; exit 0" });
    expect(h.store.taskFacts(h.binding.taskId).filter((f) => f.kind === "test")).toHaveLength(2);
  });
});

describe("P2 bounds", () => {
  it("context_retrieve never exceeds 50 KiB, whatever the record holds", async () => {
    const h = harness();
    for (let i = 0; i < 60; i++) h.store.upsertAnchor({ goalId: h.binding.goalId, path: `architecture/ref-${i}.md`, role: "reference", summary: "x".repeat(2000) });
    for (let i = 0; i < 120; i++) h.store.createTask(h.binding.goalId, { title: `Task ${i} ${"y".repeat(60)}`, objective: "z".repeat(150) });
    for (const input of [{ action: "inspect", ref: "g1" }, { action: "ledger_search", limit: 25 }]) {
      const r = await h.call("context_retrieve", input);
      expect(r.isError).toBe(false);
      expect(Buffer.byteLength(r.content)).toBeLessThanOrEqual(50 * 1024);
      expect(countTokens(r.content)).toBeLessThanOrEqual(10_000);
    }
    const goal = await h.call("context_retrieve", { action: "inspect", ref: "g1" });
    expect(goal.json.anchors_omitted).toBeGreaterThan(0);
  });

  it("token truncation never splits a character", () => {
    const sample = `a${"😀".repeat(80)}`;
    const cut = truncateToTokens(sample, 60);
    expect(sample.startsWith(cut.text)).toBe(true);
    expect(cut.text).not.toContain("\uFFFD");
  });
});

describe("capability scaffolding gaps", () => {
  const ISSUE: LoadedMcpTool = { schemaVersion: "1", description: "Get issue", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] }, connection: "connected" };
  const entry = { kind: "mcp" as const, name: "github.get_issue", server: "github", tool: "get_issue", description: "Get issue", tags: ["issue"], aliases: [], availability: "available" as const };

  it("dispatches an activated MCP tool through the same runner, bounded and recorded", async () => {
    const calls: unknown[] = [];
    const catalog = new StaticCatalog([entry], {}, { "github.get_issue": ISSUE }, {
      "github.get_issue": (input) => (calls.push(input), input.number === 404 ? { content: "Issue not found", isError: true } : { content: `Issue ${input.number}: Reconnect bug`, isError: false }),
    });
    const h = harness({ catalog });
    const ref = (await h.call("capability_search", { query: "github.get_issue" })).json.matches[0].ref;
    const activation = await h.call("capability_control", { action: "activate", ref });
    const ok = await h.call(activation.json.public_name, { number: 42 });
    expect(ok).toMatchObject({ isError: false, content: "Issue 42: Reconnect bug" });
    const missing = await h.call(activation.json.public_name, {});
    expect(missing.json.error.code).toBe("invalid_parameters");
    const failed = await h.call(activation.json.public_name, { number: 404 });
    expect(failed.json.error.code).toBe("mcp_tool_error");
    expect((h.store.listEvents({ type: "tool_completed" }).at(-1)!.payload as any).failure_detail).toEqual({ content: "Issue not found" });
    expect(calls).toEqual([{ number: 42 }, { number: 404 }]);
    expect(h.store.taskFacts(h.binding.taskId).map((f) => f.value)).toContain("mcp github.get_issue");
  });

  it("restores active MCP tools in a new runner and records a changed schema", async () => {
    const tools = { "github.get_issue": ISSUE };
    const catalog = new StaticCatalog([entry], {}, tools, { "github.get_issue": () => ({ content: "ok", isError: false }) });
    const h = harness({ catalog });
    const ref = (await h.call("capability_search", { query: "github.get_issue" })).json.matches[0].ref;
    await h.call("capability_control", { action: "activate", ref });
    tools["github.get_issue"] = { ...ISSUE, schemaVersion: "2", inputSchema: { ...ISSUE.inputSchema, properties: { number: { type: "integer" }, repo: { type: "string" } } } };
    const second = new ToolRunner({ store: h.store, catalog, timeZone: "UTC", approve: async () => true });
    const defs = await second.mcpDefinitions(h.binding.goalId);
    expect(defs.map((d) => d.name)).toEqual(["mcp__github__get_issue"]);
    expect(Object.keys((defs[0]!.inputSchema as any).properties)).toEqual(["number", "repo"]);
    expect(h.store.listActiveCapabilities(h.binding.goalId)[0]!.version).toBe("2");
    const r = await second.run({ id: "x", name: "mcp__github__get_issue", input: { number: 1 } }, { binding: h.binding, workspace: h.workspace, run: h.run, signal: new AbortController().signal });
    expect(r.isError).toBe(false);
    await second.close();
  });

  it("revalidates active Skills by content digest", async () => {
    const skills = { pdf: { version: "v1", instructions: "Use pdftotext.", resourceBase: { kind: "opaque" as const, description: "builtin" }, dependencies: [] } };
    const catalog = new StaticCatalog([{ kind: "skill", name: "pdf", description: "PDF files", tags: [], aliases: [], provider: "workspace", availability: "available" }], skills);
    const h = harness({ catalog });
    const ref = (await h.call("capability_search", { query: "pdf" })).json.matches[0].ref;
    await h.call("capability_control", { action: "activate", ref });
    expect(await h.runner.capabilities.activeSkills(h.binding.goalId)).toEqual({ skills: [{ name: "pdf", version: "v1", instructions: "Use pdftotext." }], stale: [] });
    skills.pdf = { ...skills.pdf, version: "v2", instructions: "Changed." };
    expect(await h.runner.capabilities.activeSkills(h.binding.goalId)).toEqual({ skills: [], stale: ["pdf"] });
  });

  it("generates collision-free public names", () => {
    expect(mcpPublicName("github", "get_issue")).toBe("mcp__github__get_issue");
    expect(mcpPublicName("foo.bar", "get")).not.toBe(mcpPublicName("foo_bar", "get"));
    expect(mcpPublicName("a__b", "c")).not.toBe(mcpPublicName("a", "b__c"));
    const long = (n: number) => mcpPublicName("server", `${"t".repeat(80)}${n}`);
    expect(long(1)).not.toBe(long(2));
    expect(long(1).length).toBeLessThanOrEqual(64);
    expect(mcpPublicName("foo.bar", "get")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("terminal supervisor internals", () => {
  it.skipIf(process.platform === "win32")("a session's leftover group is reaped even without a runner", async () => {
    const h = harness();
    const terminals = h.runner.terminals(h.workspace);
    const session = terminals.launch(
      { command: "sleep 30 >/dev/null 2>&1 & echo $!", cwd: h.root, cwdRel: ".", env: { PATH: process.env.PATH! }, timeoutMs: null, background: false, name: null, ready: null },
      { onStart() {}, onExit() {} },
    );
    await settles(session, 2000);
    const child = Number(session.output.slice(0).text.trim().split("\n")[0]);
    await terminals.shutdown();
    await new Promise((done) => setTimeout(done, 200));
    expect(alive(child)).toBe(false);
  });
});

