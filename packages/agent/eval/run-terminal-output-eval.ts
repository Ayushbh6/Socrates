/** Live check of saved terminal output (docs/terminal-output-and-memory.md, T1):
 * the working agent runs commands whose output is far longer than its
 * preview, with the one thing that matters in the middle, and must find it
 * through the saved output. Each task runs once at the old preview (about
 * 9,500 tokens) and once at the new default (4,500), each in a fresh ledger
 * and project, so the two can be compared: right answers, extra reads, tokens.
 * Only synthetic fixture content reaches the provider; the folder is deleted. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelClient } from "@socrates/contracts";
import { makeModel } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import { OutputArchive, TerminalManager } from "@socrates/tools";
import { loadEvaluationEnvironment } from "../../router/eval/environment";
import { Socrates } from "../src";

loadEvaluationEnvironment();
const provider = process.env.SOCRATES_PROVIDER ?? "deepseek";
const modelName = process.env.SOCRATES_MAIN_MODEL ?? "deepseek-flash";
const effort = (process.env.SOCRATES_EFFORT ?? "high") as "high";
const PREVIEWS = (process.env.SOCRATES_PREVIEWS ?? "9500,4500").split(",").map(Number);

const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, "terminal-output-")));

/**
 * A Node script printing `lines` lines, with `marker` at line `at`. The marker
 * is stored encoded, so reading the script does not give the answer away: it
 * has to come from the output.
 */
const printer = (lines: number, at: number, filler: string, marker: string) =>
  `const hidden = Buffer.from(${JSON.stringify(Buffer.from(marker).toString("base64"))}, "base64").toString();\nfor (let i = 1; i <= ${lines}; i++) console.log(i === ${at} ? hidden : ${filler});\n`;
const RUNS = Number(process.env.SOCRATES_RUNS ?? 1);

const TASKS = [
  {
    name: "failing test in a long test log",
    files: { "test.js": `${printer(20_000, 11_437, "`  ✓ suite ${Math.ceil(i / 40)} › case ${i} passes (${i % 7 + 1} ms)`", "  ✗ parseInvoice › handles negative totals: expected -12.50, received 12.50 (src/invoice.js:42)")}console.log("Tests: 1 failed, 19999 passed"); process.exitCode = 1;\n` },
    ask: "In my invoices project, run `node test.js` and tell me exactly which test fails, what it expected and where. Don't change anything.",
    right: (a: string) => /negative totals/i.test(a) && /invoice\.js:?42|line 42/i.test(a) && /-12\.50/.test(a),
  },
  {
    name: "warning in the middle of a build log",
    files: { "build.js": `${printer(15_000, 7_812, "`[build] emitted chunk-${i}.js (${(i * 37) % 900 + 100} kB)`", "WARNING: build.config.js line 17 uses deprecated key optimization.legacyChunks; it will be removed in the next major version")}console.log("Build finished in 41.2 s");\n` },
    ask: "In my storefront project, run the build with `node build.js` and tell me whether anything in its output needs my attention. Don't change anything.",
    right: (a: string) => /legacyChunks/i.test(a) && /17/.test(a),
  },
  {
    name: "one entry in a long changelog",
    files: { "changelog.js": printer(8_000, 3_301, "`commit ${(i * 2654435761 % 4294967296).toString(16).padStart(8, '0')}  ${['alice', 'bob', 'chen', 'dara'][i % 4]}  tweak module ${i % 97}`", "commit 7c1e9a42  priya  rate limiter: raise the public API limit to 120 requests per minute") },
    ask: "In my api project, `node changelog.js` prints the change history. Which commit raised the rate limit to 120 requests per minute, and who made it?",
    right: (a: string) => /7c1e9a42/i.test(a) && /priya/i.test(a),
  },
];

const effortful = (model: ModelClient): ModelClient => ({ id: model.id, complete: (request) => model.complete({ ...request, effort }) });

interface Row { task: string; preview: number; right: boolean; reads: number; calls: number; tools: string[]; promptTokens: number; cachedTokens: number; outputTokens: number; seconds: number; answer: string }

