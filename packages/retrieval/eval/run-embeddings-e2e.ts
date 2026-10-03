/** Live acceptance run of the embeddings segment (E1): a real router and
 * agent model work through Socrates.handle while the default local embedder
 * (Ollama, embeddinggemma) indexes the conversation into LanceDB in the
 * background. It checks background indexing, goal routing by meaning alone,
 * context_retrieve search by meaning, another task's history in
 * <RETRIEVED_HISTORY> on a strong match only, a capability suggestion by
 * meaning, keyword fallback when the embedder is unreachable, and restart and
 * rebuild of the derived index. Only synthetic fixture content reaches the
 * providers; embeddings never leave the machine. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type EmbeddingClient, type ModelClient, type ModelRequest, userText } from "@socrates/contracts";
import { type HandleResult, Socrates } from "@socrates/agent";
import { OllamaEmbedder, makeEmbedder, makeModel, PROVIDER_DEFAULTS, type Provider } from "@socrates/providers";
import { selectOlderCandidates } from "@socrates/router";
import { fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { type CatalogEntry, RunState, StaticCatalog, ToolRunner } from "@socrates/tools";
import { loadEvaluationEnvironment } from "../../router/eval/environment";
import { Retrieval } from "../src";

loadEvaluationEnvironment();
const provider = process.env.SOCRATES_PROVIDER ?? "gemini";
const defaults = PROVIDER_DEFAULTS[provider as Provider];
if (!defaults) throw new Error("Unknown evaluation provider.");
const main = makeModel(provider, process.env.SOCRATES_MAIN_MODEL ?? defaults.main);
const routerModel = makeModel(provider, process.env.SOCRATES_ROUTER_MODEL ?? defaults.router);

const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, `embeddings-${provider}-`)));
const shop = path.join(dir, "shop");
mkdirSync(path.join(shop, "src"), { recursive: true });
writeFileSync(path.join(shop, "src/cart.js"), "export const CART_LIMIT = 50;\nexport function canCheckout(items) {\n  return items.length > CART_LIMIT ? false : true;\n}\n");
const dbPath = path.join(dir, "ledger.db");
const lance = `${dbPath}.lance`;

/** The default embedder, counted so the eval can see what was (re)embedded. */
let embedCalls = 0;
const counted = (inner: EmbeddingClient): EmbeddingClient => ({ id: inner.id, async embed(texts, purpose, signal) { embedCalls++; return inner.embed(texts, purpose, signal); } });
const embedder = counted(makeEmbedder({}));
assert.match(embedder.id, /^ollama:embeddinggemma:[a-f0-9]{64}$/, "the default embedder must be local Ollama embeddinggemma");

const usage = { requests: 0, promptTokens: 0, outputTokens: 0 };
const requests: ModelRequest[] = [];
const measured = (model: ModelClient, record: boolean): ModelClient => ({
  id: model.id,
  async complete(request) {
    if (record) requests.push({ ...request, signal: undefined });
    const response = await model.complete(request);
    usage.requests++;
    usage.promptTokens += response.usage.promptTokens;
    usage.outputTokens += response.usage.outputTokens;
    return response;
  },
});

const clock = fixedClock("2026-08-01T09:00:00Z");
const store = LedgerStore.open({ path: dbPath, clock });
const logs: string[] = [];
const log = (m: string) => { logs.push(m); console.error(`[diagnostic] ${m}`); };
const RELEASE_NOTES: CatalogEntry = { kind: "skill", name: "release-notes", description: "Write release notes for a fix or a set of merged changes, in the team's house format.", tags: [], aliases: [], provider: "user", availability: "available" };
const catalog = new StaticCatalog([RELEASE_NOTES, { ...RELEASE_NOTES, name: "pdf", description: "Read, render, inspect, and create PDF files." }], {
  "release-notes": { version: "v1", instructions: "Start with RELEASE NOTES and list each change as a bullet.", resourceBase: { kind: "opaque", description: "fixture" }, dependencies: [] },
});

let retrieval: Retrieval;
let socrates: Socrates;
async function open(index: Retrieval) {
  retrieval = index;
  socrates = new Socrates({
    store,
    model: measured(main, true),
    routerModel: measured(routerModel, false),
    timeZone: "UTC",
    approve: async () => true,
    resolveWorkspace: (goal) => (/shop|checkout|cart|release/i.test(goal.title) ? { name: "shop", rootPath: shop } : null),
    catalog,
    semantic: retrieval,
    log,
  });
}
const openIndex = (e: EmbeddingClient = embedder) => Retrieval.open({ store, embedder: e, uri: lance, capabilities: () => catalog.entries(), log });

const rows: { name: string; pass: boolean; details?: string }[] = [];
const passed = (name: string, details?: string) => {
  rows.push({ name, pass: true, ...(details ? { details } : {}) });
  console.log(`PASS ${name}${details ? ` — ${details}` : ""}`);
};
const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 150);
const context = (r: ModelRequest) => userText(r.messages[0]!.content);

