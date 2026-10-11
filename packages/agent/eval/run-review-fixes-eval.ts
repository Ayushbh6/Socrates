/** Live, synthetic closure for the six T1/M4a review findings. Copies no user
 * history. Provider settings can be supplied from a disposable settings copy.
 * The terminal secret is generated only when executed, never stored in source.
 * Assertions require saved-output reads and cursor use, not merely a right answer.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Effort, ModelClient } from "@socrates/contracts";
import { makeDecider, makeEmbedder, makeModel } from "@socrates/providers";
import { Retrieval } from "@socrates/retrieval";
import { LedgerStore } from "@socrates/store";
import { OutputArchive, TerminalManager } from "@socrates/tools";
import { loadEvaluationEnvironment } from "../../router/eval/environment";
import { MemoryGate, Socrates, resolveWorkProject } from "../src";

loadEvaluationEnvironment();
const settings = process.env.SOCRATES_SETTINGS_FILE ? JSON.parse(readFileSync(process.env.SOCRATES_SETTINGS_FILE, "utf8")) : {};
const chat = settings.chat ?? { provider: "deepseek", model: "deepseek-flash", effort: "high" };
assert.equal(chat.provider, "deepseek");
assert.match(chat.model, /flash/);
const router = settings.router ?? { provider: "openrouter", model: "openai/gpt-6-luna" };
const usage = { calls: 0, input: 0, cached: 0 };
const served = new Set<string>();
function model(choice: { provider: string; model: string }, effort: Effort): ModelClient {
  const inner = makeModel(choice.provider, choice.model);
  return { id: inner.id, async complete(request) {
    const response = await inner.complete({ ...request, effort });
    usage.calls++; usage.input += response.usage.promptTokens; usage.cached += response.usage.cacheReadTokens;
    if (response.servedBy) served.add(response.servedBy);
    return response;
  } };
}
const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, "review-fixes-")));
const provider = model(chat, chat.effort ?? "high");
const routerModel = model(router, "off");

async function run(kind: "terminal" | "memory") {
  const root = path.join(dir, kind); mkdirSync(root);
  const store = LedgerStore.open({ path: path.join(dir, `${kind}.db`) });
  const archive = new OutputArchive(path.join(dir, `${kind}-outputs`));
  const terminals = new TerminalManager({ archive });
  const goal = store.createGoal({ title: "Synthetic review fixture" });
  store.bindGoalWorkspace(goal.id, store.createWorkspace("fixture", root).id);
  const task = store.createTask(goal.id, { title: `${kind} verification` });
  const e = settings.embeddings ?? {};
  const retrieval = kind === "memory" ? await Retrieval.open({ store, uri: path.join(dir, "index"), workspaceFiles: false,
    embedder: makeEmbedder({ ...process.env, SOCRATES_EMBEDDINGS_PROVIDER: e.provider ?? "ollama", SOCRATES_EMBEDDINGS_MODEL: e.model ?? undefined, SOCRATES_EMBEDDINGS_URL: e.url ?? undefined }) }) : undefined;
  const decider = makeDecider();
  if (kind === "memory") assert(decider, "Real memory decider required");
  const socrates = new Socrates({ store, model: provider, routerModel, semantic: retrieval, terminalManager: terminals,
    timeZone: settings.timeZone ?? "Europe/Vienna", workMemoryDir: path.join(dir, "memory", "projects"),
    access: () => ({ folders: [root], approvals: "auto", protected: [] }), approve: async () => false,
    memory: () => ({ use: true, save: kind === "memory" }), gate: () => decider ? new MemoryGate({ decider }) : null,
  });
  try {
    if (kind === "terminal") {
      writeFileSync(path.join(root, "emit.cjs"), `const {randomBytes}=require('node:crypto'); process.stdout.write('x'.repeat(4*1024*1024)+' SEAL='+randomBytes(10).toString('hex')+' '+'x'.repeat(100000)+'\\nEND\\n');`);
      const result = await socrates.handle("Run node emit.cjs exactly once. Report the exact SEAL value in its output. Find it in the saved output with terminal_control read search. Also read from_line 1 and continue with its next_cursor once to check long-line pagination. Do not rerun the command or redirect output. Do not change files.", { target: { taskId: task.id } });
      assert.equal(result.kind, "answered");
      const evidence = store.evidenceForTurn(store.turnsForTask(task.id).at(-1)!.id);
      const commands = evidence.filter((e) => e.tool === "terminal");
      assert.equal(commands.length, 1, "Must execute exactly one command, without reruns");
      const output = commands[0]!.result!.result as { output_id: string; output: string };
      const raw = archive.text(output.output_id, 5 * 1024 * 1024).text;
      const seal = raw.match(/SEAL=([a-f0-9]{20})/)![1]!;
      assert(!output.output.includes(seal), "Secret must be absent from the initial preview");
      assert(result.kind === "answered" && result.text.includes(seal), "Answer must reproduce the runtime-only secret");
      const reads = evidence.filter((e) => e.tool === "terminal_control" && (e.input as { output?: string }).output === output.output_id);
      assert(reads.some((e) => (e.input as { search?: string }).search), "Must search the saved output");
      assert(reads.some((e) => (e.input as { cursor?: string }).cursor?.startsWith(output.output_id)), "Must resume with a saved-output cursor");
      assert(!evidence.some((e) => ["edit", "apply_patch"].includes(e.tool)), "Read-only task must not modify files");
      console.log(`PASS terminal: secret recovered from 4+ MiB line; one command, ${reads.length} archive reads including cursor continuation`);
    } else {
      writeFileSync(path.join(root, "CONTRIBUTING.md"), "Add string utilities in helpers.mjs, export each function, add cases to helpers.test.mjs, run node --test helpers.test.mjs. Never add dependencies.\n");
      writeFileSync(path.join(root, "helpers.mjs"), "export const trim = s => s.trim();\n");
      writeFileSync(path.join(root, "helpers.test.mjs"), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {trim} from './helpers.mjs'; test('trim',()=>assert.equal(trim(' a '),'a'));\n");
      await retrieval!.idle();
      const first = await socrates.handle("Follow CONTRIBUTING.md to add slugify (lowercase words joined with dashes) and verify it with tests. This same procedure will be needed for more string utilities later.", { target: { taskId: task.id } });
      assert.equal(first.kind, "answered");
      await socrates.workMemoryIdle(); await retrieval!.idle();
      const project = resolveWorkProject(root)!;
      const topics = store.listWorkTopics(project.id);
      assert(topics.length > 0 && store.workMemoryIndex(project.id), "Real decider and writer must create indexed project notes");
      assert(!existsSync(path.join(root, ".socrates")) && !existsSync(path.join(root, "MEMORY.md")), "No repository notes");
      const sourceIds = topics.map(t => `${project.id}/${t.name}`);
      const found = await retrieval!.search(topics[0]!.text, { kinds: ["work_topic"], sourceIds, limit: 20 });
      assert(found.some(h => sourceIds.includes(h.sourceId)), "Background writes must reach semantic index without another foreground turn");
      for (let i = 0; i < 30; i++) store.recordWorkMemoryWrite({}, { project_id: `other-${i}`, root: `/synthetic-${i}`, target: "topic", name: "decoy", text: "How to introduce reusable string utilities: use the wrong project's library." });
      retrieval!.scheduleSync(); await retrieval!.idle();
      const fresh = store.createTask(goal.id, { title: "Recall procedure in a new chat" });
      const second = await socrates.handle("Before doing any work, search project memory for how to introduce reusable string utilities, open the matching topic, and tell me the verified procedure. Do not run commands or change files.", { target: { taskId: fresh.id } });
      assert.equal(second.kind, "answered");
      const evidence = store.evidenceForTurn(store.turnsForTask(fresh.id).at(-1)!.id);
      const search = evidence.find(e => e.tool === "context_retrieve" && (e.input as { action?: string }).action === "memory");
      assert(search, "Fresh chat must search memory");
      const recalled = JSON.parse(search.result!.content).project_topics as { ref: string }[];
      assert(recalled?.some(t => topics.some(local => t.ref === `topic:${local.name}`)), "Search must find this project's topic despite 30 competing projects");
      assert(evidence.some(e => e.tool === "context_retrieve" && (e.input as { ref?: string }).ref?.startsWith("topic:")), "Fresh chat must open the topic, not just see the index");
      assert(!evidence.some(e => ["terminal", "edit", "apply_patch"].includes(e.tool)));
      console.log(`PASS memory: ${topics.length} managed topic(s), automatic semantic sync, fresh-chat search and topic inspection with 30 competing projects`);
    }
  } finally {
    await socrates.close(); await terminals.close(); await retrieval?.close(); store.close();
  }
}

try {
  console.log(`Isolated live review checks: ${provider.id}, effort ${chat.effort ?? "high"}; router ${routerModel.id}; synthetic fixtures only`);
  await run("terminal");
  await run("memory");
  console.log(`Provider-reported models: ${[...served].join(", ") || "not reported"}. Calls: ${usage.calls}; prompt tokens: ${usage.input}; cached: ${usage.cached}.`);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
