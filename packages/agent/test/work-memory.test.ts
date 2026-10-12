import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { type DeciderClient, type DecisionRequest, type DecisionResponse, type EventPayloads, userText } from "@socrates/contracts";
import { HashEmbedder } from "@socrates/providers";
import { Retrieval } from "@socrates/retrieval";
import { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { continueTask } from "../../router/test/helpers";
import { MemoryGate, WORK_MEMORY_INDEX_MAX_TOKENS, WORK_QUESTION, WorkMemoryFiles, didRealWork, resolveWorkProject, workMemoryBlock, workMemoryProject, workMemorySkill, workState } from "../src";
import { call, contextParts, final, tempDir, world, writeFiles } from "./helpers";

/**
 * Work memory, kept by Socrates (agent-harness.md, "Work memory"; plan M4a in
 * docs/terminal-output-and-memory.md): the same index and topics as before,
 * in the ledger and Socrates' data folder, never in the user's repository.
 */

/** A decider that answers the work question from a script and remembers what it was asked. */
function workDecider(work: () => number | Promise<number>) {
  const asked: DecisionRequest[] = [];
  const decider: DeciderClient = {
    id: "fake:decider",
    async decide(request: DecisionRequest): Promise<DecisionResponse> {
      asked.push(request);
      const probability = "work" in request.questions ? await work() : 0;
      return { model: "fake", probabilities: Object.fromEntries(Object.keys(request.questions).map((q) => [q, q === "work" ? probability : 0])), usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, id: null };
    },
  };
  return { decider, asked };
}

const LEGACY = "---\nsocrates_doc: project_memory\nschema_version: 1\n---\n\n# Project Memory\n";
const INDEX = "- Change the store schema → topic store-schema · turns 4, 9\n- Fix a flaky test → topic flaky-tests · turn 12";

function steps(store: LedgerStore, turnId?: string) {
  return store.listEvents({ type: "work_memory_step" }).filter((e) => !turnId || e.turn_id === turnId).map((e) => (e.payload as EventPayloads["work_memory_step"]).outcome);
}

/** Write a project's notes straight into the ledger, as a step would. */
function seed(store: LedgerStore, root: string, entries: { name: string | null; text: string }[]) {
  const project = resolveWorkProject(root)!;
  for (const e of entries) store.recordWorkMemoryWrite({}, { project_id: project.id, root: project.root, target: e.name === null ? "index" : "topic", name: e.name, text: e.text });
  return project;
}

describe("the project's index", () => {
  it("is shown as PROJECT_MEMORY from Socrates' own record, never from a file in the repository", async () => {
    // The live v0.1.20 keeps its own project memory at this path; v2 must neither show nor change it.
    const w = await world({ files: { ".socrates/MEMORY.md": LEGACY } });
    seed(w.store, w.root, [{ name: "store-schema", text: "Store schema\nSteps\n1. Bump the version." }, { name: "flaky-tests", text: "Flaky tests\nSteps\n1. Rerun alone." }, { name: null, text: INDEX }]);
    const { socrates, model } = w.socrates([continueTask(), continueTask()], [final(), final()]);
    await socrates.handle("Change the schema.");
    const first = contextParts(model.requests[0]!)[0]!.text;
    expect(first).toContain("# PROJECT_MEMORY");
    expect(first).toContain("topic_ref: topic:store-schema");
    expect(first).toContain("Fix a flaky test");
    expect(first).not.toContain("socrates_doc");
    expect(first.indexOf("# PROJECT_MEMORY")).toBeLessThan(first.indexOf("# GOAL"));
    expect(readFileSync(path.join(w.root, ".socrates/MEMORY.md"), "utf8")).toBe(LEGACY);

    // A new index is shown from the next turn.
    seed(w.store, w.root, [{ name: "release", text: "Release\n1. Tag." }, { name: null, text: "- Release → topic release · turn 20" }]);
    await socrates.handle("Release it.");
    expect(contextParts(model.requests.at(-1)!)[0]!.text).toContain("topic_ref: topic:release");
  });

  it("is left out without a project, when empty or when memories are not used, and is held to its budget", () => {
    const store = LedgerStore.open({ path: ":memory:" });
    const dir = tempDir();
    const project = resolveWorkProject(dir)!;
    expect(workMemoryBlock(store, null, null)).toBeNull();
    expect(workMemoryBlock(store, project, null)).toBeNull();
    seed(store, dir, [{ name: "store-schema", text: "x" }, { name: "flaky-tests", text: "y" }, { name: null, text: INDEX }]);
    expect(workMemoryBlock(store, project, { save: true, use: false })).toBeNull();
    expect(workMemoryBlock(store, project, { save: true, use: true })).toContain("Fix a flaky test");

    const lines = Array.from({ length: 200 }, (_, i) => `- Topic number ${i} with some words to cost tokens → topic t${i} · turns ${i}`);
    store.recordWorkMemoryWrite({}, { project_id: project.id, root: dir, target: "index", name: null, text: lines.join("\n") });
    const block = workMemoryBlock(store, project, null)!;
    expect(block).toContain("Topic number 0 ");
    expect(block).not.toContain("Topic number 199 ");
    expect(block).toMatch(/\(\d+ older lines not shown: the index is over its budget of 1500 tokens; merge related lines or drop the stalest/);
    expect(WORK_MEMORY_INDEX_MAX_TOKENS).toBe(1_500);
    store.close();
  });
});

describe("which project a turn's notes belong to", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

  it("is the repository for every worktree of it, a folder on its own otherwise, and never General's", async () => {
    const repo = tempDir();
    writeFiles(repo, { "a.txt": "a\n", "sub/b.txt": "b\n" });
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    const tree = path.join(tempDir(), "tree");
    git(repo, "worktree", "add", "-q", tree);
    const main = resolveWorkProject(repo)!;
    expect(main.kind).toBe("git");
    expect(resolveWorkProject(tree)!.id).toBe(main.id);
    // A folder inside a repository is a project of its own; a plain folder too.
    expect(resolveWorkProject(path.join(repo, "sub"))).toMatchObject({ kind: "folder" });
    expect(resolveWorkProject(path.join(repo, "sub"))!.id).not.toBe(main.id);
    expect(resolveWorkProject(tempDir())!.kind).toBe("folder");
    expect(main.id).toMatch(/^[a-z0-9-]+-[0-9a-f]{10}$/);

    const w = await world();
    const goal = w.store.requireGoal(w.goalId);
    expect(workMemoryProject(goal, null)).toBeNull();
    expect(workMemoryProject({ ...goal, general: true }, { root: w.root } as never)).toBeNull();
    expect(workMemoryProject({ ...goal, workspaceId: null }, { root: w.root } as never)).toBeNull();
  });
});

describe("which turns are asked about", () => {
  const ev = (tool: string, input: unknown, status: "ok" | "error" = "ok", result: unknown = null) => ({ taskId: "t", number: 1, handle: "e1", callId: "c", tool, turnId: "x", input, status, result: result === null ? null : { result } as never, createdAt: "" });

  it("are those with one change or command that succeeded; the decider reads them as lines", () => {
    expect(didRealWork([ev("read", { path: "a" }), ev("grep", { pattern: "x" })])).toBe(false);
    // One applied edit is enough: a short verified fix counts.
    expect(didRealWork([ev("edit", { path: "a" })])).toBe(true);
    expect(didRealWork([ev("edit", { path: "a" }, "error")])).toBe(false);
    expect(didRealWork([ev("terminal", { command: "pnpm test" }, "ok", { status: "completed", exit_code: 1 })])).toBe(false);
    expect(didRealWork([ev("terminal", { command: "pnpm dev" }, "ok", { status: "running" })])).toBe(false);
    expect(didRealWork([ev("terminal", { command: "pnpm test" }, "ok", { status: "completed", exit_code: 0 })])).toBe(true);
    const calls = [ev("read", { path: "src/schema.ts" }), ev("edit", { path: "src/schema.ts" }), ev("terminal", { command: "pnpm test" }, "error")];
    const state = workState({ request: "Add a column to the store.", calls, answer: "Done." });
    expect(state).toContain("Add a column to the store.");
    expect(state).toContain("# FINAL_ANSWER");
    expect(state).toContain("Done.");
    expect(state).toContain("TOOL CALL [e1]");
    expect(state).toContain("call_status: error");
    expect(WORK_QUESTION.instructions).toContain("repeatable procedure");
  });
});

describe("recording what a turn established", () => {
  const work = [
    { toolCalls: [call("edit", { path: "src/a.ts", old_text: "", new_text: "export const a = 1;\n" })] },
    final({ full_answer: "Added a; the checks pass." }),
  ];
  const memory = [
    { toolCalls: [call("work_memory", { action: "write_topic", topic: "new-module", text: "New module\nSteps\n1. Add the file.\nEvidence: turns 2" })] },
    { toolCalls: [call("work_memory", { action: "write_index", text: "- Add a module → topic new-module · turn 2" })] },
    { text: "Wrote new-module." },
  ];
  const policy = (root: string) => ({ folders: [root], approvals: "ask" as const, protected: [] });

  it("writes the notes after the answer is saved, outside the repository, without asking", async () => {
    const w = await world();
    const dir = path.join(tempDir(), "memory", "projects");
    const { decider, asked } = workDecider(() => 0.9);
    const { socrates, model } = w.socrates([continueTask()], [...work, ...memory], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }), access: () => policy(w.root), workMemoryDir: dir });
    const result = await socrates.handle("Add the module a.");
    expect(result.kind === "answered" && result.text).toBe("Added a; the checks pass.");
    const turn = w.store.turnsForTask(w.taskId).at(-1)!;
    expect(turn.status).toBe("completed");
    await socrates.workMemoryIdle();

    // The decider read the request, the calls and the answer.
    expect(Object.keys(asked.at(-1)!.questions)).toEqual(["work"]);
    expect(asked.at(-1)!.state).toContain("edit src/a.ts");
    // The step continues the turn's conversation with the guide, and has only its two tools.
    const step = model.requests[2]!;
    const guide = step.messages.at(-1)!;
    expect(guide.role === "user" ? userText(guide.content) : "").toContain(`this turn is turn ${turn.projectTurn}`);
    expect(step.tools?.map((t) => t.name)).toEqual(["work_memory", "context_retrieve"]);
    expect(step.messages.at(-2)!.role).toBe("assistant");

    const project = resolveWorkProject(w.root)!;
    expect(w.store.workMemoryIndex(project.id)!.text).toBe("- Add a module → topic new-module · turn 2");
    expect(w.store.workTopic(project.id, "new-module")!.text).toContain("1. Add the file.");
    expect(readFileSync(path.join(dir, project.id, "MEMORY.md"), "utf8")).toBe("- Add a module → topic new-module · turn 2\n");
    expect(readFileSync(path.join(dir, project.id, "topics", "new-module.md"), "utf8")).toContain("Evidence: turns 2");
    expect(JSON.parse(readFileSync(path.join(dir, project.id, "project.json"), "utf8"))).toMatchObject({ id: project.id, root: project.root, kind: "folder" });
    // Nothing in the repository; only the project's own edit asked.
    expect(existsSync(path.join(w.root, ".socrates"))).toBe(false);
    expect(w.approvals.map((a) => a.detail)).toEqual(["Create src/a.ts"]);
    expect(steps(w.store, turn.id)).toEqual(["pending", "written"]);
  });

  it("is queued on a goal's first turn too, when its folder is bound during that turn", async () => {
    const w = await world({ workspace: false });
    const { decider } = workDecider(() => 0.9);
    const { socrates } = w.socrates([continueTask()], [...work, ...memory], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }), resolveWorkspace: () => ({ name: "project", rootPath: w.root }) });
    await socrates.handle("Add the module a.");
    await socrates.workMemoryIdle();
    expect(w.store.requireGoal(w.goalId).workspaceId).not.toBeNull();
    expect(steps(w.store)).toEqual(["pending", "written"]);
  });

  it("does not hold the chat: the next message runs while the step is still waiting", async () => {
    const w = await world();
    let release!: (p: number) => void;
    const { decider } = workDecider(() => new Promise<number>((done) => { release = done; }));
    const { socrates } = w.socrates([continueTask(), continueTask()], [...work, final({ full_answer: "Second answer." }), { text: "Nothing to record." }], { gate: () => new MemoryGate({ decider, timeoutMs: 60_000 }), memory: () => ({ save: true, use: true }) });
    await socrates.handle("Add the module a.");
    const second = await socrates.handle("And now?");
    expect(second.kind === "answered" && second.text).toBe("Second answer.");
    const first = w.store.turnsForTask(w.taskId).at(-2)!;
    expect(steps(w.store, first.id)).toEqual(["pending"]);
    release(0.9);
    await socrates.workMemoryIdle();
    expect(steps(w.store, first.id)).toEqual(["pending", "nothing"]);
  });

  it("refuses anything but its notes in the step, and work_memory anywhere else", async () => {
    const w = await world();
    const { decider } = workDecider(() => 0.9);
    const sneaky = [{ toolCalls: [call("edit", { path: "src/evil.ts", old_text: "", new_text: "x\n" }), call("terminal", { command: "touch evil" })] }, { text: "Done." }];
    const { socrates } = w.socrates([continueTask()], [...work, ...sneaky], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }) });
    await socrates.handle("Add the module a.");
    await socrates.workMemoryIdle();
    expect(existsSync(path.join(w.root, "src/evil.ts"))).toBe(false);
    expect(existsSync(path.join(w.root, "evil"))).toBe(false);
    const refused = w.store.listEvents({ type: "tool_completed" }).slice(-2).map((e) => (e.payload as EventPayloads["tool_completed"]).error?.code);
    expect(refused).toEqual(["unknown_tool", "unknown_tool"]);

    // In an ordinary turn the tool does not exist.
    const { socrates: plain } = w.socrates([continueTask()], [{ toolCalls: [call("work_memory", { action: "read" })] }, final()]);
    await plain.handle("Read your notes.");
    expect((w.store.listEvents({ type: "tool_completed" }).at(-1)!.payload as EventPayloads["tool_completed"]).error?.code).toBe("unknown_tool");
  });

  it("checks names, sizes and the index's topics", async () => {
    const w = await world();
    const { decider } = workDecider(() => 0.9);
    const bad = [
      { toolCalls: [
        call("work_memory", { action: "write_topic", topic: "Bad Name", text: "x" }),
        call("work_memory", { action: "write_topic", topic: "long", text: "x".repeat(3_001) }),
        call("work_memory", { action: "write_index", text: "- Missing → topic nowhere · turn 1" }),
        call("work_memory", { action: "write_index", text: Array.from({ length: 61 }, (_, i) => `- line ${i}`).join("\n") }),
        call("work_memory", { action: "read", topic: "nowhere" }),
      ] },
      { text: "Nothing to record." },
    ];
    const { socrates } = w.socrates([continueTask()], [...work, ...bad], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }) });
    await socrates.handle("Add the module a.");
    await socrates.workMemoryIdle();
    const codes = w.store.listEvents({ type: "tool_completed" }).slice(-5).map((e) => (e.payload as EventPayloads["tool_completed"]).error?.code);
    expect(codes).toEqual(["invalid_topic", "topic_too_long", "topic_not_found", "index_too_long", "topic_not_found"]);
    expect(steps(w.store)).toEqual(["pending", "nothing"]);
  });

  it("is not asked when the decider says no, nothing was verified, saving is off, or in General; it is skipped when Socrates stops", async () => {
    for (const setup of [
      { work: 0.1, steps: work, memory: { save: true, use: true }, expected: ["pending", "not_worth"] },
      { work: 0.9, steps: [{ toolCalls: [call("read", { path: "nothing" })] }, final()], memory: { save: true, use: true }, expected: [] },
      { work: 0.9, steps: work, memory: { save: false, use: true }, expected: [] },
    ]) {
      const w = await world();
      const { decider } = workDecider(() => setup.work);
      const { socrates, model } = w.socrates([continueTask()], [...setup.steps, ...memory], { gate: () => new MemoryGate({ decider }), memory: () => setup.memory });
      await socrates.handle("Add the module a.");
      await socrates.workMemoryIdle();
      expect(model.requests).toHaveLength(setup.steps.length);
      expect(steps(w.store)).toEqual(setup.expected);
    }

    const w = await world();
    const { decider } = workDecider(() => new Promise<number>(() => {}));
    const { socrates } = w.socrates([continueTask()], work, { gate: () => new MemoryGate({ decider, timeoutMs: 60_000 }), memory: () => ({ save: true, use: true }) });
    await socrates.handle("Add the module a.");
    await socrates.close();
    expect(steps(w.store)).toEqual(["pending", "skipped"]);
  });

  it("skips a decider result after saving is disabled and cancels pending decisions immediately", async () => {
    for (const cancel of [false, true]) {
      const w = await world();
      let save = true;
      let release!: (p: number) => void;
      const { decider } = workDecider(() => new Promise<number>((resolve) => { release = resolve; }));
      const { socrates, model } = w.socrates([continueTask()], [...work, ...memory], { gate: () => new MemoryGate({ decider, timeoutMs: 60_000 }), memory: () => ({ save, use: true }) });
      await socrates.handle("Add a module");
      save = false;
      if (cancel) socrates.cancelWorkMemory(); else release(0.9);
      await socrates.workMemoryIdle();
      expect(model.requests).toHaveLength(2);
      expect(w.store.listWorkTopics()).toEqual([]);
      expect(steps(w.store)).toEqual(["pending", "skipped"]);
    }
  });

  it("checks saving at the write boundary and preserves earlier writes when disabled mid-step", async () => {
    const w = await world();
    let save = true;
    const { decider } = workDecider(() => 0.9);
    const { socrates } = w.socrates([continueTask()], [...work, memory[0]!, () => {
      save = false;
      return { toolCalls: [call("work_memory", { action: "write_topic", topic: "new-module", text: "Should not replace the good note" })] };
    }], { gate: () => new MemoryGate({ decider }), memory: () => ({ save, use: true }) });
    await socrates.handle("Add a module");
    await socrates.workMemoryIdle();
    expect(w.store.listWorkTopics()).toHaveLength(1);
    expect(w.store.listWorkTopics()[0]!.text).toContain("New module");
    expect(steps(w.store)).toEqual(["pending", "skipped"]);
    expect(w.store.listEvents({ type: "work_memory_written" })).toHaveLength(1);
  });

  it("indexes background writes after the foreground sync, including writes before a later failure", async () => {
    const w = await world();
    const retrieval = await Retrieval.open({ store: w.store, embedder: new HashEmbedder({ concepts: [["automobile", "car"], ["repair", "maintenance"]] }), uri: tempDir(), workspaceFiles: false });
    try {
      await retrieval.idle();
      let release!: (p: number) => void;
      const { decider } = workDecider(() => new Promise<number>((resolve) => { release = resolve; }));
      const { socrates } = w.socrates([continueTask()], [...work,
        { toolCalls: [call("work_memory", { action: "write_topic", topic: "transport", text: "automobile repair" })] },
        () => { throw new Error("provider failed after the durable write"); },
      ], { gate: () => new MemoryGate({ decider, timeoutMs: 60_000 }), memory: () => ({ save: true, use: true }), semantic: retrieval });
      await socrates.handle("Add a module"); await retrieval.idle();
      expect(await retrieval.search("car maintenance", { kinds: ["work_topic"], limit: 20 })).toEqual([]);
      release(0.9); await socrates.workMemoryIdle(); await retrieval.idle();
      expect(steps(w.store)).toEqual(["pending", "failed"]);
      expect((await retrieval.search("car maintenance", { kinds: ["work_topic"], limit: 20 })).map((h) => h.sourceId)).toContain(`${resolveWorkProject(w.root)!.id}/transport`);
    } finally { await retrieval.close(); }
  });

  it("carries a guide that names the tool, the index's form and the turn", () => {
    const guide = workMemorySkill(41);
    expect(guide).toContain("this turn is turn 41");
    expect(guide).toContain("work_memory");
    expect(guide).toContain("→ topic <name> · turns N, M");
    expect(guide).toContain("about 40 lines");
    expect(guide).toContain("Nothing to record.");
    expect(guide).not.toContain(".socrates");
  });
});

