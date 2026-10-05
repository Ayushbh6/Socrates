import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { ModelMessage, ToolCall } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { makeModel, PROVIDER_DEFAULTS, type Provider } from "../../providers/src";
import { RunState, StaticCatalog, ToolRunner, WorkspaceRoot, type ToolBinding } from "../src";

/** Stage-one integration fixture; --live adds a real provider selecting a permanent tool. */
const base = path.resolve(".socrates/evals");
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, "tools-")));
const root = path.join(dir, "workspace");
mkdirSync(root);
writeFileSync(path.join(root, "answer.txt"), "synthetic-record-7391\n");
const catalog = new StaticCatalog([
  { kind: "skill", name: "demo", description: "Synthetic workflow instructions", tags: [], aliases: [], provider: "fixture", availability: "available" },
  { kind: "mcp", name: "demo.echo", server: "demo", tool: "echo", description: "Echo a synthetic ID", tags: [], aliases: [], availability: "available" },
], {
  demo: { version: "1", instructions: "Read answer.txt before changing it.", resourceBase: { kind: "directory", path: root }, dependencies: ["demo.echo"] },
}, {
  "demo.echo": { schemaVersion: "1", description: "Echo a synthetic ID", connection: "connected", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
}, { "demo.echo": (input) => ({ content: JSON.stringify(input), isError: false }) });
const dbPath = path.join(dir, "ledger.sqlite");
let store = LedgerStore.open({ path: dbPath });
let runner = new ToolRunner({ store, catalog, timeZone: "UTC", approve: async () => true });
const workspace = WorkspaceRoot.open("synthetic", root);
const goal = store.createGoal({ title: "Synthetic tools workflow", objective: "Verify stage one." });
const task = store.createTask(goal.id, { title: "Exercise tools", objective: "Verify all ten tools, evidence and restart." });
const user = store.recordUserMessage("Exercise this synthetic tools fixture.");
const turn = store.bindTurn({ userEventId: user.id, taskId: task.id, route: "create_new", workspaceConfidence: "high" });
let binding: ToolBinding = { goalId: goal.id, taskId: task.id, chatId: turn.chatId, turnId: turn.id };
let run = new RunState();
const calls: { name: string; handle: string; isError: boolean }[] = [];
let counter = 0;
async function dispatch(call: ToolCall, expectError = false) {
  const result = await runner.run(call, { binding, workspace, run, signal: AbortSignal.timeout(60000) });
  assert.equal(result.isError, expectError, result.content);
  assert(countTokens(result.content) <= 10000);
  calls.push({ name: result.name, handle: result.handle, isError: result.isError });
  return result;
}
async function call(name: string, input: unknown, expectError = false) {
  return dispatch({ id: `fixture-${++counter}`, name, input }, expectError);
}
const data = (result: { content: string }) => JSON.parse(result.content);

try {
  assert.equal(runner.definitions.length, 10);
  assert((await call("read", { path: "answer.txt" })).content.includes("synthetic-record-7391"));
  assert(data(await call("glob", { pattern: "**/*.txt" })).matches.includes("answer.txt"));
  assert.equal(data(await call("grep", { pattern: "synthetic-record" })).returned, 1);
  await call("edit", { path: "answer.txt", old_text: "7391", new_text: "7392" });
  await call("apply_patch", { patch: "*** Begin Patch\n*** Add File: proof.txt\n+synthetic proof\n*** End Patch" });
  assert.equal(readFileSync(path.join(root, "proof.txt"), "utf8"), "synthetic proof\n");
  const command = data(await call("terminal", { command: "node -e 'process.stdout.write(\"synthetic-terminal-ok\")'" }));
  assert.equal(command.exit_code, 0);
  assert(command.output.includes("synthetic-terminal-ok"));
  await call("terminal", { command: "node -e 'console.log(\"READY\");setInterval(()=>{},1000)'", name: "fixture-service", background: true, ready: { pattern: "READY", timeout_ms: 5000 } });
  assert.equal(data(await call("terminal_control", { action: "list" })).terminals.filter((s: { status: string }) => s.status === "running").length, 1);
  await call("terminal_control", { action: "read", terminal: "fixture-service", cursor: "c0" });
  await call("terminal_control", { action: "restart", terminal: "fixture-service" });
  await call("terminal_control", { action: "terminate", terminal: "fixture-service" });
  for (const name of ["demo", "demo.echo"]) {
    const ref = data(await call("capability_search", { query: name })).matches[0].ref;
    await call("capability_control", { action: "activate", ref });
  }
  assert.equal((await runner.mcpDefinitions(goal.id)).length, 1);
  await call("mcp__demo__echo", { id: "fixture-mcp" });
  await call("mcp__demo__echo", { id: 42 }, true);
  await call("context_retrieve", { action: "inspect", ref: "e1" });
  const reply = store.recordResponse("Synthetic tools workflow completed.", { goal_id: goal.id, task_id: task.id, turn_id: turn.id });
  store.completeTurn(turn.id, { responseEventId: reply.id, continuationNote: "All ten tools exercised." });
  await runner.close();
  store.close();

  store = LedgerStore.open({ path: dbPath });
  runner = new ToolRunner({ store, catalog, timeZone: "UTC", approve: async () => true });
  assert.equal((await runner.mcpDefinitions(goal.id)).length, 1);
  assert.equal((await runner.capabilities.activeSkills(goal.id)).skills.length, 1);
  const resumedUser = store.recordUserMessage("Inspect the persisted synthetic workflow.");
  const resumed = store.bindTurn({ userEventId: resumedUser.id, taskId: task.id, route: "resume_existing" });
  binding = { ...binding, turnId: resumed.id, chatId: resumed.chatId };
  run = new RunState();
  assert(data(await call("context_retrieve", { action: "inspect", ref: "e1" })).output.content.includes("7391"));
  assert.equal(data(await call("context_retrieve", { action: "search", query: "Synthetic tools workflow", match: "exact" })).returned, 1);
  await call("mcp__demo__echo", { id: "fixture-after-restart" });

  let live: unknown = null;
  if (process.argv.includes("--live")) {
    if (process.env.SOCRATES_ENV_FILE) {
      const values = parseEnv(readFileSync(process.env.SOCRATES_ENV_FILE, "utf8"));
      for (const key of Object.values(PROVIDER_DEFAULTS).flatMap((d) => [...d.keys])) if (!process.env[key] && values[key]) process.env[key] = values[key];
    }
    const provider = process.env.SOCRATES_PROVIDER ?? "gemini";
    const defaults = PROVIDER_DEFAULTS[provider as Provider];
    assert(defaults, "Unknown provider");
    const model = makeModel(provider, process.env.SOCRATES_ROUTER_MODEL ?? defaults.router);
    const system = "Call read exactly once with path answer.txt. After the result, return the exact synthetic record ID as plain text with no further tool calls.";
    const messages: ModelMessage[] = [{ role: "user", content: "Read answer.txt and report its synthetic record ID." }];
    const first = await model.complete({ system, messages, tools: runner.definitions, maxOutputTokens: 2000, signal: AbortSignal.timeout(60000) });
    assert.equal(first.toolCalls.length, 1);
    assert.equal(first.toolCalls[0]!.name, "read");
    assert.equal((first.toolCalls[0]!.input as { path: string }).path, "answer.txt");
    const result = await dispatch(first.toolCalls[0]!);
    messages.push({ role: "assistant", content: first.text, toolCalls: first.toolCalls, raw: first.raw });
    messages.push({ role: "tool", toolCallId: result.callId, toolName: result.name, content: result.content, isError: result.isError });
    const second = await model.complete({ system, messages, tools: runner.definitions, maxOutputTokens: 2000, signal: AbortSignal.timeout(60000) });
    assert.equal(second.toolCalls.length, 0);
    assert(second.text.includes("synthetic-record-7392"));

    // The model uses grep's newer options from their descriptions alone.
    mkdirSync(path.join(root, "billing"), { recursive: true });
    writeFileSync(path.join(root, "billing", "tax.ts"), "// Rates by region.\nexport function computeTax(amount: number) {\n  return amount * 0.2;\n}\n");
    writeFileSync(path.join(root, "billing", "invoice.ts"), "import { computeTax } from './tax';\nexport const total = (a: number) => a + computeTax(a);\n");
    writeFileSync(path.join(root, "billing", "notes.md"), "Nothing about taxes here.\n");
    const ask = async (request: string, check: (input: Record<string, unknown>, content: string) => void) => {
      const asked = await model.complete({ system: "Answer by calling grep exactly once with the arguments that fit the request best.", messages: [{ role: "user", content: request }], tools: runner.definitions, maxOutputTokens: 4000, signal: AbortSignal.timeout(90000) });
      assert.equal(asked.toolCalls.length, 1, "expected one tool call");
      assert.equal(asked.toolCalls[0]!.name, "grep");
      const run = await dispatch(asked.toolCalls[0]!);
      assert.equal(run.isError, false, run.content);
      check(asked.toolCalls[0]!.input as Record<string, unknown>, run.content);
      return asked.toolCalls[0]!.input;
    };
    const files = await ask("Which files mention computeTax? I only want the file paths, not the lines.", (input, content) => {
      assert.equal(input.output, "files");
      assert(content.includes("billing/tax.ts") && content.includes("billing/invoice.ts") && !content.includes("notes.md"));
    });
    const context = await ask("Show me where computeTax is defined (the line with 'export function computeTax'), with the 2 lines after it.", (input, content) => {
      assert((input.context_after ?? input.context) === 2, `expected two lines of context: ${JSON.stringify(input)}`);
      assert(content.includes("return amount * 0.2;"));
    });
    // And edit's newer forms: several changes in one call, and a new file.
    const editOnce = async (request: string, check: (input: Record<string, unknown>) => void) => {
      // It may look first (read, glob, grep); then it must change the file with one edit call.
      const talk: ModelMessage[] = [{ role: "user", content: request }];
      for (let step = 0; step < 5; step++) {
        const asked = await model.complete({ system: "Use the tools. Change files with the edit tool, in as few edit calls as possible.", messages: talk, tools: runner.definitions, maxOutputTokens: 4000, signal: AbortSignal.timeout(90000) });
        const edits = asked.toolCalls.filter((c) => c.name === "edit");
        if (edits.length) {
          assert.equal(edits.length, 1, `expected one edit call: ${JSON.stringify(asked.toolCalls)}`);
          const run = await dispatch(edits[0]!);
          assert.equal(run.isError, false, run.content);
          check(edits[0]!.input as Record<string, unknown>);
          return edits[0]!.input;
        }
        assert(asked.toolCalls.length && asked.toolCalls.every((c) => ["read", "glob", "grep"].includes(c.name)), `expected a look or an edit: ${JSON.stringify(asked.toolCalls)} ${asked.text}`);
        talk.push({ role: "assistant", content: asked.text, toolCalls: asked.toolCalls, ...(asked.raw ? { raw: asked.raw } : {}) });
        for (const c of asked.toolCalls) {
          const r = await dispatch(c);
          talk.push({ role: "tool", toolCallId: r.callId, toolName: r.name, content: r.content, isError: r.isError });
        }
      }
      throw new Error("no edit call after five steps");
    };
    const several = await editOnce("In billing/tax.ts, change the comment to '// Tax by region.' and change the rate 0.2 to 0.25, in one call.", (input) => {
      assert(Array.isArray(input.edits) && input.edits.length >= 2, `expected edits: ${JSON.stringify(input)}`);
      const tax = readFileSync(path.join(root, "billing", "tax.ts"), "utf8");
      assert(tax.includes("// Tax by region.") && tax.includes("0.25"), tax);
    });
    const created = await editOnce("Create billing/rates.ts containing exactly: export const EU = 0.25;", (input) => {
      assert.equal(input.old_text, "");
      assert.equal(readFileSync(path.join(root, "billing", "rates.ts"), "utf8").trim(), "export const EU = 0.25;");
    });
    live = { provider: model.id, servedBy: second.servedBy ?? model.id, grep: { files, context }, edit: { several, created }, pass: true };
  }
  const recovered = LedgerStore.open({ path: ":memory:" });
  try {
    recovered.restoreEvents(JSON.parse(JSON.stringify(store.listEvents())));
    for (const table of ["events", "goals", "tasks", "turns", "evidence", "task_facts", "active_capabilities", "file_observations"]) {
      assert.deepEqual(recovered.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table);
    }
  } finally { recovered.close(); }
  const report = { pass: true, permanentTools: [...new Set(calls.map((c) => c.name).filter((n) => runner.definitions.some((d) => d.name === n)))], calls, persistentRestart: true, eventReplay: true, live };
  assert.equal(report.permanentTools.length, 10);
  writeFileSync(path.join(dir, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, calls: calls.length, artifact: path.join(dir, "results.json") }));
} finally {
  await runner.close();
  store.close();
}