async function ask(message: string): Promise<{ result: Extract<HandleResult, { kind: "answered" }>; made: ModelRequest[]; ms: number }> {
  const start = requests.length;
  const started = Date.now();
  const result = await socrates.handle(message);
  const ms = Date.now() - started;
  assert.equal(result.kind, "answered", result.kind === "clarify" ? `Unexpected clarification: ${result.text}` : "");
  if (result.kind !== "answered") throw new Error("unreachable");
  return { result, made: requests.slice(start), ms };
}
const goalOf = (r: { result: Extract<HandleResult, { kind: "answered" }> }) => store.requireGoal(r.result.parts[0]!.turn.goalId!);
const day = 86_400_000;

async function run() {
  await open(await openIndex());
  console.log(`Live embeddings acceptance: ${main.id} (router ${routerModel.id}); embedder ${embedder.id}; LanceDB at ${lance}`);

  // 1. A conversation across three goals; the index catches up in the background.
  const german = await ask("I'm learning German. Let's set up a 30-day plan; today is Day 1: greetings and introductions.");
  clock.advance(day);
  await ask("Day 2 of German: numbers from one to twenty.");
  clock.advance(12 * day);
  const cart = await ask("New project: our shop's checkout fails as soon as a cart holds more than 50 items. The check is in src/cart.js. Please find and fix the bug.");
  await ask("For the record, the code word for this checkout fix is lantern-7. Please confirm you noted it.");
  clock.advance(10 * day);
  const garden = await ask("Something else entirely: help me plan four raised vegetable beds for my garden.");
  const germanGoal = goalOf(german), shopGoal = goalOf(cart), gardenGoal = goalOf(garden);
  assert.equal(new Set([germanGoal.id, shopGoal.id, gardenGoal.id]).size, 3, "the three subjects must be three goals");
  await retrieval.idle();
  const status = await retrieval.status();
  assert.equal(status.watermark, store.latestEventSeq());
  assert(status.documents >= 12, `only ${status.documents} documents indexed`);
  passed("the conversation is indexed in the background after each message", `${status.documents} documents in LanceDB; replies never waited for indexing`);

  // 2. Routing by meaning: the German goal is three weeks old and shares no word with the request.
  // The agent writes the goal's notes, so the eval uses the first phrasing that keywords really cannot reach.
  const now = store.clock.now();
  const phrasings = ["Ready for the next round of vocab and grammar?", "Shall we continue with my Deutsch studies?", "Wie geht es weiter mit meinem Kurs?"];
  const message = phrasings.find((m) => !selectOlderCandidates(store, m, now, gardenGoal.id).some((g) => g.id === germanGoal.id));
  assert(message, "every phrasing shares a keyword with the German goal");
  const keywordOnly = selectOlderCandidates(store, message, now, gardenGoal.id);
  const hits = await retrieval.search(message, { kinds: ["goal", "task"], limit: 30 });
  assert(selectOlderCandidates(store, message, now, gardenGoal.id, hits).some((g) => g.id === germanGoal.id), "meaning retrieval must shortlist the German goal");
  const lesson = await ask(message);
  assert.equal(goalOf(lesson).id, germanGoal.id, `routed to ${goalOf(lesson).title}`);
  passed("routing finds a three-week-old goal by meaning alone", `"${message}"; keyword shortlist: [${keywordOnly.map((g) => g.title).join(", ")}]; routed to "${goalOf(lesson).title}"`);

  // 3. context_retrieve search by meaning, compared with keywords alone.
  const runner = (semantic?: Retrieval) => new ToolRunner({ store, timeZone: "UTC", approve: async () => true, ...(semantic ? { semantic } : {}) });
  const turn = lesson.result.parts[0]!.turn;
  const scope = { binding: { goalId: turn.goalId!, taskId: turn.taskId!, chatId: turn.chatId, turnId: turn.id }, workspace: null, run: new RunState(), signal: new AbortController().signal };
  const query = { action: "search", query: "which problem did we have with purchasing many products at once", target: "all_goals" };
  const withMeaning = JSON.parse((await runner(retrieval).run({ id: "s1", name: "context_retrieve", input: query }, scope)).content);
  const withKeywords = JSON.parse((await runner().run({ id: "s2", name: "context_retrieve", input: query }, scope)).content);
  const cartTurn = cart.result.parts[0]!.turn.projectTurn;
  assert(withMeaning.results.some((r: { project_turn: number }) => r.project_turn === cartTurn), `results: ${JSON.stringify(withMeaning.results.map((r: { project_turn: number }) => r.project_turn))}`);
  assert(!withKeywords.results.some((r: { project_turn: number }) => r.project_turn === cartTurn));
  passed("context_retrieve finds an exchange by meaning that keyword search misses", `meaning: turns ${withMeaning.results.map((r: { project_turn: number }) => r.project_turn).join(", ")}; keywords: ${withKeywords.results.length} result(s)`);

  // 4. A capability suggested by meaning alone, before anything could have activated it.
  const changelog = await ask("Write up a changelog entry for the shop's checkout fix.");
  const suggested = /<CAPABILITY_CANDIDATES>\n- skill c\d+: release-notes — [^\n]*\(similar in meaning\)/.test(context(changelog.made[0]!));
  assert(suggested, `candidates: ${/<CAPABILITY_CANDIDATES>[\s\S]*?<\/CAPABILITY_CANDIDATES>/.exec(context(changelog.made[0]!))?.[0] ?? "none"}`);
  passed("a Skill is suggested by meaning when no keyword matches", short(changelog.result.text));

  // 5. Another task's history: a new task in the shop goal, then a closely related and an unrelated question.
  const release = await ask("Back to the shop project. Start a new task there: write the release notes for version 2.3.");
  const releaseTask = release.result.parts[0]!.task;
  assert.equal(goalOf(release).id, shopGoal.id, `release notes went to ${goalOf(release).title}`);
  assert.notEqual(releaseTask.id, cart.result.parts[0]!.task.id, "the release notes must be their own task");
  const related = await ask("For these release notes, remind me why checkout failed when the cart had more than 50 items.");
  assert.equal(related.result.parts[0]!.task.id, releaseTask.id, `routed to task "${related.result.parts[0]!.task.title}"`);
  const relatedContext = context(related.made[0]!);
  assert.match(relatedContext, /<RETRIEVED_HISTORY>[\s\S]*\(retrieved from task g\d+\/t\d+ "[^"]+"\)[\s\S]*<\/RETRIEVED_HISTORY>/, "the cart task's exchange must be retrieved");
  assert.match(related.result.text, />=|>|limit|50/);
  const unrelated = await ask("Draft a one-line welcome sentence to open these release notes.");
  assert.equal(unrelated.result.parts[0]!.task.id, releaseTask.id);
  assert(!/retrieved from task/.test(context(unrelated.made[0]!)), "an unrelated message must not pull in another task's history");
  passed("another task's history appears on a strong match only, labelled with its task", `related: ${short(related.result.text)}`);

  // 6. Offline: with the embedder unreachable, Socrates answers with keyword search, without waiting.
  await socrates.close();
  const offline = new OllamaEmbedder({ model: "embeddinggemma", baseURL: "http://127.0.0.1:9" });
  const offlineIndex = await Retrieval.open({ store, embedder: offline, uri: path.join(dir, "offline.lance"), log });
  const before = logs.length;
  const searchStarted = Date.now();
  assert.deepEqual(await offlineIndex.search("what did Day 2 cover", { kinds: ["exchange"], limit: 3 }), []);
  const searchMs = Date.now() - searchStarted;
  assert(searchMs < 1_000, `a failed query embedding took ${searchMs} ms`);
  // Within the back-off, the turn's own searches skip meaning search without trying again.
  await open(offlineIndex);
  const fallback = await ask("Back to German: what did Day 2 cover?");
  assert(logs.slice(before).some((l) => l.includes("keyword search only")), "the fallback must be logged");
  assert.match(fallback.result.text, /number|zwanzig|twenty|eins/i);
  passed("an unreachable embedder falls back to keyword search and still answers", `failed query embedding ${searchMs} ms; whole turn ${fallback.ms} ms; ${short(fallback.result.text)}`);
  await socrates.close();

  // 7. Restart catches up only on what changed while the index was closed (the offline turn), then re-embeds nothing.
  embedCalls = 0;
  const caughtUp = await openIndex();
  await caughtUp.idle();
  const catchUp = embedCalls;
  assert(catchUp <= 1, `catching up on one turn took ${catchUp} batches`);
  await caughtUp.close();
  embedCalls = 0;
  const reopened = await openIndex();
  await reopened.idle();
  assert.equal(embedCalls, 0, `restart re-embedded ${embedCalls} batch(es)`);
  const topBefore = (await reopened.search("which problem did we have with purchasing many products at once", { kinds: ["exchange"], limit: 1 }))[0]?.turnId;
  await reopened.close();
  rmSync(lance, { recursive: true, force: true });
  const rebuilt = await openIndex();
  await rebuilt.idle();
  const topAfter = (await rebuilt.search("which problem did we have with purchasing many products at once", { kinds: ["exchange"], limit: 1 }))[0]?.turnId;
  assert(topBefore && topBefore === topAfter, `top hit before ${topBefore}, after ${topAfter}`);
  passed("restart reuses the index; a deleted index is rebuilt from the event log with the same results", `catch-up ${catchUp} batch, then 0 on restart; ${(await rebuilt.status()).documents} documents rebuilt`);
  await rebuilt.close();

  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ provider, main: main.id, router: routerModel.id, embedder: embedder.id, dir, usage, assertions: rows }, null, 2));
  store.close();
  console.log(`${rows.length}/${rows.length} embeddings scenarios passed; ${usage.requests} model calls. Report: ${path.join(dir, "results.json")}`);
}

run().catch(async (error) => {
  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ provider, dir, usage, assertions: rows, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  console.error(error instanceof Error ? error.message : "Embeddings acceptance failed.");
  try {
    await socrates.close();
    store.close();
  } catch {}
  process.exitCode = 1;
});