describe("reading topics in a turn", () => {
  it("opens a topic by ref and finds topics no longer in the index", async () => {
    const w = await world();
    seed(w.store, w.root, [
      { name: "store-schema", text: "Store schema\nSteps\n1. Bump SCHEMA_VERSION.\n2. Add a migration." },
      { name: "release", text: "Release\nSteps\n1. Tag and push." },
      { name: null, text: "- Release → topic release · turn 3" },
    ]);
    const { socrates } = w.socrates([continueTask()], [
      { toolCalls: [
        call("context_retrieve", { action: "inspect", ref: "topic:store-schema" }),
        call("context_retrieve", { action: "memory", query: "migration schema version" }),
        call("context_retrieve", { action: "inspect", ref: "topic:nowhere" }),
      ] },
      final(),
    ]);
    await socrates.handle("Change the schema.");
    // In call order: the calls run in parallel, so they may finish in any order.
    const results = w.store.evidenceForTurn(w.store.turnsForTask(w.taskId).at(-1)!.id).map((e) => e.result!);
    expect(JSON.parse(results[0]!.content).topic).toMatchObject({ ref: "topic:store-schema", text: expect.stringContaining("Bump SCHEMA_VERSION") });
    expect(JSON.parse(results[1]!.content).project_topics).toEqual([expect.objectContaining({ ref: "topic:store-schema", title: "Store schema" })]);
    expect(results[2]!.error?.code).toBe("topic_not_found");
  });
});