async function once(task: (typeof TASKS)[number], preview: number): Promise<Row> {
  const run = realpathSync(mkdtempSync(path.join(dir, "run-")));
  const project = path.join(run, "project");
  mkdirSync(project);
  for (const [name, text] of Object.entries(task.files)) writeFileSync(path.join(project, name), text);
  const store = LedgerStore.open({ path: path.join(run, "ledger.db") });
  const archive = new OutputArchive(path.join(run, "artifacts", "terminal"));
  const terminalManager = new TerminalManager({ archive, previewTokens: () => preview });
  const usage = { promptTokens: 0, cachedTokens: 0, outputTokens: 0 };
  const inner = effortful(makeModel(provider, modelName));
  const model: ModelClient = {
    id: inner.id,
    async complete(request) {
      const response = await inner.complete(request);
      usage.promptTokens += response.usage.promptTokens;
      usage.cachedTokens += response.usage.cacheReadTokens;
      usage.outputTokens += response.usage.outputTokens;
      return response;
    },
  };
  const socrates = new Socrates({
    store, model, routerModel: model, timeZone: "Europe/Vienna", approve: async () => true, terminalManager,
    resolveWorkspace: () => ({ name: "project", rootPath: project }),
    log: (m) => console.error(`[diagnostic] ${m}`),
  });
  const started = Date.now();
  try {
    const result = await socrates.handle(task.ask);
    const answer = result.kind === "answered" ? result.text : `(${result.kind}) ${"text" in result ? result.text : ""}`;
    const turnIds = result.kind === "answered" ? result.parts.map((p) => p.turn.id) : [];
    const evidence = turnIds.flatMap((id) => store.evidenceForTurn(id));
    const reads = evidence.filter((e) => e.tool === "terminal_control" && (e.input as { action?: string; output?: string }).action === "read" && !!(e.input as { output?: string }).output).length;
    const tools = evidence.map((e) => `${e.tool} ${JSON.stringify(e.input).slice(0, 140)}`);
    return { task: task.name, preview, right: task.right(answer), reads, calls: evidence.length, tools, ...usage, seconds: Math.round((Date.now() - started) / 1000), answer };
  } finally {
    await socrates.close();
    await terminalManager.close();
    store.close();
  }
}

async function main() {
  console.log(`Saved terminal output, live: ${provider}:${modelName} (${effort}); previews ${PREVIEWS.join(" and ")} tokens; ${RUNS} run(s) of each\n`);
  const rows: Row[] = [];
  for (let n = 0; n < RUNS; n++) for (const task of TASKS) {
    for (const preview of PREVIEWS) {
      const row = await once(task, preview);
      rows.push(row);
      console.log(`${row.right ? "PASS" : "FAIL"} ${row.task} @ ${row.preview}: ${row.reads} read(s) of saved output, ${row.calls} tool calls, ${row.promptTokens} prompt tokens (${row.cachedTokens} cached), ${row.outputTokens} out, ${row.seconds}s`);
      for (const line of row.tools) console.log(`  · ${line}`);
      if (!row.right) console.log(`  answer: ${row.answer.slice(0, 600)}`);
    }
  }
  console.log("\n| Task | Preview | Right | Reads | Tool calls | Prompt tokens | Cached | Output |\n|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.task} | ${r.preview} | ${r.right ? "yes" : "no"} | ${r.reads} | ${r.calls} | ${r.promptTokens} | ${r.cachedTokens} | ${r.outputTokens} |`);
  for (const preview of PREVIEWS) {
    const of = rows.filter((r) => r.preview === preview);
    console.log(`\n${preview}: ${of.filter((r) => r.right).length}/${of.length} right, ${of.reduce((n, r) => n + r.reads, 0)} reads, ${of.reduce((n, r) => n + r.promptTokens, 0)} prompt tokens (${of.reduce((n, r) => n + r.cachedTokens, 0)} cached)`);
  }
  if (rows.some((r) => !r.right)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => rmSync(dir, { recursive: true, force: true }));

