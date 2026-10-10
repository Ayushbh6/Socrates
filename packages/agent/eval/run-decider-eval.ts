/**
 * Live evaluation of the memory decider (docs/memory.md, M3a): the two yes/no
 * questions the gates ask (would a recall help? is something worth saving?),
 * put to the real decider through OpenRouter for a labelled set of messages,
 * and scored at each threshold. The messages are written in the voice of a
 * person talking to a coding agent: short and long, with typos, with the
 * answer they follow where that matters, and many that should trigger
 * neither gate. Labels are mine: a recall is wanted when the reply depends on
 * something about the user or the past that the message does not contain; a
 * save when the message states a lasting fact, preference, decision or
 * correction.
 *
 *   SOCRATES_ENV_FILE=.env pnpm eval:decider
 *
 * Messages in `.socrates/evals/decider-real.json` (not committed; a list of
 * [message, previous answer or null, recall 0|1, save 0|1]) are scored with
 * the rest, so real phrasing can be added without publishing it. Exits
 * non-zero when the shipped thresholds fall under their floors.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenRouterDecider } from "@socrates/providers";
import { loadEvaluationEnvironment } from "../../router/eval/environment";
import { GATE_QUESTIONS, RECALL_AT, RECALL_STRONG_AT, SAVE_AT, gateState } from "../src";

loadEvaluationEnvironment();
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("Set OPENROUTER_API_KEY or SOCRATES_ENV_FILE for the decider evaluation.");

/** [message, the answer it follows, recall wanted, save wanted] */
type Case = [string, string | null, 0 | 1, 0 | 1];

const CASES: Case[] = [
  // A lasting fact, preference, decision or correction: save.
  ["Remember that I prefer pnpm over npm in all my projects.", null, 0, 1],
  ["From now on, always give me the short version first.", null, 0, 1],
  ["I'm a backend engineer, mostly Go and Postgres.", null, 0, 1],
  ["My daughter Mira turns 7 on 2 June.", null, 0, 1],
  ["Please never add Co-Authored-By lines to my commits.", null, 0, 1],
  ["I live in Vienna, so use CET for everything.", null, 0, 1],
  ["For this repo we use tabs, not spaces.", null, 0, 1],
  ["Stop explaining basics, I've been writing typescript for ten years.", null, 0, 1],
  ["btw my name is Ayush, call me that", null, 0, 1],
  ["We decided on Postgres over MySQL because of JSONB.", null, 0, 1],
  ["I'm vegetarian, keep that in mind for recipes.", null, 0, 1],
  ["Don't ask before running the tests, just run them.", null, 0, 1],
  ["I prefer metric units.", null, 0, 1],
  ["Our deploys go to Fly.io in Frankfurt.", null, 0, 1],
  ["going forward write commit messages in the imperative mood", null, 0, 1],
  ["No, I don't use semicolons. Never add them.", "Here is the function. I kept semicolons at the end of each statement, as is usual.", 0, 1],
  ["Too long. Bullet points only please, always.", "Here is the plan.\n\n1. First, we look at the data model, which has three parts and ...\n2. Then the API ...\n3. Finally ...", 0, 1],
  ["I told you, I use pnpm.", "Done. I installed it with npm install zod and updated the lockfile.", 1, 1],
  ["Always run the linter before you tell me it's done.", null, 0, 1],
  ["i hate it when you ask me three questions at once, ask one at a time", null, 0, 1],
  // The reply depends on something about the user or the past: recall.
  ["What did we decide about the checkout limit?", null, 1, 0],
  ["Plan my week the way I like.", null, 1, 0],
  ["Continue where we left off on the thesis.", null, 1, 0],
  ["When is Mira's birthday again?", null, 1, 0],
  ["Use my usual commit message style.", null, 1, 0],
  ["What's the name of the hotel I booked in Berlin?", null, 1, 0],
  ["Which database did I pick for the inventory service?", null, 1, 0],
  ["Draft the email like the last one I sent to my landlord.", null, 1, 0],
  ["Remind me what my deploy setup was.", null, 1, 0],
  ["Do it the same way as last time.", null, 1, 0],
  ["same format as yesterday's report pls", null, 1, 0],
  ["What was that library you recommended last week?", null, 1, 0],
  ["What do you know about me?", null, 1, 0],
  ["Pick a restaurant for tonight, you know what I like.", null, 1, 0],
  ["Why did we drop PayPal?", null, 1, 0],
  ["What's my name again?", null, 1, 0],
  // Neither.
  ["Fix the failing test in packages/store.", null, 0, 0],
  ["Run the tests.", null, 0, 0],
  ["Write a function that reverses a string in Python.", null, 0, 0],
  ["What's the capital of Australia?", null, 0, 0],
  ["Explain how cosine similarity works in a vector index.", null, 0, 0],
  ["Thanks, that worked!", "Done. The tests pass.", 0, 0],
  ["ok go ahead", "I can split the change in two commits: the schema first, then the API. Shall I?", 0, 0],
  ["Why is the sky blue?", null, 0, 0],
  ["Convert 30 degrees Celsius to Fahrenheit.", null, 0, 0],
  ["Rename the variable foo to bar in this file.", null, 0, 0],
  ["Show me the diff.", null, 0, 0],
  ["Can you make that button blue?", null, 0, 0],
  ["yes please", "Want me to also update the README?", 0, 0],
  ["What does this error mean: ECONNREFUSED 127.0.0.1:5432?", null, 0, 0],
  ["Summarize this file.", null, 0, 0],
  ["Translate 'good morning' into German.", null, 0, 0],
  ["Write a haiku about autumn.", null, 0, 0],
  ["How do I undo my last git commit?", null, 0, 0],
  ["Add a unit test for the parse function.", null, 0, 0],
  ["Looks good, merge it.", "The change is ready: three files, tests pass.", 0, 0],
  ["Refactor this component to use hooks.", null, 0, 0],
  ["What time is it in Tokyo?", null, 0, 0],
  ["Compare React and Vue for this project.", null, 0, 0],
  ["Let's start the next phase.", "Phase 1 is done and pushed. Phase 2 is the importer.", 0, 0],
  ["I'm in a hurry right now, keep it short.", null, 0, 0],
  ["For this one, skip the tests.", null, 0, 0],
  ["Use dark mode for this screenshot.", null, 0, 0],
  ["Why is the build failing?", "The build ran and failed on the lint step with 3 errors.", 0, 0],
  ["Give me three name ideas for the project.", null, 0, 0],
  ["How many tokens is that prompt?", null, 0, 0],
  ["Delete the temp folder.", null, 0, 0],
  ["lol nice", "Pushed the fix.", 0, 0],
];

