/** Live acceptance run of lanes (L1): a real router and agent work through
 * one Socrates while lanes run alongside the main conversation. It checks a
 * lane working while main runs a slow test suite, a lane's follow-up
 * continuing its task without routing, a main message handed to the lane
 * busy with its task while main answers something else, stopping one lane
 * while another finishes, and lanes surviving a restart and an event-only
 * rebuild. Only synthetic fixture content reaches the provider. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelClient } from "@socrates/contracts";
import { makeModel, PROVIDER_DEFAULTS, type Provider } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import { loadEvaluationEnvironment } from "../../router/eval/environment";
import { type HandleResult, Socrates } from "../src";

loadEvaluationEnvironment();
const provider = process.env.SOCRATES_PROVIDER ?? "gemini";
const defaults = PROVIDER_DEFAULTS[provider as Provider];
if (!defaults) throw new Error("Unknown evaluation provider.");
const main = makeModel(provider, process.env.SOCRATES_MAIN_MODEL ?? defaults.main);
const routerModel = makeModel(provider, process.env.SOCRATES_ROUTER_MODEL ?? defaults.router);

const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, `lanes-${provider}-`)));
const SLOW_MS = 15_000;
const server = path.join(dir, "server");
mkdirSync(path.join(server, "test"), { recursive: true });
writeFileSync(path.join(server, "package.json"), JSON.stringify({ name: "server", private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
writeFileSync(path.join(server, "test/slow.test.js"), `import test from "node:test";\nimport assert from "node:assert/strict";\n\ntest("integration suite", async () => {\n  await new Promise((done) => setTimeout(done, ${SLOW_MS}));\n  assert.equal(1 + 1, 2);\n});\n`);
const notes = path.join(dir, "notes");
mkdirSync(notes, { recursive: true });
writeFileSync(path.join(notes, "README.md"), "# Notes\n\nPersonal notes project.\n");
writeFileSync(path.join(notes, "wait.js"), "setTimeout(() => console.log('done waiting'), 20000);\n");
const dbPath = path.join(dir, "ledger.db");

const usage = { requests: 0, routerRequests: 0 };
const measured = (model: ModelClient, router: boolean): ModelClient => ({
  id: model.id,
  async complete(request) {
    const response = await model.complete(request);
    usage.requests++;
    if (router) usage.routerRequests++;
    return response;
  },
});

let store = LedgerStore.open({ path: dbPath });
const open = () =>
  new Socrates({
    store,
    model: measured(main, false),
    routerModel: measured(routerModel, true),
    timeZone: "UTC",
    approve: async () => true,
    resolveWorkspace: (goal) => (/note|changelog|todo/i.test(goal.title) ? { name: "notes", rootPath: notes } : { name: "server", rootPath: server }),
    log: (m) => console.error(`[diagnostic] ${m}`),
  });
let socrates = open();
const rows: { name: string; pass: boolean; details?: string }[] = [];
const passed = (name: string, details?: string) => {
  rows.push({ name, pass: true, ...(details ? { details } : {}) });
  console.log(`PASS ${name}${details ? ` — ${details}` : ""}`);
};
const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 140);
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
function answered(result: HandleResult) {
  assert.equal(result.kind, "answered", result.kind === "clarify" ? `Unexpected clarification: ${result.text}` : "");
  if (result.kind !== "answered") throw new Error("unreachable");
  return result;
}
/** When a promise settled, in ms since the run started. */
const t0 = Date.now();
const timed = <T>(p: Promise<T>) => {
  const out = p.then((value) => ({ value, at: Date.now() - t0 }));
  // A run still pending when the eval fails is cancelled by close(); that is not a second failure.
  out.catch(() => {});
  return out;
};
/** Wait until a condition holds, checking every 100 ms. */
async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!condition() && Date.now() < end) await wait(100);
  return condition();
}

