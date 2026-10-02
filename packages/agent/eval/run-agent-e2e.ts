/** Live acceptance run of the working agent: a real router and a real agent
 * model work on a disposable calculator project through Socrates.handle. It
 * covers multi-step tool work, continuation, restart with history, a
 * compound message, interruption and recovery, a per-turn limit, and
 * event-only replay. Only synthetic fixture content reaches the provider. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type EventPayloads, type ModelClient, type ModelRequest, type ModelResponse, userText } from "@socrates/contracts";
import { makeModel, PROVIDER_DEFAULTS, type Provider } from "@socrates/providers";
import { countTokens } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { loadEvaluationEnvironment } from "../../router/eval/environment";
import { type AgentLimits, type HandleResult, Socrates } from "../src";

loadEvaluationEnvironment();
const provider = process.env.SOCRATES_PROVIDER ?? "gemini";
const defaults = PROVIDER_DEFAULTS[provider as Provider];
if (!defaults) throw new Error("Unknown evaluation provider.");
const main = makeModel(provider, process.env.SOCRATES_MAIN_MODEL ?? defaults.main);
const routerModel = makeModel(provider, process.env.SOCRATES_ROUTER_MODEL ?? defaults.router);

const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, `agent-${provider}-`)));
const root = path.join(dir, "calculator");
mkdirSync(path.join(root, "src"), { recursive: true });
mkdirSync(path.join(root, "test"), { recursive: true });
writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "calculator", private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
writeFileSync(path.join(root, "src/math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
writeFileSync(path.join(root, "test/math.test.js"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n');
writeFileSync(path.join(root, "README.md"), "# Calculator\n\nFunctions: add\n");
const dbPath = path.join(dir, "ledger.db");

const usage = { requests: 0, promptTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
const requests: ModelRequest[] = [];
let intercept: ((response: ModelResponse) => void) | null = null;
const measured = (model: ModelClient, record: boolean): ModelClient => ({
  id: model.id,
  async complete(request) {
    if (record) requests.push({ ...request, signal: undefined });
    const response = await model.complete(request);
    usage.requests++;
    usage.promptTokens += response.usage.promptTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.cacheReadTokens += response.usage.cacheReadTokens;
    if (record) intercept?.(response);
    return response;
  },
});

let store = LedgerStore.open({ path: dbPath });
const open = (limits?: Partial<AgentLimits>) =>
  new Socrates({
    store,
    model: measured(main, true),
    routerModel: measured(routerModel, false),
    timeZone: "UTC",
    approve: async () => true,
    resolveWorkspace: () => ({ name: "calculator", rootPath: root }),
    ...(limits ? { limits } : {}),
    log: (m) => console.error(`[diagnostic] ${m}`),
  });
let socrates = open();
const rows: { name: string; pass: boolean; details?: string }[] = [];
const passed = (name: string, details?: string) => {
  rows.push({ name, pass: true, ...(details ? { details } : {}) });
  console.log(`PASS ${name}${details ? ` — ${details}` : ""}`);
};

function answered(result: HandleResult) {
  assert.equal(result.kind, "answered", result.kind === "clarify" ? `Unexpected clarification: ${result.text}` : "");
  if (result.kind !== "answered") throw new Error("unreachable");
  return result;
}
function testsPass(): boolean {
  try {
    execFileSync("node", ["--test"], { cwd: root, stdio: "pipe", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}
const source = () => readFileSync(path.join(root, "src/math.js"), "utf8");
const tools = (turnId: string) => store.evidenceForTurn(turnId).map((e) => e.tool);

async function run() {
  console.log(`Live agent acceptance: ${main.id} (router ${routerModel.id})\nWorkspace and database: ${dir}`);
  assert(!testsPass(), "The fixture must start with a failing test.");

  const fix = answered(await socrates.handle("In my calculator project, add returns wrong results and the tests fail. Fix it and run the tests to prove it."));
  const fixTurn = fix.parts[0]!.turn;
  assert.equal(fixTurn.status, "completed");
  assert(testsPass(), "add is still broken.");
  assert(tools(fixTurn.id).some((t) => t === "edit" || t === "apply_patch") && tools(fixTurn.id).includes("terminal"), `tools used: ${tools(fixTurn.id).join(", ")}`);
  const goalId = fixTurn.goalId!;
  const firstTask = store.requireTask(fixTurn.taskId!);
  assert(firstTask.continuationNote && countTokens(firstTask.continuationNote) <= 100);
  passed("multi-step fix with real edits and a real test run", `${tools(fixTurn.id).length} tool calls; workspace bound to the new goal`);

  const extend = answered(await socrates.handle("Now add a subtract function with its own test, and run the tests again."));
  assert.equal(extend.parts[0]!.turn.goalId, goalId);
  assert(/export function subtract/.test(source()) && testsPass());
  passed("continuation in the same goal", `task t${extend.parts[0]!.task.number}`);

  // Restart: a new process sees history only through the event log.
  await socrates.close();
  store.close();
  store = LedgerStore.open({ path: dbPath });
  socrates = open();
  const before = requests.length;
  const recall = answered(await socrates.handle("What exactly have you changed in the calculator so far, and did the tests pass?"));
  const context = userText(requests[before]!.messages[0]!.content);
  assert(/\[TURN \d+ — full\]/.test(context), "The previous turn must be attached with its tool activity.");
  assert(/add/i.test(recall.text) && /subtract/i.test(recall.text), recall.text);
  passed("restart with three-tier history from the event log");

  const ackSeen: string[] = [];
  const both = answered(await socrates.handle("Add a multiply function with a test, then update README.md so it lists every function.", { onAcknowledgment: (t) => ackSeen.push(t) }));
  assert(/export function multiply/.test(source()) && testsPass());
  assert(/multiply/i.test(readFileSync(path.join(root, "README.md"), "utf8")));
  passed(both.parts.length > 1 ? "compound message in ordered parts" : "combined request handled as one task", `${both.parts.length} part(s)${ackSeen.length ? `; "${ackSeen[0]}"` : ""}`);

  const controller = new AbortController();
  intercept = (response) => {
    if (response.toolCalls.length) {
      controller.abort();
      intercept = null;
    }
  };
  const stopped = answered(await socrates.handle("Add a divide function that throws on division by zero, with tests.", { signal: controller.signal }));
  assert.equal(stopped.parts[0]!.turn.status, "interrupted");
  const resumed = answered(await socrates.handle("Please continue where you left off."));
  assert.equal(resumed.parts[0]!.turn.status, "completed");
  assert(/export function divide/.test(source()) && testsPass());
  passed("cancellation records an interrupted turn and the next message recovers", stopped.text);

  await socrates.close();
  socrates = open({ maxSteps: 2 });
  const limited = answered(await socrates.handle("Add a power function with tests, update the README, and run the tests."));
  const stop = limited.parts[0]!.stop;
  assert(stop === "steps" || stop === "final");
  assert.equal(limited.parts[0]!.turn.status, "completed");
  passed("per-turn step limit ends with an honest wrap-up", `stop=${stop}`);

  const approved = answered(await socrates.handle("Use README.md as the canonical project reference."));
  assert.equal(approved.parts[0]!.turn.goalId, goalId);
  assert(store.listAnchors(goalId).some(a => a.path === "README.md" && a.role === "project_reference" && a.status === "active"));
  passed("explicit user anchor authority through the real router and agent");

  const finalController = new AbortController();
  intercept = (response) => {
    if (!response.toolCalls.length) { finalController.abort(); intercept = null; }
  };
  const finalCancelled = answered(await socrates.handle("Briefly summarize the calculator work from context, without tools.", { signal: finalController.signal }));
  assert.equal(finalCancelled.parts[0]!.status, "interrupted");
  assert(store.listEvents({ turnId: finalCancelled.parts[0]!.turn.id, type: "agent_message" }).length > 0);
  passed("cancellation concurrent with a real final response saves the exact response but interrupts the turn");
  await socrates.close();

  const recovered = LedgerStore.open({ path: ":memory:" });
  recovered.restoreEvents(store.listEvents());
  for (const table of ["goals", "tasks", "chats", "turns", "task_revisions", "goal_note_revisions", "anchors", "evidence", "task_facts"]) {
    assert.deepEqual(recovered.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table);
  }
  recovered.close();
  const warnings = store.listEvents({ type: "agent_warning" }).map((e) => e.payload as EventPayloads["agent_warning"]);
  passed("event-only replay of every agent projection", `${warnings.length} operational warning(s)`);

  const report = { provider, main: main.id, router: routerModel.id, dir, usage, warnings, assertions: rows };
  writeFileSync(path.join(dir, "results.json"), JSON.stringify(report, null, 2));
  store.close();
  console.log(`${rows.length}/${rows.length} agent scenarios passed; ${usage.requests} model calls, ${usage.cacheReadTokens} cached prompt tokens. Report: ${path.join(dir, "results.json")}`);
}

run().catch(async (error) => {
  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ provider, dir, usage, assertions: rows, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  console.error(error instanceof Error ? error.message : "Agent acceptance failed.");
  try {
    await socrates.close();
    store.close();
  } catch {}
  process.exitCode = 1;
});
