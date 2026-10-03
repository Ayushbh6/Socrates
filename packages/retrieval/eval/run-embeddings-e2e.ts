/** Live acceptance run of the embeddings segment (E1 and E2): a real router
 * and agent model work through Socrates.handle while the default local
 * embedder (Ollama, embeddinggemma) indexes the conversation and the
 * workspaces into LanceDB in the background. It checks background indexing,
 * goal routing by meaning alone, context_retrieve search by meaning, another
 * task's history in <RETRIEVED_HISTORY> on a strong match only, a capability
 * suggestion by meaning, <PROJECT_CONTEXT> (anchor sections chosen through the
 * task's note, an anchor edited on disk, a related code file by meaning, a
 * secret file never indexed), keyword fallback when the embedder is
 * unreachable, and restart and rebuild of the derived index. Only synthetic
 * fixture content reaches the providers; embeddings never leave the machine. */
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
writeFileSync(path.join(shop, "src/shipping.js"), "// Delivery fees: parcels are charged by weight band.\nexport function deliveryFee(weightKg) {\n  if (weightKg <= 2) return 4.9;\n  if (weightKg <= 10) return 8.9;\n  return 14.9;\n}\n");
const CANARY = "sk_live_eval_canary_4417";
writeFileSync(path.join(shop, ".env"), `STRIPE_SECRET=${CANARY}\n`);
const german = path.join(dir, "german");
mkdirSync(path.join(german, "learning"), { recursive: true });
const TOPICS = [
  "greetings and introductions: Hallo, Guten Tag, Ich heiße", "numbers from one to twenty: eins bis zwanzig", "articles der, die, das and noun genders",
  "telling the time: Wie spät ist es? Es ist halb drei", "the accusative case with einen, eine, ein", "family members and possessive pronouns mein and dein",
  "food and drink: ordering in a restaurant", "modal verbs können, müssen, wollen", "the dative case with mit, nach, bei", "days of the week and making appointments",
  "separable verbs: aufstehen, einkaufen, anrufen", "the perfect tense with haben", "the perfect tense with sein", "directions: links, rechts, geradeaus",
  "describing your home and furniture", "weather and seasons", "clothes and shopping", "adjective endings after the definite article", "hobbies and free time",
  "comparatives and superlatives", "the body and visiting a doctor", "travel by train: tickets and timetables", "subordinate clauses with weil and dass",
  "the past tense of sein and haben", "jobs and the workplace", "reflexive verbs: sich freuen, sich waschen", "writing an informal letter", "two-way prepositions in, an, auf",
  "review of all cases", "final test and B1 study plan",
];
const PLAN = `# 30-day German plan\nGoal: reach B1 through one structured lesson a day.\n\n${TOPICS.map((t, i) => `## Day ${i + 1}\nTopic: ${t}.\nWarm-up: review the previous day's vocabulary for five minutes. Then work through the topic with ten example sentences, a short dialogue read aloud, and eight practice exercises. Finish with a two-sentence summary in German.\n`).join("\n")}`;
writeFileSync(path.join(german, "learning/30-day-plan.md"), PLAN);
const dbPath = path.join(dir, "ledger.db");
const lance = `${dbPath}.lance`;