const real = fileURLToPath(new URL("../../../.socrates/evals/decider-real.json", import.meta.url));
if (existsSync(real)) CASES.push(...(JSON.parse(readFileSync(real, "utf8")) as Case[]));

const decider = new OpenRouterDecider({ apiKey });
const rows: { message: string; previous: string | null; recall: number; save: number; wantRecall: number; wantSave: number; ms: number }[] = [];
let cost = 0, tokens = 0;
for (const [message, previous, wantRecall, wantSave] of CASES) {
  const t0 = performance.now();
  const answer = await decider.decide({ state: gateState({ message, previousAnswer: previous, attachments: [] }), questions: GATE_QUESTIONS });
  cost += answer.usage.costUsd ?? 0;
  tokens += answer.usage.inputTokens;
  rows.push({ message, previous, recall: answer.probabilities.recall!, save: answer.probabilities.save!, wantRecall, wantSave, ms: performance.now() - t0 });
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");
function score(question: "recall" | "save", at: number) {
  const want = (r: (typeof rows)[number]) => (question === "recall" ? r.wantRecall : r.wantSave);
  const p = (r: (typeof rows)[number]) => r[question];
  const positives = rows.filter((r) => want(r) === 1), negatives = rows.filter((r) => want(r) === 0);
  const found = positives.filter((r) => p(r) >= at).length, falsePositives = negatives.filter((r) => p(r) >= at).length;
  return { found, positives: positives.length, falsePositives, negatives: negatives.length, precision: found + falsePositives ? found / (found + falsePositives) : 1, recall: found / positives.length };
}

const times = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`${rows.length} messages (${rows.filter((r) => r.wantRecall).length} want a recall, ${rows.filter((r) => r.wantSave).length} want a save, ${rows.filter((r) => !r.wantRecall && !r.wantSave).length} neither); median ${Math.round(times[Math.floor(times.length / 2)]!)} ms, max ${Math.round(times.at(-1)!)} ms; ${tokens} input tokens, $${cost.toFixed(6)} in all ($${(cost / rows.length).toFixed(7)} a message).\n`);
for (const question of ["recall", "save"] as const) {
  console.log(`${question}: at or above  found   missed  wrongly asked   precision`);
  for (const at of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 0.95]) {
    const s = score(question, at);
    const shipped = (question === "recall" ? [RECALL_AT, RECALL_STRONG_AT] : [SAVE_AT]).includes(at) ? " ← shipped" : "";
    console.log(`  ${at.toFixed(2).padStart(13)}  ${pct(s.found, s.positives).padStart(6)}  ${String(s.positives - s.found).padStart(6)}  ${`${s.falsePositives}/${s.negatives}`.padStart(13)}  ${pct(s.found, s.found + s.falsePositives).padStart(9)}${shipped}`);
  }
  console.log();
}

const mistakes = rows.flatMap((r) => [
  ...((r.recall >= RECALL_AT) !== (r.wantRecall === 1) ? [`  recall ${r.recall.toFixed(2)} (wanted ${r.wantRecall ? "yes" : "no"}): "${r.message.slice(0, 80)}"`] : []),
  ...((r.save >= SAVE_AT) !== (r.wantSave === 1) ? [`  save   ${r.save.toFixed(2)} (wanted ${r.wantSave ? "yes" : "no"}): "${r.message.slice(0, 80)}"`] : []),
]);
console.log(mistakes.length ? `Disagreements at the shipped thresholds:\n${mistakes.join("\n")}\n` : "No disagreements at the shipped thresholds.\n");

// Measured 2026-10-10 (see docs/memory.md): the floors below leave room under what was measured.
const saves = score("save", SAVE_AT), recalls = score("recall", RECALL_AT);
assert.ok(saves.recall >= 0.85, `save: only ${pct(saves.found, saves.positives)} of the messages worth saving reach ${SAVE_AT}`);
assert.ok(saves.falsePositives / saves.negatives <= 0.2, `save: ${saves.falsePositives}/${saves.negatives} messages not worth saving reach ${SAVE_AT}`);
assert.ok(recalls.recall >= 0.8, `recall: only ${pct(recalls.found, recalls.positives)} of the messages needing a recall reach ${RECALL_AT}`);
assert.ok(recalls.falsePositives / recalls.negatives <= 0.15, `recall: ${recalls.falsePositives}/${recalls.negatives} messages not needing a recall reach ${RECALL_AT}`);
console.log("Passed.");