describe("after a restart", () => {
  it("skips steps left unfinished and writes the files from the ledger", () => {
    const store = LedgerStore.open({ path: ":memory:" });
    const root = tempDir();
    const goal = store.createGoal({ title: "g", objective: "g" });
    const task = store.createTask(goal.id, { title: "t", objective: "t" });
    const project = seed(store, root, [{ name: "a", text: "A" }, { name: null, text: "- A → topic a · turn 1" }]);
    store.recordWorkMemoryStep({ goal_id: goal.id, task_id: task.id, turn_id: null }, { project_id: project.id, outcome: "pending", detail: null, writes: 0 });
    expect(store.skipUnfinishedWorkMemorySteps()).toBe(0); // a step needs its turn
    const dir = path.join(tempDir(), "projects");
    mkdirSync(dir, { recursive: true });
    const files = new WorkMemoryFiles(dir);
    expect(files.rebuild(store)).toBe(2);
    expect(readdirSync(path.join(dir, project.id)).sort()).toEqual(["MEMORY.md", "project.json", "topics"]);
    expect(files.rebuild(store)).toBe(0);
    store.close();
  });
});


it("scopes semantic topic retrieval before the top-20 limit, with competing projects", async () => {
  const w = await world();
  seed(w.store, w.root, [{ name: "transport", text: "automobile repair procedure" }]);
  for (let i = 0; i < 30; i++) w.store.recordWorkMemoryWrite({}, { project_id: `other-${i}`, root: `/other-${i}`, target: "topic", name: "transport", text: "car maintenance" });
  const retrieval = await Retrieval.open({ store: w.store, embedder: new HashEmbedder({ concepts: [["automobile", "car"], ["repair", "maintenance"]] }), uri: tempDir(), workspaceFiles: false });
  try {
    await retrieval.idle();
    const { socrates } = w.socrates([continueTask()], [{ toolCalls: [call("context_retrieve", { action: "memory", query: "car maintenance" })] }, final()], { semantic: retrieval });
    await socrates.handle("Find the procedure");
    const result = JSON.parse(w.store.evidenceForTurn(w.store.turnsForTask(w.taskId).at(-1)!.id)[0]!.result!.content);
    expect(result.project_topics).toEqual([expect.objectContaining({ ref: "topic:transport", title: "automobile repair procedure" })]);
  } finally { await retrieval.close(); }
});