/** The default embedder, counted so the eval can see what was (re)embedded. */
let embedCalls = 0;
let secretEmbedded = false;
const counted = (inner: EmbeddingClient): EmbeddingClient => ({ id: inner.id, async embed(texts, purpose, signal) {
  embedCalls++;
  if (texts.some((t) => t.includes(CANARY))) secretEmbedded = true;
  return inner.embed(texts, purpose, signal);
} });
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
    resolveWorkspace: (goal) => (/shop|checkout|cart|release/i.test(goal.title) ? { name: "shop", rootPath: shop } : /german|deutsch/i.test(goal.title) ? { name: "german", rootPath: german } : null),
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
const projectBlock = (r: ModelRequest) => /<PROJECT_CONTEXT>[\s\S]*?<\/PROJECT_CONTEXT>/.exec(context(r))?.[0] ?? "";

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
  const germanStart = await ask("I'm learning German with the 30-day plan in learning/30-day-plan.md. Today is Day 1: greetings and introductions.");
  // The user makes the plan the goal's anchor.
  store.upsertAnchor({ goalId: goalOf(germanStart).id, path: "learning/30-day-plan.md", role: "goal_plan", summary: "curriculum and lesson sequence", status: "active" });
  clock.advance(day);
  await ask("Day 2 of German: numbers from one to twenty.");
  clock.advance(12 * day);
  const cart = await ask("New project: our shop's checkout fails as soon as a cart holds more than 50 items. The check is in src/cart.js. Please find and fix the bug.");
  await ask("For the record, the code word for this checkout fix is lantern-7. Please confirm you noted it.");
  clock.advance(10 * day);
  const garden = await ask("Something else entirely: help me plan four raised vegetable beds for my garden.");
  const germanGoal = goalOf(germanStart), shopGoal = goalOf(cart), gardenGoal = goalOf(garden);
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

  // 6. <PROJECT_CONTEXT>: "today's lesson" names no day; the task's note does, and selects that day's section of the anchor.
  const today = await ask("Okay, let's start today's lesson.");
  assert.equal(goalOf(today).id, germanGoal.id, `routed to ${goalOf(today).title}`);
  const todayBlock = projectBlock(today.made[0]!);
  const shown = [...todayBlock.matchAll(/--- learning\/30-day-plan\.md › Day (\d+)/g)].map((m) => Number(m[1]));
  const noted = [...context(today.made[0]!).matchAll(/<CURRENT_TASK>[\s\S]*?<\/CURRENT_TASK>/g)].map((m) => m[0]).join("\n");
  const days = [...noted.matchAll(/Day (\d+)/gi)].map((m) => Number(m[1]));
  assert.match(todayBlock, /anchor learning\/30-day-plan\.md — goal_plan \(\d+ lines; outline/, `block: ${short(todayBlock)}`);
  assert(shown.some((d) => days.includes(d)), `sections: Day ${shown.join(", ")}; the task mentions Day ${days.join(", ")}`);
  passed("anchor sections are chosen through the task's note when the message names no day", `task mentions Day ${[...new Set(days)].join(", ")}; sections: Day ${shown.join(", ")}; ${short(today.result.text)}`);

  // 7. The anchor is edited on disk: the next turn shows the current text, never the old one.
  const EDITED = "Topic: ordering coffee and cake in a Konditorei (replaces the earlier topic).";
  writeFileSync(path.join(german, "learning/30-day-plan.md"), PLAN.replace(/^Topic: .*$/gm, EDITED));
  const edited = await ask("Remind me what the plan says for today's lesson.");
  assert.equal(goalOf(edited).id, germanGoal.id);
  const editedBlock = projectBlock(edited.made[0]!);
  assert(editedBlock.includes("Konditorei"), `block: ${short(editedBlock)}`);
  assert(!TOPICS.some((t) => editedBlock.includes(`Topic: ${t}.`)), "an old section text must never be shown");
  assert.match(edited.result.text, /Konditorei|coffee|cake|Kaffee|Kuchen/i);
  passed("an anchor edited on disk is shown as it is now", short(edited.result.text));

  // 8. A workspace file found by meaning alone, only when it matches strongly; a secret file is never indexed or shown.
  const fees = await ask("Back to the shop: how do we work out what customers pay to have their parcels delivered?");
  assert.equal(goalOf(fees).id, shopGoal.id, `routed to ${goalOf(fees).title}`);
  const feesBlock = projectBlock(fees.made[0]!);
  assert.match(feesBlock, /--- src\/shipping\.js \(lines \d+–\d+\) — related file/, `block: ${short(feesBlock)}`);
  assert(!/related file/.test(projectBlock(unrelated.made[0]!)), "an unrelated message must not pull in workspace files");
  assert(!secretEmbedded, "the .env file must never be embedded");
  assert(!requests.some((r) => projectBlock(r).includes(CANARY)), "the .env file must never appear in PROJECT_CONTEXT");
  passed("a related workspace file appears on a strong meaning match only; secrets are never indexed", `fees: ${short(fees.result.text)}`);

  // 9. Offline: with the embedder unreachable, Socrates answers with keyword search, without waiting.
  await retrieval.idle();
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

  // 10. Restart catches up only on what changed while the index was closed (the offline turn), then re-embeds nothing.
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
