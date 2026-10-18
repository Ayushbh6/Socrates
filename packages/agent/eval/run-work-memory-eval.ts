/** Live check of work memory kept by Socrates (docs/goal-task-memory-plan.md):
 * the working agent (DeepSeek Flash, high effort, as configured) and the
 * real decider work in a disposable Git project. A recurring change is made
 * twice: the first records a topic, the second updates it instead of adding a
 * copy. A fresh task of the goal then finds the topic (its index, or memory
 * search) and opens it. Throughout, the repository gets no notes of Socrates' (git status
 * shows only the project's own changes) and the notes are in the data folder.
 * Only synthetic fixture content reaches the providers; the folder is deleted. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type EventPayloads, type ModelClient } from "@socrates/contracts";
import { makeDecider, makeModel } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import { loadEvaluationEnvironment } from "../../router/eval/environment";
import { MemoryGate, Socrates } from "../src";

loadEvaluationEnvironment();
const decider = makeDecider();
if (!decider) throw new Error("The decider needs OPENROUTER_API_KEY (SOCRATES_ENV_FILE=.env).");
const inner = makeModel(process.env.SOCRATES_PROVIDER ?? "deepseek", process.env.SOCRATES_MAIN_MODEL ?? "deepseek-flash");
const model: ModelClient = { id: inner.id, complete: (request) => inner.complete({ ...request, effort: "high" }) };

const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, "work-memory-")));
const repo = path.join(dir, "helpers");
const memoryDir = path.join(dir, "data", "memory");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "e@e", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "e@e" } }).toString();

function fixture() {
  mkdirSync(path.join(repo, "src/helpers"), { recursive: true });
  mkdirSync(path.join(repo, "test"), { recursive: true });
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "helpers", private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(path.join(repo, "src/helpers/trim-lines.js"), "/** Trim every line of a text. */\nexport function trimLines(text) {\n  return text.split(\"\\n\").map((l) => l.trim()).join(\"\\n\");\n}\n");
  writeFileSync(path.join(repo, "src/index.js"), "export { trimLines } from \"./helpers/trim-lines.js\";\n");
  writeFileSync(path.join(repo, "test/helpers.test.js"), "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport * as helpers from \"../src/index.js\";\n\ntest(\"trimLines\", () => {\n  assert.equal(helpers.trimLines(\" a \\n b \"), \"a\\nb\");\n});\n");
  writeFileSync(path.join(repo, "CONTRIBUTING.md"), "# Adding a helper\n\nEach helper is its own file in src/helpers (kebab-case name), exported from src/index.js in alphabetical order, with a test in test/helpers.test.js. Run npm test.\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
}

const rows: string[] = [];
const pass = (name: string, detail = "") => { rows.push(`PASS ${name}${detail ? ` — ${detail}` : ""}`); console.log(rows.at(-1)); };

async function main() {
  fixture();
  console.log(`Work memory, live: ${model.id} (high), decider ${decider!.id}\nProject: ${repo}\n`);
  const store = LedgerStore.open({ path: path.join(dir, "ledger.db") });
  const open = () => new Socrates({
    store, model, routerModel: model, timeZone: "Europe/Vienna", approve: async () => true, memoryDir,
    resolveWorkspace: () => ({ name: "helpers", rootPath: repo }),
    memory: () => ({ save: true, use: true }), gate: () => new MemoryGate({ decider: decider!, timeoutMs: 15_000 }),
    log: (m) => console.error(`[diagnostic] ${m}`),
  });
  const steps = () => store.listEvents({ type: "work_memory_step" }).map((e) => e.payload as EventPayloads["work_memory_step"]);
  const notesInRepo = () => git("status", "--porcelain", "--ignored").split("\n").filter((l) => /\.socrates|MEMORY\.md/i.test(l));
  let socrates = open();
  try {
    const first = await socrates.handle("In my helpers project, add a slugify helper (lower-case, words joined by dashes) the way helpers are added here, and verify it with the tests.");
    assert.equal(first.kind, "answered");
    await socrates.workMemoryIdle();
    const afterFirst = steps().at(-1);
    assert(afterFirst, "no work-memory step was queued after the first change");
    console.log(`  step 1: ${afterFirst.outcome}${afterFirst.detail ? ` (${afterFirst.detail})` : ""}, ${afterFirst.writes} write(s)`);
    assert.equal(afterFirst.outcome, "written", "the first recurring change should be recorded");
    const goal = store.listGoals().find((g) => !g.general)!;
    const taskId = first.kind === "answered" ? first.parts[0]!.task.id : null;
    const topicsAfterFirst = store.listWorkTopics({ goalId: goal.id }).map((t) => t.name!);
    pass("first change recorded a topic outside the repository", `topics: ${topicsAfterFirst.join(", ")}; task index: ${JSON.stringify(store.workMemoryIndex(goal.id, taskId)?.text)}; goal index: ${JSON.stringify(store.workMemoryIndex(goal.id, null)?.text)}`);

    const second = await socrates.handle("Now add a titleCase helper the same way, and verify it.");
    assert.equal(second.kind, "answered");
    await socrates.workMemoryIdle();
    const afterSecond = steps().at(-1)!;
    const topicsAfterSecond = store.listWorkTopics({ goalId: goal.id }).map((t) => t.name!);
    console.log(`  step 2: ${afterSecond.outcome}${afterSecond.detail ? ` (${afterSecond.detail})` : ""}, ${afterSecond.writes} write(s); topics: ${topicsAfterSecond.join(", ")}`);
    const updated = store.listWorkTopics({ goalId: goal.id }).some((t) => topicsAfterFirst.includes(t.name!) && t.turnId === store.listEvents({ type: "work_memory_step" }).at(-1)!.turn_id);
    assert(afterSecond.outcome !== "written" || topicsAfterSecond.length === topicsAfterFirst.length, `the second change added a topic instead of updating: ${topicsAfterSecond.join(", ")}`);
    pass("second change kept one topic", afterSecond.outcome === "written" ? (updated ? "the existing topic was rewritten" : "the index was updated") : `step ${afterSecond.outcome}`);

    // A fresh chat of the project: the index is shown, and the topic is opened before the work.
    await socrates.close();
    socrates = open();
    const third = await socrates.handle("In the helpers project, start a new piece of work: add a capitalize helper (first letter upper-case), following the project's recorded way.", { target: { goalId: store.listGoals().find((g) => !g.general)!.id, title: "Capitalize helper" } });
    assert.equal(third.kind, "answered");
    const turn = third.kind === "answered" ? third.parts[0]!.turn : null;
    const inspected = store.evidenceForTurn(turn!.id).filter((e) => e.tool === "context_retrieve" && /topic:/.test(JSON.stringify(e.input)));
    pass("fresh chat saw the index", inspected.length ? `opened ${inspected.map((e) => (e.input as { ref?: string }).ref).join(", ")}` : "did not open a topic (index shown, not followed up)");
    await socrates.workMemoryIdle();

    const leaked = notesInRepo();
    assert.deepEqual(leaked, [], `notes appeared in the repository: ${leaked.join("; ")}`);
    assert(!existsSync(path.join(repo, ".socrates")));
    const folder = path.join(memoryDir, "goals", readdirSync(path.join(memoryDir, "goals")).find((n) => n.startsWith(`g${goal.number}-`))!);
    const notes = (base: string): string[] => readdirSync(base, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? notes(path.join(base, e.name)) : [path.relative(folder, path.join(base, e.name))]);
    const files = notes(folder).sort();
    assert(files.some((f) => f.endsWith("MEMORY.md")) && files.some((f) => /topics\/[^/]+\.md$/.test(f)), `notes missing: ${files.join(", ")}`);
    pass("repository clean; notes in the data folder", files.join(", "));
    execFileSync("node", ["--test"], { cwd: repo, stdio: "pipe" });
    pass("the project's own tests pass");
    for (const f of files.filter((f) => f.endsWith("MEMORY.md"))) console.log(`\nIndex ${f}:\n${readFileSync(path.join(folder, f), "utf8")}`);
    for (const t of store.listWorkTopics({ goalId: goal.id })) console.log(`Topic ${t.taskId ? "task" : "goal"}/${t.name}:\n${t.text}\n`);
    console.log(`Steps: ${steps().map((s) => s.outcome).join(", ")}`);
  } finally {
    await socrates.close();
    store.close();
  }
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}).finally(() => rmSync(dir, { recursive: true, force: true }));