async function run() {
  console.log(`Live lanes acceptance: ${main.id} (router ${routerModel.id}); data in ${dir}`);

  // 1. Main runs a slow test suite; a lane starts and finishes other work meanwhile.
  const mainRun = timed(socrates.handle("Let's work on the server project: run `npm test` and tell me whether the tests pass."));
  await wait(1_500);
  assert(socrates.busy, "main must still be running the suite");
  let laneId: string | null = null;
  const laneStart = Date.now() - t0;
  const lane = await timed(socrates.handle("Open my notes project and add a CHANGELOG.md with a single entry: 0.1 — first release.", { lane: "new", onLane: (id) => (laneId = id) }));
  const first = await mainRun;
  const laneResult = answered(lane.value);
  const mainResult = answered(first.value);
  assert(laneId && laneResult.laneId === laneId);
  assert(laneStart < first.at, "the lane must start while main is still working");
  assert(existsSync(path.join(notes, "CHANGELOG.md")) && readFileSync(path.join(notes, "CHANGELOG.md"), "utf8").includes("0.1"), "CHANGELOG.md with 0.1 must exist");
  assert.match(mainResult.text, /pass/i);
  const serverTask = mainResult.parts[0]!.task;
  assert.equal(store.currentBinding()!.task.id, serverTask.id, "the lane must not change main's current task");
  assert.equal(laneResult.parts[0]!.turn.laneId, laneId);
  passed("a lane works while main runs a slow test suite, and main's current task stays main's", `lane done at ${(lane.at / 1000).toFixed(1)} s, main at ${(first.at / 1000).toFixed(1)} s; lane: ${short(laneResult.text)}`);

  // 2. A follow-up in the lane continues its task without routing.
  const routed = usage.routerRequests;
  const followUp = answered(await socrates.handle("Add a second entry: 0.2 — lanes.", { lane: laneId! }));
  assert.equal(usage.routerRequests, routed, "a lane's follow-up must not be routed");
  assert.equal(followUp.parts[0]!.task.id, laneResult.parts[0]!.task.id);
  assert(readFileSync(path.join(notes, "CHANGELOG.md"), "utf8").includes("0.2"), "CHANGELOG.md must gain 0.2");
  passed("a lane's follow-up continues its task directly", short(followUp.text));

  // 3. A main message for the task a lane is busy with is handed to that lane; main answers something else meanwhile.
  let lane2: string | null = null;
  const rerun = timed(socrates.handle("In the server project, run `npm test` once more and report the result.", { lane: "new", onLane: (id) => (lane2 = id) }));
  await wait(2_000);
  let handedTo: string | null = null;
  // Part of the same test-run task, so it belongs to the run lane 2 is busy with.
  const readme = timed(socrates.handle("For that same `npm test` run on the server, also tell me how many seconds the suite took.", { onHandoff: (id) => (handedTo = id) }));
  // The handoff happens once the message is routed.
  await until(() => handedTo !== null, 20_000);
  assert(handedTo === lane2, `the follow-up must be handed to lane ${lane2}, went to ${handedTo ?? "main"}`);
  assert(!socrates.busy, "main must be free after the handoff");
  const quick = await timed(socrates.handle("Quick one: what is 12 times 12?"));
  assert.match(answered(quick.value).text, /144/);
  const [rerunDone, readmeDone] = [await rerun, await readme];
  assert(quick.at < readmeDone.at, "main must answer while the handed-off request waits");
  assert(rerunDone.at <= readmeDone.at, "the handed-off request runs after the lane's current turn");
  const followUp2 = answered(readmeDone.value);
  assert.equal(followUp2.parts[0]!.turn.laneId, lane2);
  assert.match(followUp2.text, /\d+(\.\d+)?\s*(s|sec|second)/i);
  passed("a main message for a task busy in a lane is handed to that lane while main keeps answering", `quick answer at ${(quick.at / 1000).toFixed(1)} s, handed-off answer at ${(readmeDone.at / 1000).toFixed(1)} s: ${short(followUp2.text)}`);

  // 4. Stopping one lane leaves another to finish.
  const stop = new AbortController();
  const slow = timed(socrates.handle("In the notes project, run `node wait.js` (it takes 20 seconds) and tell me what it prints.", { lane: "new", signal: stop.signal }));
  const todo = timed(socrates.handle("In the notes project, create TODO.md listing three items for next week.", { lane: "new" }));
  await wait(4_000);
  stop.abort();
  const stopped = answered((await slow).value);
  assert.equal(stopped.parts[0]!.status, "interrupted");
  const finished = answered((await todo).value);
  assert.equal(finished.parts[0]!.status, "completed");
  assert(existsSync(path.join(notes, "TODO.md")), "TODO.md must exist");
  passed("stopping one lane leaves another to finish", short(finished.text));

  // 5. Lanes survive a restart and an event-only rebuild.
  const before = socrates.lanes();
  assert.equal(before.length, 4);
  await socrates.close();
  store.close();
  store = LedgerStore.open({ path: dbPath });
  socrates = open();
  assert.deepEqual(socrates.lanes().map((l) => [l.number, l.running]), before.map((l) => [l.number, false]));
  socrates.closeLane(laneId!);
  assert.equal(socrates.lanes().length, 3);
  const rebuilt = LedgerStore.open({ path: ":memory:" });
  rebuilt.restoreEvents(store.listEvents());
  assert.deepEqual(rebuilt.listLanes({ includeClosed: true }), store.listLanes({ includeClosed: true }));
  assert.equal(rebuilt.currentBinding()!.task.id, store.currentBinding()!.task.id);
  rebuilt.close();
  passed("lanes survive a restart and an event-only rebuild", `${before.length} lanes restored; one closed`);
  await socrates.close();

  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ provider, main: main.id, router: routerModel.id, dir, usage, assertions: rows }, null, 2));
  store.close();
  console.log(`${rows.length}/${rows.length} lane scenarios passed; ${usage.requests} model calls. Report: ${path.join(dir, "results.json")}`);
}

run().catch(async (error) => {
  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ provider, dir, usage, assertions: rows, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  console.error(error instanceof Error ? error.message : "Lanes acceptance failed.");
  try {
    await socrates.close();
    store.close();
  } catch {}
  process.exitCode = 1;
});
