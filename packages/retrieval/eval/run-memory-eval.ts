/** Retrieval eval of memory (M2 of docs/memory.md): which remembered entries
 * `<MEMORY_CANDIDATES>` offers for a message. Twenty synthetic memories (most
 * of them knowledge, some limited to one goal) are indexed with the default
 * local embedder (Ollama, embeddinggemma) into LanceDB; thirty-five messages,
 * fifteen of which should surface nothing, are scored for precision and
 * recall at several meaning floors and with keywords alone. No chat model is
 * called and nothing leaves the machine. The data folder is deleted at the
 * end. Exits non-zero when the production rule falls under its floors. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoryCandidates } from "@socrates/agent";
import type { MemoryKind } from "@socrates/contracts";
import { makeEmbedder } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import { DEFAULT_THRESHOLDS, MEMORY_WEAK_FLOOR, Retrieval, type SemanticHit, rankMemories } from "../src";

const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, "memory-")));

const store = LedgerStore.open({ path: ":memory:" });
const shop = store.createGoal({ title: "Shop" });
const holiday = store.createGoal({ title: "Berlin holiday" });
const general = store.ensureGeneral().goal;

const MEMORIES: Record<string, { text: string; kind?: MemoryKind; goal?: string }> = {
  trip: { text: "The Berlin trip is from 14 to 18 March." },
  hotel: { text: "Booked a hotel near Alexanderplatz for the Berlin trip." },
  flights: { text: "Flights to Berlin are with Austrian Airlines, leaving Vienna at 7:10.", goal: holiday.id },
  mira: { text: "Their daughter Mira's birthday is on 2 June." },
  latex: { text: "Decided to write the thesis in LaTeX with the Tufte template." },
  dentist: { text: "Sees Dr. Weber for a dental check-up every six months." },
  postgres: { text: "Chose Postgres over MySQL for side projects because of JSONB." },
  marathon: { text: "Runs the Vienna half marathon on 12 April." },
  landlord: { text: "Their landlord is Herr Gruber; rent is due on the 3rd of each month." },
  german: { text: "Their German is at A2; the goal is B1 by December." },
  ibuprofen: { text: "Their doctor told them to avoid ibuprofen." },
  car: { text: "The car's next service is due at 60,000 km." },
  pizza: { text: "Their favourite pizza place is Da Michele in Neubau." },
  checkout: { text: "The checkout limit was raised from 50 to 100 items on 3 October.", goal: shop.id },
  stripe: { text: "Stripe is the payment provider; PayPal was dropped in September.", goal: shop.id },
  flyio: { text: "Deploys go to Fly.io in the Frankfurt region.", goal: shop.id },
  newsletter: { text: "The shop newsletter goes out on the first Monday of the month.", goal: shop.id },
  plants: { text: "Waters the balcony plants on Sundays." },
  bike: { text: "Commutes by bike; the bike lock code is not stored here." },
  podcast: { text: "Listens to the Lex Fridman podcast on long drives." },
};
const handle = new Map<string, string>();
const label = new Map<string, string>();
for (const [key, m] of Object.entries(MEMORIES)) {
  const { memory } = store.saveMemory({ kind: m.kind ?? "knowledge", goalId: m.goal ?? null, text: m.text, by: "user" });
  handle.set(key, memory.id);
  label.set(memory.id, key);
}

/** [goal, message, entries it should offer, entries it may also offer]. */
const CASES: [string, string, string[], string[]?][] = [
  [holiday.id, "What dates is my Berlin trip again?", ["trip"], ["hotel", "flights"]],
  [holiday.id, "Find me a restaurant near my hotel in Berlin.", ["hotel"], ["trip"]],
  [holiday.id, "Which airline am I flying with?", ["flights"], ["trip", "hotel"]],
  [holiday.id, "What should I pack for March in Berlin?", ["trip"], ["hotel", "flights"]],
  [shop.id, "How many items can someone buy at checkout now?", ["checkout"]],
  [shop.id, "Add Apple Pay to the payment options.", ["stripe"]],
  [shop.id, "Why is the deploy failing in the Frankfurt region?", ["flyio"]],
  [shop.id, "Which database should I use for the new inventory service?", ["postgres"]],
  [shop.id, "When does the next newsletter go out?", ["newsletter"]],
  [shop.id, "Which airline am I flying with?", [], ["trip", "hotel"]],
  [general.id, "Plan a birthday party for my daughter.", ["mira"]],
  [general.id, "When is Mira's birthday?", ["mira"]],
  [general.id, "I have a headache, what painkiller can I take?", ["ibuprofen"]],
  [general.id, "Help me prepare for my German exam.", ["german"]],
  [general.id, "Draft an email to my landlord about the broken heating.", ["landlord"]],
  [general.id, "When is my rent due?", ["landlord"]],
  [general.id, "Make me a running plan for the next six weeks.", ["marathon"]],
  [general.id, "When is my car due for a service?", ["car"]],
  [general.id, "Set up the bibliography for my thesis.", ["latex"]],
  [general.id, "Recommend a pizza place for tonight.", ["pizza"]],
  [general.id, "Remind me to book a dental check-up.", ["dentist"]],
  [general.id, "What's the capital of Australia?", []],
  [general.id, "Explain how a TCP handshake works.", []],
  [general.id, "Write a haiku about autumn.", []],
  [general.id, "Convert 30 degrees Celsius to Fahrenheit.", []],
  [general.id, "Thanks, that's all for now.", []],
  [general.id, "Summarize the plot of Hamlet.", []],
  [general.id, "What time is it in Tokyo?", []],
  [general.id, "How do I center a div in CSS?", []],
  [general.id, "Give me a recipe for banana bread.", []],
  [general.id, "What is the difference between a list and a tuple in Python?", []],
  [general.id, "Recommend a good science fiction novel.", []],
  [general.id, "How does compound interest work?", []],
  [general.id, "Translate 'good morning' into Spanish.", []],
  [general.id, "What are the rules of chess castling?", []],
];

