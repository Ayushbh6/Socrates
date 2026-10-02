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
    live = { provider: model.id, servedBy: second.servedBy ?? model.id, pass: true };
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
