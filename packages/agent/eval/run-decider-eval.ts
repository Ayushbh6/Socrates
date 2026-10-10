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
import { GATE_QUESTIONS, RECALL_AT, RECALL_STRONG_AT, SAVE_AT, WORK_AT, WORK_QUESTION, gateState, workState } from "../src";

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

// ── Finished turns: is the work worth writing down for the project? (docs/memory.md, M3b) ──
type Call = [tool: string, input: unknown, ok?: boolean];
/** [request, tool calls in order, answer, worth recording 0|1] */
type WorkCase = [string, Call[], string, 0 | 1];
const T = (command: string, ok = true): Call => ["terminal", { command }, ok];
const E = (path: string): Call => ["edit", { path }];
const R = (path: string): Call => ["read", { path }];
const WORK: WorkCase[] = [
  ["Add an archived_at column to the tasks table.", [R("packages/store/src/schema.ts"), E("packages/store/src/schema.ts"), E("packages/store/src/store.ts"), E("packages/store/test/store.test.ts"), T("pnpm typecheck"), T("pnpm test")], "Added archived_at: bumped SCHEMA_VERSION to 9, added an upgrade step to MIGRATIONS, rebuilt the index in replay, and an upgrade test from version 8. Typecheck and tests pass.", 1],
  ["Cut release 0.2.0.", [T("git status --short"), E("package.json"), E("CHANGELOG.md"), T("pnpm build"), T("pnpm test"), T("git tag v0.2.0")], "Released 0.2.0: version bumped in package.json, changelog entry written, build and tests pass, tagged v0.2.0. The order matters: tests run on the built output, so build first.", 1],
  ["CI fails on Windows paths in the loader tests.", [R("src/loader.ts"), E("src/loader.ts"), T("pnpm test", false), E("test/loader.test.ts"), T("pnpm test")], "Fixed. The loader joined paths with a template string, so backslashes broke the glob; it now uses path.posix for globs and path for files. The tests pass on both.", 1],
  ["Add a /api/reports route.", [R("apps/server/src/app.ts"), E("apps/server/src/app.ts"), E("apps/server/src/views.ts"), E("apps/server/test/reports.test.ts"), T("pnpm test"), E("architecture/server.md")], "Added GET /api/reports: the route in app.ts, its view in views.ts, a test, and the table in architecture/server.md. Every route here follows that four-file pattern. Tests pass.", 1],
  ["The generated client is out of date, regenerate it.", [T("pnpm codegen", false), E("openapi.yaml"), T("pnpm codegen"), T("pnpm typecheck"), E("src/client/index.ts")], "Regenerated. Codegen failed until the spec's operation ids were unique; after fixing them it ran and typecheck passes. Always run codegen before typecheck, since typecheck reads the generated files.", 1],
  ["The retry test is flaky, find out why.", [R("test/retry.test.ts"), T("pnpm vitest run test/retry.test.ts", false), E("test/retry.test.ts"), T("pnpm vitest run test/retry.test.ts --repeat 20")], "It slept for real and raced the 40 ms deadline. Switched it to fake timers; 20 runs in a row pass. Tests that wait on a clock should use fake timers here.", 1],
  ["Upgrade zod to v4.", [T("pnpm up zod@4"), E("src/schema.ts"), E("src/validate.ts"), T("pnpm typecheck", false), E("src/validate.ts"), T("pnpm typecheck"), T("pnpm test")], "Upgraded to zod 4. The breaking changes here were z.string().email() moving to z.email() and ZodError.errors becoming .issues; both fixed, typecheck and tests pass.", 1],
  ["Add a provider adapter for Mistral.", [R("packages/providers/src/openai.ts"), E("packages/providers/src/mistral.ts"), E("packages/providers/src/config.ts"), E("packages/providers/test/mistral.test.ts"), T("pnpm test"), E("architecture/agent-harness.md")], "Added the Mistral adapter by following the OpenAI-compatible one: the class, its entry in PROVIDER_DEFAULTS, a test with a local server, and a docs line. Tests pass.", 1],
  ["Set up a new live eval for the router.", [R("packages/router/eval/run-router-eval.ts"), E("packages/router/eval/run-compare.ts"), E("package.json"), T("SOCRATES_ENV_FILE=.env pnpm eval:compare"), E("docs/trial-log.md")], "Added the eval: the script, an eval:compare entry in package.json, and a trial-log entry. It needs SOCRATES_ENV_FILE=.env and prints a table; it passed.", 1],
  ["The docs build breaks after moving files.", [T("pnpm docs:build", false), E("docs/index.md"), E("docs/guide/setup.md"), T("pnpm docs:build")], "Fixed: the build resolves links relative to the sidebar config, so every moved page also needed its sidebar entry updated. The build passes now.", 1],
  ["Rename the variable foo to bar in utils.ts.", [["grep", { pattern: "foo", path: "src" }], R("src/utils.ts"), E("src/utils.ts"), E("src/index.ts")], "Renamed foo to bar in utils.ts and the one place it was imported.", 0],
  ["What does the router do?", [R("packages/router/src/router.ts"), R("architecture/Goal-router.md"), ["grep", { pattern: "route" }], R("packages/router/src/prompt.ts")], "The router decides which goal and task a message belongs to before the agent runs, using a short context and two tools.", 0],
  ["Fix the typo in the README.", [R("README.md"), E("README.md"), ["grep", { pattern: "teh" }]], "Fixed 'teh' to 'the' in the README.", 0],
  ["Fix the failing test in the importer.", [T("pnpm test", false), R("src/importer.ts"), E("src/importer.ts"), T("pnpm test", false), E("src/importer.ts"), T("pnpm test", false)], "I could not fix it. The test still fails on the empty-file case and I am not sure why. I tried two changes; neither worked. Tell me if you know of a fixture I should check.", 0],
  ["Show me what changed.", [T("git status"), T("git diff --stat"), T("git diff src/")], "Three files changed: schema.ts, store.ts and a test; the diff is above.", 0],
  ["Why is the build so slow?", [R("package.json"), ["grep", { pattern: "tsc" }], T("time pnpm build"), R("tsconfig.json")], "The build takes 41 s; the likely cause is that tsc checks every package on every run. I have not changed anything.", 0],
  ["Add a console.log to see what the parser gets.", [R("src/parser.ts"), E("src/parser.ts"), T("pnpm dev")], "Added a console.log of the input at the top of parse().", 0],
  ["Run the tests.", [T("pnpm test"), T("pnpm test --reporter=verbose"), T("pnpm typecheck")], "All 884 tests pass and typecheck is clean.", 0],
  ["Summarize the project structure.", [["glob", { pattern: "**/*.ts" }], R("package.json"), R("README.md"), ["glob", { pattern: "packages/*" }]], "A pnpm monorepo: packages for the store, router, agent and tools, and apps for the server and web.", 0],
  ["Make the primary button blue.", [R("src/styles.css"), E("src/styles.css"), E("src/Button.tsx"), T("pnpm build")], "The primary button is blue now: changed the --primary color in styles.css and the Button's class.", 0],
  ["Delete the temp folder.", [T("ls tmp"), T("rm -rf tmp"), T("ls")], "Deleted tmp/.", 0],
  ["Start migrating the importer to the new API.", [R("src/importer.ts"), E("src/importer.ts"), T("pnpm typecheck", false), E("src/importer.ts"), T("pnpm typecheck", false)], "I got the first half of the importer moved, but typecheck still fails in three places and I stopped there. Say if you want me to carry on.", 0],
  ["Add the two numbers and return the sum.", [E("src/sum.ts"), E("test/sum.test.ts"), T("pnpm test")], "Added sum(a, b) with a test; it passes.", 0],
  ["Change the default port to 4300.", [["grep", { pattern: "4200" }], E("src/config.ts"), E("README.md"), T("pnpm test")], "Changed the default port to 4300 in config.ts and the README. Tests pass.", 0],
];
const evidence = (calls: Call[]) => calls.map(([tool, input, ok = true], i) => ({ taskId: "t", number: i + 1, handle: `e${i + 1}`, callId: `c${i}`, tool, turnId: "x", input, status: ok ? ("ok" as const) : ("error" as const), result: null, createdAt: "" }));
const workRows: { request: string; p: number; want: number; ms: number }[] = [];
for (const [request, calls, answer, want] of WORK) {
  const t0 = performance.now();
  const reply = await decider.decide({ state: workState({ request, calls: evidence(calls), answer }), questions: { work: WORK_QUESTION } });
  cost += reply.usage.costUsd ?? 0;
  workRows.push({ request, p: reply.probabilities.work!, want, ms: performance.now() - t0 });
}
const workScore = (at: number) => {
  const positives = workRows.filter((r) => r.want === 1), negatives = workRows.filter((r) => r.want === 0);
  const found = positives.filter((r) => r.p >= at).length, wrong = negatives.filter((r) => r.p >= at).length;
  return { found, positives: positives.length, wrong, negatives: negatives.length };
};
console.log(`work: ${workRows.length} finished turns (${workRows.filter((r) => r.want).length} worth recording); at or above  found  wrongly asked`);
for (const at of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85]) {
  const w = workScore(at);
  console.log(`  ${at.toFixed(2).padStart(13)}  ${pct(w.found, w.positives).padStart(6)}  ${`${w.wrong}/${w.negatives}`.padStart(13)}${at === WORK_AT ? " ← shipped" : ""}`);
}
const workMistakes = workRows.filter((r) => (r.p >= WORK_AT) !== (r.want === 1)).map((r) => `  work ${r.p.toFixed(2)} (wanted ${r.want ? "yes" : "no"}): "${r.request.slice(0, 70)}"`);
console.log(workMistakes.length ? `\nDisagreements at the shipped threshold:\n${workMistakes.join("\n")}\n` : "\nNo disagreements at the shipped threshold.\n");

// Measured 2026-10-10 (see docs/memory.md): the floors below leave room under what was measured.
const saves = score("save", SAVE_AT), recalls = score("recall", RECALL_AT);
assert.ok(saves.recall >= 0.85, `save: only ${pct(saves.found, saves.positives)} of the messages worth saving reach ${SAVE_AT}`);
assert.ok(saves.falsePositives / saves.negatives <= 0.2, `save: ${saves.falsePositives}/${saves.negatives} messages not worth saving reach ${SAVE_AT}`);
assert.ok(recalls.recall >= 0.8, `recall: only ${pct(recalls.found, recalls.positives)} of the messages needing a recall reach ${RECALL_AT}`);
assert.ok(recalls.falsePositives / recalls.negatives <= 0.15, `recall: ${recalls.falsePositives}/${recalls.negatives} messages not needing a recall reach ${RECALL_AT}`);
const works = workScore(WORK_AT);
assert.ok(works.found / works.positives >= 0.8, `work: only ${pct(works.found, works.positives)} of the turns worth recording reach ${WORK_AT}`);
assert.ok(works.wrong / works.negatives <= 0.2, `work: ${works.wrong}/${works.negatives} turns not worth recording reach ${WORK_AT}`);
console.log("Passed.");