const embedder = makeEmbedder({});
const retrieval = await Retrieval.open({ store, embedder, uri: path.join(dir, "index.lance"), workspaceFiles: false });
try {
  const started = performance.now();
  await retrieval.sync();
  console.log(`Indexed ${Object.keys(MEMORIES).length} memories with ${embedder.id.split(":").slice(0, 2).join(":")} in ${Math.round(performance.now() - started)} ms.`);
  assert.ok((await retrieval.status()).documents >= Object.keys(MEMORIES).length, "every memory is indexed (is Ollama running with embeddinggemma?)");

  // One meaning search per message, as a turn makes it.
  const searches: SemanticHit[][] = [];
  const times: number[] = [];
  for (const [goalId, message] of CASES) {
    const t0 = performance.now();
    searches.push(await retrieval.search(message, { kinds: ["memory"], goalIdsOrNone: [goalId], limit: 20, min: "related" }));
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);

  const score = (offered: (i: number) => string[]) => {
    let expected = 0, found = 0, returned = 0, right = 0, quietMisses = 0;
    const mistakes: string[] = [];
    CASES.forEach(([, message, want, may = []], i) => {
      const got = offered(i).map((id) => label.get(id)!);
      expected += want.length;
      found += want.filter((k) => got.includes(k)).length;
      returned += got.length;
      const wrong = got.filter((k) => !want.includes(k) && !may.includes(k));
      right += got.length - wrong.length;
      if (!want.length && wrong.length) quietMisses++;
      const missing = want.filter((k) => !got.includes(k));
      if (wrong.length || missing.length) mistakes.push(`  "${message}"${missing.length ? ` missed ${missing.join(", ")}` : ""}${wrong.length ? ` offered ${wrong.join(", ")}` : ""}`);
    });
    return { recall: found / expected, precision: returned ? right / returned : 1, quietMisses, mistakes };
  };
  const strict = (floor: number, weakFloor: number, semantic: boolean) => (i: number) => rankMemories(store, { query: CASES[i]![1], goalId: CASES[i]![0], semantic: semantic ? searches[i]! : [], strict: true, meaningFloor: floor, weakFloor, limit: 4, now: new Date() }).map((r) => r.memory.id);

  const rows: [string, ReturnType<typeof score>][] = [];
  for (const weak of [0.2, MEMORY_WEAK_FLOOR]) for (const floor of [0.3, 0.35, 0.4, 0.45]) if (floor > weak) rows.push([`floor ${floor.toFixed(2)}, with a word ${weak.toFixed(2)}`, score(strict(floor, weak, true))]);
  rows.push(["keywords only (embedder down)", score(strict(DEFAULT_THRESHOLDS.suggest, MEMORY_WEAK_FLOOR, false))]);
  const negatives = CASES.filter(([, , want]) => !want.length).length;
  console.log(`\n${CASES.length} messages (${negatives} should offer nothing); meaning search median ${Math.round(times[Math.floor(times.length / 2)]!)} ms, max ${Math.round(times.at(-1)!)} ms.\n`);
  console.log("rule                                recall  precision  wrong offers on 'nothing' messages");
  for (const [name, r] of rows) console.log(`${name.padEnd(36)}${(r.recall * 100).toFixed(0).padStart(5)}%  ${(r.precision * 100).toFixed(0).padStart(8)}%  ${r.quietMisses}/${negatives}`);

  // The production path: the agent's own block builder, default floor, nothing in <MEMORY>.
  const settings = { save: true, use: true };
  const production = score((i) => memoryCandidates(store, { goal: store.requireGoal(CASES[i]![0]), message: CASES[i]![1], semantic: searches[i]!, settings, now: new Date(), timeZone: "UTC" }).ids);
  console.log(`\nProduction (<MEMORY_CANDIDATES>, floor ${DEFAULT_THRESHOLDS.suggest}, with a word ${MEMORY_WEAK_FLOOR}): recall ${(production.recall * 100).toFixed(0)}%, precision ${(production.precision * 100).toFixed(0)}%, wrong offers on 'nothing' messages ${production.quietMisses}/${negatives}.`);
  if (production.mistakes.length) console.log(`Mistakes:\n${production.mistakes.join("\n")}`);

  console.log("\nBest similarity per message (what the floors cut):");
  CASES.forEach(([, message, want], i) => {
    const top = searches[i]!.slice(0, 2).map((h) => `${label.get(h.sourceId)} ${h.similarity.toFixed(2)}`).join(", ") || "none ≥ 0.20";
    console.log(`  ${want.length ? "+" : "-"} ${message.slice(0, 58).padEnd(58)} ${top}`);
  });

  // Measured 2026-10-10: recall 0.95, precision 0.96, no wrong offers on the fifteen "nothing" messages.
  assert.ok(production.recall >= 0.85, `recall ${production.recall.toFixed(2)} is under 0.85`);
  assert.ok(production.precision >= 0.9, `precision ${production.precision.toFixed(2)} is under 0.90`);
  assert.ok(production.quietMisses <= 1, `${production.quietMisses} messages that should offer nothing offered something`);
  console.log("\nPassed.");
} finally {
  await retrieval.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
