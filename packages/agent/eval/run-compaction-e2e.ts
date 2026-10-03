/** Live acceptance run of compaction: a real router, agent and compactor work
 * on a disposable project with budgets shrunk so history checkpoints, in-turn
 * linearization and rollover all happen within a few turns. It checks that a
 * request the user is still owed survives compaction verbatim and gets
 * answered, that no request reaches the ceiling, and that everything replays
 * from events. Only synthetic fixture content reaches the provider. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type EventPayloads, type HistoryCheckpoint, type ModelClient, type ModelRequest, userText } from "@socrates/contracts";
import { makeModel, PROVIDER_DEFAULTS, type Provider } from "@socrates/providers";
import { countTokens } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { ToolRunner } from "@socrates/tools";
import { loadEvaluationEnvironment } from "../../router/eval/environment";
import { AGENT_SYSTEM_PROMPT, type ContextBudgets, type HandleResult, Socrates } from "../src";

loadEvaluationEnvironment();
const provider = process.env.SOCRATES_PROVIDER ?? "gemini";
const defaults = PROVIDER_DEFAULTS[provider as Provider];
if (!defaults) throw new Error("Unknown evaluation provider.");
const main = makeModel(provider, process.env.SOCRATES_MAIN_MODEL ?? defaults.main);
const routerModel = makeModel(provider, process.env.SOCRATES_ROUTER_MODEL ?? defaults.router);

const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, `compaction-${provider}-`)));
const root = path.join(dir, "calculator");
for (const sub of ["src", "test", "logs"]) mkdirSync(path.join(root, sub), { recursive: true });
writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "calculator", private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
writeFileSync(path.join(root, "src/math.js"), "export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a - b;\n}\n");
writeFileSync(path.join(root, "test/math.test.js"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add, subtract } from "../src/math.js";\n\ntest("add", () => assert.equal(add(2, 3), 5));\ntest("subtract", () => assert.equal(subtract(5, 3), 2));\n');
const log = Array.from({ length: 20 }, (_, i) => (i === 14 ? `2026-09-30T10:${String(i % 60).padStart(2, "0")}:00Z worker-3 ERROR-7391 cache flush timed out after 30000 ms` : `2026-09-30T10:${String(i % 60).padStart(2, "0")}:00Z worker-${i % 5} INFO request ${1000 + i} handled in ${(i * 37) % 900} ms`));
writeFileSync(path.join(root, "logs/server.log"), `${log.join("\n")}\n`);
const dbPath = path.join(dir, "ledger.db");

// The fixed part of every request; budgets are set relative to it.
const BASE = (() => {
  const s = LedgerStore.open({ path: ":memory:" });
  const r = new ToolRunner({ store: s, timeZone: "UTC", approve: async () => true });
  const n = countTokens(AGENT_SYSTEM_PROMPT) + countTokens(JSON.stringify(r.definitions)) + 32;
  void r.close();
  s.close();
  return n;
})();
// Budgets keep production proportions: target half the trigger, a tool result a small fraction of it.
const budgets: Partial<ContextBudgets> = {
  trigger: BASE + 6_000,
  target: BASE + 3_000,
  ceiling: BASE + 40_000,
  verbatimWindow: 1_200,
  intactWindow: 1_200,
  previousTurn: 800,
  retrievedMax: 2_000,
  maxCompactionsPerChat: 2,
};

const usage = { requests: 0, promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, largestAgentRequest: 0 };
const agentRequests: ModelRequest[] = [];
const measured = (model: ModelClient, record: boolean): ModelClient => ({
  id: model.id,
  async complete(request) {
    if (record) {
      agentRequests.push({ ...request, signal: undefined });
      const size = countTokens(request.system) + countTokens(JSON.stringify(request.tools ?? [])) + request.messages.reduce((n, m) => n + countTokens(m.role === "user" ? userText(m.content) : m.content), 0);
      usage.largestAgentRequest = Math.max(usage.largestAgentRequest, size);
    }
    const response = await model.complete(request);
    usage.requests++;
    usage.promptTokens += response.usage.promptTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.cacheReadTokens += response.usage.cacheReadTokens;
    return response;
  },
});

let store = LedgerStore.open({ path: dbPath });
const statuses: string[] = [];
const open = (extra: Partial<ContextBudgets> = {}) =>
  new Socrates({
    store,
    model: measured(main, true),
    routerModel: measured(routerModel, false),
    compactorModel: measured(main, false),
    timeZone: "UTC",
    approve: async () => true,
    resolveWorkspace: () => ({ name: "calculator", rootPath: root }),
    budgets: { ...budgets, ...extra },
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
  for (const part of result.parts) assert.equal(part.turn.status, "completed", `turn ${part.turn.projectTurn} ended ${part.turn.status}: ${part.answer}`);
  return result;
}
const say = async (message: string) => answered(await socrates.handle(message, { onStatus: (s) => statuses.push(s) }));
const compactions = () => store.listEvents({ type: "compaction_recorded" }).map((e) => e.payload as EventPayloads["compaction_recorded"]);

async function run() {
  console.log(`Live compaction acceptance: ${main.id} (router ${routerModel.id}); base ${BASE} tokens, trigger ${budgets.trigger}\nWorkspace and database: ${dir}`);

  const first = await say("Let's start one review of my calculator project; everything I send next belongs to this same review. To begin, I have three questions: (1) Which functions does src/math.js export? (2) How many tests are in test/math.test.js? (3) Which exact command runs the test suite? Answer only question (1) now; I will ask for the others later in this review.");
  const taskId = first.parts[0]!.task.id;
  const questionTurn = first.parts[0]!.turn.projectTurn;
  for (const topic of ["how the add and subtract tests are structured", "how you would add a modulo function with tests", "how errors from these functions should be reported to callers", "how you would document these functions for new contributors", "how you would benchmark these functions", "how you would add input validation", "how you would publish this package", "how you would support floating point rounding"]) {
    const reply = await say(`Continuing this same review: without changing any files, write a detailed explanation of about 500 words of ${topic}.`);
    assert.equal(reply.parts[0]!.task.id, taskId, "The review must stay in one task.");
  }
  const logTurn = await say("Still in this review: read the whole of logs/server.log with the read tool (not grep) and tell me which line mentions ERROR-7391 and what it says.");
  assert.equal(logTurn.parts[0]!.task.id, taskId, "The review must stay in one task.");
  const checkpoints = () => [...Array(store.historyRecordCount(taskId)).keys()].map((i) => store.historyRecord(taskId, i + 1)!).filter((r) => r.kind === "checkpoint");
  assert(compactions().length >= 1, "The budgets should have triggered compaction.");
  const written = checkpoints().filter((r) => !r.mechanical);
  assert(written.length >= 1, "A real checkpoint should have been written.");
  const owed = written.flatMap((r) => (r.content as HistoryCheckpoint).outstanding_requests);
  assert(owed.some((r) => r.turn === questionTurn && /\(3\)|command/i.test(r.quote)), `Question (3) should be owed verbatim: ${JSON.stringify(owed)}`);
  passed("history checkpoint carries the unanswered question verbatim", `${compactions().length} compaction(s); owed: ${owed.map((r) => `turn ${r.turn} "${r.quote}"`).join("; ")}`);

  const recall = await say("In this review, which of my three earlier questions have you not answered yet? Answer them now.");
  assert(/node --test|npm test|npm run test/i.test(recall.text), recall.text);
  passed("the owed question is answered after compaction", recall.text.slice(0, 160).replace(/\s+/g, " "));

  // A small per-chat allowance makes the next trigger roll the chat over, mid-turn.
  await socrates.close();
  // This chat's allowance is used up, and a lower trigger with the same proportions fires on the next request.
  socrates = open({ maxCompactionsPerChat: store.currentChat(taskId).compactionCount, trigger: BASE + 2_000, target: BASE + 1_000 });
  const chatBefore = store.currentChat(taskId);
  const rolled = await say("Continuing the review: read the whole of logs/server.log again with the read tool (not grep) and count how many lines are from worker-3.");
  const chatAfter = store.currentChat(taskId);
  assert.notEqual(chatAfter.id, chatBefore.id, "The chat should have rolled over.");
  assert.equal(chatAfter.continuationOf, chatBefore.id);
  assert.equal(rolled.parts[0]!.turn.chatId, chatBefore.id, "The in-flight turn stays under the closed chat.");
  const capsule = store.latestHistoryRecord(taskId)!;
  assert.equal(capsule.kind, "handover");
  assert(statuses.includes("Refreshing this long task's context…"));
  passed("rollover continues the same turn in a linked chat", `capsule ${capsule.handle}${capsule.mechanical ? " (mechanical)" : ""}; answer: ${rolled.text.slice(0, 100).replace(/\s+/g, " ")}`);

  await socrates.close();
  store.close();
  store = LedgerStore.open({ path: dbPath });
  socrates = open();
  const after = await say("In this review, what did you find in the log about ERROR-7391?");
  assert(/30000|timed out|cache flush/i.test(after.text), after.text);
  assert.equal(after.parts[0]!.turn.chatId, chatAfter.id);
  passed("restart in the continuation chat keeps the work", after.text.slice(0, 120).replace(/\s+/g, " "));
  await socrates.close();

  assert(usage.largestAgentRequest < budgets.ceiling!, `An agent request reached ${usage.largestAgentRequest} tokens.`);
  const recovered = LedgerStore.open({ path: ":memory:" });
  recovered.restoreEvents(store.listEvents());
  for (const table of ["chats", "history_records", "turns", "tasks", "task_revisions", "evidence"]) {
    assert.deepEqual(recovered.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table);
  }
  recovered.close();
  const warnings = store.listEvents({ type: "agent_warning" }).map((e) => e.payload as EventPayloads["agent_warning"]);
  passed("ceiling respected and event-only replay of every projection", `largest agent request ${usage.largestAgentRequest} of ceiling ${budgets.ceiling}; ${warnings.length} warning(s)`);

  const report = { provider, main: main.id, router: routerModel.id, dir, base: BASE, budgets, usage, compactions: compactions(), records: store.historyRecordCount(taskId), warnings, assertions: rows };
  writeFileSync(path.join(dir, "results.json"), JSON.stringify(report, null, 2));
  store.close();
  console.log(`${rows.length}/${rows.length} compaction scenarios passed; ${usage.requests} model calls. Report: ${path.join(dir, "results.json")}`);
}

run().catch(async (error) => {
  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ provider, dir, usage, compactions: (() => { try { return compactions(); } catch { return null; } })(), assertions: rows, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  console.error(error instanceof Error ? error.message : "Compaction acceptance failed.");
  try {
    await socrates.close();
    store.close();
  } catch {}
  process.exitCode = 1;
});
