/**
 * Live prompt-cache evaluation (architecture/observability.md, "Evaluating
 * the cache"): a real model works through three connected messages on a small
 * fixture project, every call is recorded, and the report says how much of
 * each prompt the provider served from its cache, how fast it answered and
 * what it cost. It fails when the working agent's later steps, whose
 * prompts repeat everything before them, do not hit the cache.
 *
 *   SOCRATES_PROVIDER=deepseek SOCRATES_ENV_FILE=.env pnpm eval:cache
 *   CACHE_MIN_WARM=0.7  the lowest cache hit rate accepted for later steps (default 0.6)
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelClient } from "@socrates/contracts";
import { PROVIDER_DEFAULTS, makeModel, type Provider } from "@socrates/providers";
import type { CallRow } from "@socrates/store";
import { loadEvaluationEnvironment } from "../../../packages/router/eval/environment";
import { Runtime, resolveConfig } from "../src";

loadEvaluationEnvironment();
const provider = process.env.SOCRATES_PROVIDER ?? "deepseek";
const defaults = PROVIDER_DEFAULTS[provider as Provider];
if (!defaults) throw new Error("Unknown evaluation provider.");
if (!defaults.keys.some((name) => process.env[name])) throw new Error(`Set ${defaults.keys.join(" or ")} or SOCRATES_ENV_FILE for the cache evaluation.`);
const chat = process.env.SOCRATES_MAIN_MODEL ?? defaults.main;
const router = process.env.SOCRATES_ROUTER_MODEL ?? defaults.router;
const minWarm = Number(process.env.CACHE_MIN_WARM ?? "0.6");

const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, `cache-${provider}-`)));
const fixture = path.join(dir, "fixture");
mkdirSync(fixture);
const filler = (topic: string) => Array.from({ length: 14 }, (_, i) => `${topic} note ${i + 1}: this paragraph records an ordinary detail about ${topic} so the file has some length. It says nothing about the vault.`).join("\n");
writeFileSync(path.join(fixture, "overview.md"), `# Overview\n\n${filler("the overview")}\n`);
writeFileSync(path.join(fixture, "schedule.md"), `# Schedule\n\n${filler("the schedule")}\n\nThe shipment retries 4 times before it is parked.\n`);
writeFileSync(path.join(fixture, "vault.md"), `# Vault\n\nThe vault opens with the verification code ORBIT-6382.\n\n${filler("the vault door")}\n`);
writeFileSync(path.join(fixture, "people.md"), `# People\n\n${filler("the staff")}\n${filler("the visitors")}\n`);
writeFileSync(path.join(fixture, "config.json"), JSON.stringify({ retries: 7, region: "north", verbose: false }, null, 2));

let modelCalls = 0;
const runtime = await Runtime.open(resolveConfig({ SOCRATES_HOME: path.join(dir, "home"), SOCRATES_PORT: "4277" }), {
  makeModel: (p, model, env, options): ModelClient => {
    const client = makeModel(p, model, env, options);
    return { id: client.id, ...(client.vision !== undefined ? { vision: client.vision } : {}), complete: async (request) => { modelCalls++; return client.complete(request); } };
  },
});

const rows: { message: number; call: CallRow }[] = [];
try {
  assert(runtime.calls, "The call log did not open.");
  const workspace = runtime.store.createWorkspace("cache-fixture", fixture);
  await runtime.updateSettings({ chat: { provider, model: chat }, router: { provider, model: router }, workingFolder: workspace.id, access: { scope: "folders", folders: [fixture], approvals: "auto" } });
  assert(runtime.socrates, `Socrates did not start: ${runtime.setup.join(" ")}`);

  const messages = [
    "Read every .md file in the working folder (one read per file), then tell me which file gives the vault verification code and what the code is. Do not change any files.",
    "Which of those four files is the longest? Answer from what you already read; do not read anything again.",
    "Now read config.json and tell me the value of retries, and say whether it matches the retry count in schedule.md. Do not change any files.",
  ];
  const send = (text: string) => runtime.socrates!.handle(text, { signal: AbortSignal.timeout(300_000), onDraft: () => {} });
  for (const [i, text] of messages.entries()) {
    const started = performance.now();
    const since = new Date().toISOString();
    let result = await send(text);
    // A first message to a fresh install may be answered with a question; answer it and go on.
    for (let asks = 0; result.kind === "clarify" && asks < 2; asks++) {
      console.log(`  the router asked: ${result.text}`);
      result = await send("Use the working folder you were given; it is the only project.");
    }
    assert.equal(result.kind, "answered", `Message ${i + 1} was not answered.`);
    await runtime.flushCalls();
    // Drafts make the working agent's requests streamed, as the app's are, so first-token times are measured.
    for (const call of runtime.calls.list({ since, limit: 500 }).reverse()) if (call.role !== "embedding") rows.push({ message: i + 1, call });
    console.log(`message ${i + 1} answered in ${((performance.now() - started) / 1000).toFixed(1)}s: ${result.text.replace(/\s+/g, " ").slice(0, 140)}`);
  }

  // Every model call was recorded: those made, and the embedding probes.
  const recorded = runtime.calls.list({ limit: 1000 }).filter((c) => c.role !== "embedding").length;
  assert.equal(recorded, modelCalls, `${modelCalls} model calls were made but ${recorded} were recorded.`);
  assert(rows.every(({ call }) => call.ok), "A model call failed.");

  const pct = (n: number | null) => (n === null ? "  –  " : `${(n * 100).toFixed(0).padStart(3)}%`);
  console.log("\n msg role     step  prompt  cached  hit    out   ttft(ms)  tok/s   cost($)");
  for (const { message, call: c } of rows) {
    const hit = c.promptTokens ? c.cacheReadTokens / c.promptTokens : null;
    console.log(` ${message}   ${c.role.padEnd(8)} ${String(c.step ?? "").padStart(3)}  ${String(c.promptTokens).padStart(6)}  ${String(c.cacheReadTokens).padStart(6)}  ${pct(hit)}  ${String(c.outputTokens).padStart(5)}  ${String(c.firstTokenMs ?? "–").padStart(8)}  ${String(c.tokensPerSecond ?? "–").padStart(6)}  ${c.costUsd === null ? "   –" : c.costUsd.toFixed(6)}`);
  }

  const sum = (set: CallRow[]) => {
    const prompt = set.reduce((n, c) => n + c.promptTokens, 0);
    return { calls: set.length, prompt, cached: set.reduce((n, c) => n + c.cacheReadTokens, 0), rate: prompt ? set.reduce((n, c) => n + c.cacheReadTokens, 0) / prompt : null };
  };
  const work = rows.map((r) => r.call).filter((c) => c.role === "work");
  const first = work.filter((c) => c.step === 1);
  const later = work.filter((c) => (c.step ?? 1) > 1);
  const routing = rows.map((r) => r.call).filter((c) => c.role === "router");
  const all = sum(rows.map((r) => r.call));
  console.log(`\nworking agent, first step of a message: ${pct(sum(first).rate)} cached (${first.length} calls)`);
  console.log(`working agent, later steps:             ${pct(sum(later).rate)} cached (${later.length} calls)`);
  console.log(`router:                                 ${pct(sum(routing).rate)} cached (${routing.length} calls)`);
  console.log(`everything:                             ${pct(all.rate)} cached, ${all.prompt} prompt tokens, $${rows.reduce((n, r) => n + (r.call.costUsd ?? 0), 0).toFixed(6)} (${rows.filter((r) => r.call.costUsd !== null).length}/${rows.length} calls priced)`);

  assert(later.length > 0, "The task never took a second step, so the cache could not be measured.");
  const warm = sum(later).rate ?? 0;
  assert(warm >= minWarm, `Later steps hit the cache ${(warm * 100).toFixed(0)}% of the time, below the ${(minWarm * 100).toFixed(0)}% accepted (CACHE_MIN_WARM).`);
  console.log(`\nPASS: later steps hit the cache ${(warm * 100).toFixed(0)}% (accepted: ${(minWarm * 100).toFixed(0)}%)`);
  writeFileSync(path.join(dir, "report.json"), JSON.stringify(rows, null, 2));
} finally {
  await runtime.close();
  if (!process.env.KEEP_EVAL) rmSync(dir, { recursive: true, force: true });
  else console.log(`kept ${dir}`);
}
