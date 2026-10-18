import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type DeciderClient, type DecisionRequest, type DecisionResponse, type EventPayloads, userText } from "@socrates/contracts";
import { HashEmbedder } from "@socrates/providers";
import { Retrieval } from "@socrates/retrieval";
import { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { continueTask, general } from "../../router/test/helpers";
import { MemoryGate, WORK_MEMORY_INDEX_MAX_TOKENS, WORK_QUESTION, WorkMemoryFiles, WORK_AT, workMemoryBlock, workMemoryScope, workMemorySkill, workState } from "../src";
import { call, contextParts, final, tempDir, world } from "./helpers";

/**
 * Work memory, kept by Socrates (agent-harness.md, "Work memory"; plan in
 * docs/goal-task-memory-plan.md): each goal's and each task's index and
 * topics, in the ledger and Socrates' data folder, never in the user's
 * folders.
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

/** Write a goal's (taskId null) or a task's notes straight into the ledger, as a step would. */
function seed(store: LedgerStore, goalId: string, taskId: string | null, entries: { name: string | null; text: string }[], turnId: string | null = null) {
  for (const e of entries) store.recordWorkMemoryWrite({ goal_id: goalId, task_id: taskId, turn_id: turnId }, { level: taskId ? "task" : "goal", goal_id: goalId, task_id: taskId, target: e.name === null ? "index" : "topic", name: e.name, text: e.text });
}

const scopeOf = (store: LedgerStore, goalId: string, taskId: string | null) => workMemoryScope(store.requireGoal(goalId), taskId ? store.requireTask(taskId) : null);

describe("the task's and goal's indexes", () => {
  it("are shown as WORK_MEMORY from Socrates' own record, never from a file in the repository", async () => {
    // The live v0.1.20 keeps its own project memory at this path; v2 must neither show nor change it.
    const w = await world({ files: { ".socrates/MEMORY.md": LEGACY } });
    seed(w.store, w.goalId, w.taskId, [{ name: "store-schema", text: "Store schema\nSteps\n1. Bump the version." }, { name: null, text: "- Change the store schema → topic store-schema · turns 4, 9" }]);
    seed(w.store, w.goalId, null, [{ name: "flaky-tests", text: "Flaky tests\nSteps\n1. Rerun alone." }, { name: null, text: "- Fix a flaky test → topic flaky-tests · turn 12" }]);
    const { socrates, model } = w.socrates([continueTask(), continueTask()], [final(), final()]);
    await socrates.handle("Change the schema.");
    const first = contextParts(model.requests[0]!)[0]!.text;
    const t = w.store.requireTask(w.taskId).number;
    expect(first).toContain("# WORK_MEMORY");
    expect(first).toContain(`# THIS_TASK (t${t})`);
    expect(first).toContain(`topic_ref: topic:t${t}/store-schema`);
    expect(first).toContain("# THIS_GOAL");
    expect(first).toContain("topic_ref: topic:goal/flaky-tests");
    // The task's own lines come first.
    expect(first.indexOf("THIS_TASK")).toBeLessThan(first.indexOf("THIS_GOAL"));
    expect(first).not.toContain("socrates_doc");
    expect(first.indexOf("# WORK_MEMORY")).toBeLessThan(first.indexOf("# GOAL"));
    expect(readFileSync(path.join(w.root, ".socrates/MEMORY.md"), "utf8")).toBe(LEGACY);

    // A new index is shown from the next turn.
    seed(w.store, w.goalId, null, [{ name: "release", text: "Release\n1. Tag." }, { name: null, text: "- Release → topic release · turn 20" }]);
    await socrates.handle("Release it.");
    expect(contextParts(model.requests.at(-1)!)[0]!.text).toContain("topic_ref: topic:goal/release");
  });

  it("belong to one goal and one task: another goal on the same folder, and another task, see none of them", () => {
    const store = LedgerStore.open({ path: ":memory:" });
    const workspace = store.createWorkspace("work", tempDir());
    const a = store.createGoal({ title: "Socrates development", workspaceId: workspace.id });
    const b = store.createGoal({ title: "Career profile", workspaceId: workspace.id });
    const a1 = store.createTask(a.id, { title: "Routing review" });
    const a2 = store.createTask(a.id, { title: "Memory split" });
    seed(store, a.id, a1.id, [{ name: "router", text: "x" }, { name: null, text: "- Router → topic router · turn 1" }]);
    expect(workMemoryBlock(store, scopeOf(store, a.id, a1.id), null)).toContain("topic:t1/router");
    expect(workMemoryBlock(store, scopeOf(store, a.id, a2.id), null)).toBeNull();
    expect(workMemoryBlock(store, scopeOf(store, b.id, null), null)).toBeNull();
    seed(store, a.id, null, [{ name: "release", text: "y" }, { name: null, text: "- Release → topic release · turn 2" }]);
    expect(workMemoryBlock(store, scopeOf(store, a.id, a2.id), null)).toContain("topic:goal/release");
    expect(workMemoryBlock(store, scopeOf(store, b.id, null), null)).toBeNull();
    store.close();
  });

  it("are left out without a scope, when empty or when memories are not used, and are held to their budget", () => {
    const store = LedgerStore.open({ path: ":memory:" });
    const goal = store.createGoal({ title: "g" });
    const task = store.createTask(goal.id, { title: "t" });
    const scope = scopeOf(store, goal.id, task.id);
    expect(workMemoryBlock(store, null, null)).toBeNull();
    expect(workMemoryBlock(store, scope, null)).toBeNull();
    seed(store, goal.id, null, [{ name: "store-schema", text: "x" }, { name: "flaky-tests", text: "y" }, { name: null, text: INDEX }]);
    expect(workMemoryBlock(store, scope, { save: true, use: false })).toBeNull();
    expect(workMemoryBlock(store, scope, { save: true, use: true })).toContain("Fix a flaky test");

    const lines = (word: string) => Array.from({ length: 200 }, (_, i) => `- ${word} number ${i} with some words to cost tokens → topic t${i} · turns ${i}`).join("\n");
    seed(store, goal.id, null, [{ name: null, text: lines("Goal") }]);
    seed(store, goal.id, task.id, [{ name: null, text: lines("Task") }]);
    const block = workMemoryBlock(store, scope, null)!;
    expect(block).toContain("Task number 0 ");
    expect(block).not.toContain("Task number 199 ");
    // The task's lines take their share, the goal's still show.
    expect(block).toContain("Goal number 0 ");
    expect(block.match(/older lines not shown: this index is over its share/g)).toHaveLength(2);
    expect(WORK_MEMORY_INDEX_MAX_TOKENS).toBe(1_500);
    store.close();
  });

  it("is one memory for every day in General, with no task memory", () => {
    const store = LedgerStore.open({ path: ":memory:" });
    const goal = store.createGoal({ title: "General conversation", general: true });
    const day = store.createTask(goal.id, { title: "General · Fri 9 Oct", general: true });
    expect(workMemoryScope(goal, day)).toMatchObject({ goalId: goal.id, taskId: null, general: true });
    seed(store, goal.id, null, [{ name: "devices", text: "Laptop" }, { name: null, text: "- Laptop setup → topic devices · turn 1" }]);
    const block = workMemoryBlock(store, workMemoryScope(goal, day), null)!;
    expect(block).toContain("# GENERAL");
    expect(block).not.toContain("THIS_TASK");
    store.close();
  });
});

describe("which turns are asked about", () => {
  const ev = (tool: string, input: unknown, status: "ok" | "error" = "ok", result: unknown = null) => ({ taskId: "t", number: 1, handle: "e1", callId: "c", tool, turnId: "x", input, status, result: result === null ? null : { result } as never, createdAt: "" });

  it("are every finished turn; the decider reads its calls as lines", () => {
    expect(WORK_AT).toBe(0.4);
    const calls = [ev("read", { path: "src/schema.ts" }), ev("edit", { path: "src/schema.ts" }), ev("terminal", { command: "pnpm test" }, "error")];
    const state = workState({ request: "Add a column to the store.", calls, answer: "Done." });
    expect(state).toContain("Add a column to the store.");
    expect(state).toContain("# FINAL_ANSWER");
    expect(state).toContain("Done.");
    expect(state).toContain("TOOL CALL [e1]");
    expect(state).toContain("call_status: error");
    expect(WORK_QUESTION.instructions).toContain("repeatable procedure");
    expect(WORK_QUESTION.instructions).toContain("a new decision the user made or confirmed");
    expect(WORK_QUESTION.instructions).toContain("a fact or preference about the user themselves");
    // A conversation without tools reads as the request and the answer.
    expect(workState({ request: "Lock it: one page.", calls: [], answer: "Agreed." })).toContain("shown_calls: 0");
  });
});

const work = [
  { toolCalls: [call("edit", { path: "src/a.ts", old_text: "", new_text: "export const a = 1;\n" })] },
  final({ full_answer: "Added a; the checks pass." }),
];
const memory = [
  { toolCalls: [call("work_memory", { action: "write_topic", level: "task", topic: "new-module", text: "New module\nSteps\n1. Add the file.\nEvidence: turns 2" })] },
  { toolCalls: [call("work_memory", { action: "write_index", level: "task", text: "- Add a module → topic new-module · turn 2" })] },
  { text: "Wrote new-module." },
];
const policy = (root: string) => ({ folders: [root], approvals: "ask" as const, protected: [] });

describe("recording what a turn established", () => {

  it("writes the task's notes after the answer is saved, in Socrates' data folder, without asking", async () => {
    const w = await world();
    const dir = path.join(tempDir(), "memory");
    const { decider, asked } = workDecider(() => 0.9);
    const { socrates, model } = w.socrates([continueTask()], [...work, ...memory], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }), access: () => policy(w.root), memoryDir: dir });
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

    expect(w.store.workMemoryIndex(w.goalId, w.taskId)!.text).toBe("- Add a module → topic new-module · turn 2");
    expect(w.store.workTopic(w.goalId, w.taskId, "new-module")!.text).toContain("1. Add the file.");
    expect(w.store.workMemoryIndex(w.goalId, null)).toBeNull();
    const goal = w.store.requireGoal(w.goalId);
    const task = w.store.requireTask(w.taskId);
    const folder = path.join(dir, "goals", `g${goal.number}-project-work`, "tasks", `t${task.number}-fix-the-server`);
    expect(readFileSync(path.join(folder, "MEMORY.md"), "utf8")).toBe("- Add a module → topic new-module · turn 2\n");
    expect(readFileSync(path.join(folder, "topics", "new-module.md"), "utf8")).toContain("Evidence: turns 2");
    // Nothing in the repository; only the project's own edit asked.
    expect(existsSync(path.join(w.root, ".socrates"))).toBe(false);
    expect(w.approvals.map((a) => a.detail)).toEqual(["Create src/a.ts"]);
    expect(steps(w.store, turn.id)).toEqual(["pending", "written"]);
  });

  it("is queued in a goal without a folder too", async () => {
    const w = await world({ workspace: false });
    const { decider } = workDecider(() => 0.9);
    const { socrates } = w.socrates([continueTask()], [{ toolCalls: [call("terminal", { command: "echo checked" })] }, final(), ...memory], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }), access: () => policy(w.root) });
    await socrates.handle("Check it.");
    await socrates.workMemoryIdle();
    expect(w.store.requireGoal(w.goalId).workspaceId).toBeNull();
    expect(steps(w.store)).toEqual(["pending", "written"]);
    expect(w.store.workMemoryIndex(w.goalId, w.taskId)).not.toBeNull();
  });

  it("moves a lesson up to the goal: written there, then removed from the task once its index lets go", async () => {
    const w = await world();
    const dir = path.join(tempDir(), "memory");
    seed(w.store, w.goalId, w.taskId, [{ name: "new-module", text: "New module\n1. Add the file." }, { name: null, text: "- Add a module → topic new-module · turn 1" }]);
    const { decider } = workDecider(() => 0.9);
    const move = [
      { toolCalls: [call("work_memory", { action: "read" })] },
      { toolCalls: [call("work_memory", { action: "remove_topic", level: "task", topic: "new-module" })] },
      { toolCalls: [call("work_memory", { action: "write_topic", level: "goal", topic: "new-module", text: "New module\n1. Add the file.\n2. Export it." })] },
      { toolCalls: [call("work_memory", { action: "write_index", level: "goal", text: "- Add a module → topic new-module · turns 1, 2" })] },
      { toolCalls: [call("work_memory", { action: "write_index", level: "task", text: "" })] },
      { toolCalls: [call("work_memory", { action: "remove_topic", level: "task", topic: "new-module" })] },
      { text: "Moved new-module to the goal." },
    ];
    const { socrates } = w.socrates([continueTask()], [...work, ...move], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }), access: () => policy(w.root), memoryDir: dir });
    await socrates.handle("Add the module a.");
    await socrates.workMemoryIdle();
    const results = w.store.listEvents({ type: "tool_completed" }).slice(-6).map((e) => e.payload as EventPayloads["tool_completed"]);
    expect(JSON.parse(results[0]!.content)).toMatchObject({ task: { topics: ["new-module"] }, goal: { topics: [] } });
    // Refused while the task's index still names it.
    expect(results[1]!.error?.code).toBe("topic_in_index");
    expect(results.slice(2).map((r) => r.error ?? null)).toEqual([null, null, null, null]);
    expect(w.store.workTopic(w.goalId, w.taskId, "new-module")).toBeNull();
    expect(w.store.workMemoryIndex(w.goalId, w.taskId)).toBeNull();
    expect(w.store.workTopic(w.goalId, null, "new-module")!.text).toContain("2. Export it.");
    const goal = path.join(dir, "goals", `g${w.store.requireGoal(w.goalId).number}-project-work`);
    expect(readFileSync(path.join(goal, "topics", "new-module.md"), "utf8")).toContain("2. Export it.");
    // The task's folder held only that note, so it is gone.
    expect(existsSync(path.join(goal, "tasks"))).toBe(false);
  });

  it("writes General's notes at the goal only, in one folder for every day", async () => {
    const w = await world();
    const dir = path.join(tempDir(), "memory");
    const { decider } = workDecider(() => 0.9);
    const notes = [
      { toolCalls: [call("work_memory", { action: "write_topic", level: "task", topic: "devices", text: "Laptop" })] },
      { toolCalls: [call("work_memory", { action: "write_topic", level: "goal", topic: "devices", text: "Laptop setup\n1. Use the dock." })] },
      { toolCalls: [call("work_memory", { action: "write_index", level: "goal", text: "- Laptop setup → topic devices · turn 2" })] },
      { text: "Wrote devices." },
    ];
    const { socrates, model } = w.socrates([general()], [{ toolCalls: [call("terminal", { command: "echo docked" })] }, final(), ...notes], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }), access: () => policy(w.root), memoryDir: dir });
    await socrates.handle("Check my laptop dock.");
    await socrates.workMemoryIdle();
    const guide = model.requests[2]!.messages.at(-1)!;
    expect(guide.role === "user" ? userText(guide.content) : "").toContain("General conversation: it keeps one memory for every day");
    const codes = w.store.listEvents({ type: "tool_completed" }).slice(-3).map((e) => (e.payload as EventPayloads["tool_completed"]).error?.code ?? null);
    expect(codes).toEqual(["no_task_memory", null, null]);
    expect(readFileSync(path.join(dir, "goals", "general", "topics", "devices.md"), "utf8")).toContain("Use the dock.");
    expect(readdirSync(path.join(dir, "goals", "general")).sort()).toEqual(["MEMORY.md", "topics"]);
  });

  it("does not hold the chat: the next message runs while the step is still waiting", async () => {
    const w = await world();
    let release!: (p: number) => void;
    let calls = 0;
    // The first turn's question waits; the second turn, a plain answer, is asked too and answered no.
    const { decider } = workDecider(() => calls++ === 0 ? new Promise<number>((done) => { release = done; }) : 0);
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
        call("work_memory", { action: "write_topic", level: "task", topic: "Bad Name", text: "x" }),
        call("work_memory", { action: "write_topic", level: "task", topic: "long", text: "x".repeat(3_001) }),
        call("work_memory", { action: "write_index", level: "goal", text: "- Missing → topic nowhere · turn 1" }),
        call("work_memory", { action: "write_index", level: "task", text: Array.from({ length: 61 }, (_, i) => `- line ${i}`).join("\n") }),
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

  it("asks after a turn without changes too, writes nothing when the decider says no or saving is off, and is skipped when Socrates stops", async () => {
    for (const setup of [
      { work: 0.1, steps: work, memory: { save: true, use: true }, expected: ["pending", "not_worth"], writer: false },
      { work: 0.39, steps: [final({ full_answer: "Hello!" })], memory: { save: true, use: true }, expected: ["pending", "not_worth"], writer: false },
      { work: 0.9, steps: [{ toolCalls: [call("read", { path: "nothing" })] }, final()], memory: { save: true, use: true }, expected: ["pending", "written"], writer: true },
      { work: 0.9, steps: work, memory: { save: false, use: true }, expected: [], writer: false },
    ]) {
      const w = await world();
      const { decider } = workDecider(() => setup.work);
      const { socrates, model } = w.socrates([continueTask()], [...setup.steps, ...memory], { gate: () => new MemoryGate({ decider }), memory: () => setup.memory });
      await socrates.handle("Add the module a.");
      await socrates.workMemoryIdle();
      expect(model.requests).toHaveLength(setup.steps.length + (setup.writer ? memory.length : 0));
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
      return { toolCalls: [call("work_memory", { action: "write_topic", level: "task", topic: "new-module", text: "Should not replace the good note" })] };
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
        { toolCalls: [call("work_memory", { action: "write_topic", level: "task", topic: "transport", text: "automobile repair" })] },
        () => { throw new Error("provider failed after the durable write"); },
      ], { gate: () => new MemoryGate({ decider, timeoutMs: 60_000 }), memory: () => ({ save: true, use: true }), semantic: retrieval });
      await socrates.handle("Add a module"); await retrieval.idle();
      expect(await retrieval.search("car maintenance", { kinds: ["work_topic"], limit: 20 })).toEqual([]);
      release(0.9); await socrates.workMemoryIdle(); await retrieval.idle();
      expect(steps(w.store)).toEqual(["pending", "failed"]);
      expect((await retrieval.search("car maintenance", { kinds: ["work_topic"], limit: 20 })).map((h) => h.sourceId)).toContain(`${w.goalId}/${w.taskId}/transport`);
    } finally { await retrieval.close(); }
  });

  it("does not record again what the answer saved as user memory, and marks what the user undid", async () => {
    const w = await world();
    let release!: (p: number) => void;
    const { decider } = workDecider(() => new Promise<number>((done) => { release = done; }));
    const lock = { text: "Resume stays one page and leads with the Socrates project.", kind: "knowledge" as const, scope: "goal" as const };
    const undo = { text: "Drop the Bosch internship from the resume.", kind: "knowledge" as const, scope: "goal" as const };
    const { socrates, model } = w.socrates([continueTask()], [final({ full_answer: "Locked.", memory: { save: [lock, undo], forget: [] } }), { text: "Nothing to record." }], { gate: () => new MemoryGate({ decider, timeoutMs: 60_000 }), memory: () => ({ save: true, use: true }) });
    await socrates.handle("Lock it: one page, Socrates first, drop Bosch.");
    const saved = w.store.listMemories();
    expect(saved.map((m) => m.text)).toEqual(expect.arrayContaining([lock.text, undo.text]));
    // The user clicks Undo on one before the step runs.
    w.store.forgetMemory(saved.find((m) => m.text === undo.text)!.id, "user");
    release(0.9);
    await socrates.workMemoryIdle();
    const guide = model.requests.at(-1)!.messages.at(-1)!;
    const text = guide.role === "user" ? userText(guide.content) : "";
    expect(text).toContain("Already saved this turn as user memory");
    expect(text).toContain(`: ${JSON.stringify(lock.text)}`);
    expect(text).toMatch(/- m\d+ \(undone by the user\): "Drop the Bosch internship/);
    expect(steps(w.store)).toEqual(["pending", "nothing"]);
    // Without saves this turn the guide carries no list.
    expect(workMemorySkill(3)).not.toContain("Already saved");
  });

  it("carries a guide that names the tool, the index's form and the turn", () => {
    const guide = workMemorySkill(41);
    expect(guide).toContain("this turn is turn 41");
    expect(guide).toContain("work_memory");
    expect(guide).toContain("→ topic <name> · turns N, M");
    expect(guide).toContain("about 40 lines");
    expect(guide).toContain("Nothing to record.");
    expect(guide).not.toContain(".socrates");
    expect(guide).toContain("Write at level task first");
    expect(guide).toContain("remove_topic");
    expect(workMemorySkill(41, true)).toContain("write at level goal and name topics by subject");
  });
});

describe("reading topics in a turn", () => {
  it("opens a topic by ref, and finds the goal's, this task's and its other tasks' topics, also those no longer in an index", async () => {
    const w = await world();
    const other = w.store.createTask(w.goalId, { title: "Release work" });
    seed(w.store, w.goalId, w.taskId, [{ name: "store-schema", text: "Store schema\nSteps\n1. Bump SCHEMA_VERSION.\n2. Add a migration." }]);
    seed(w.store, w.goalId, null, [{ name: "release", text: "Release\nSteps\n1. Tag and push." }, { name: null, text: "- Release → topic release · turn 3" }]);
    seed(w.store, w.goalId, other.id, [{ name: "schema-backfill", text: "Schema backfill\n1. Rebuild the migration index." }]);
    const t = w.store.requireTask(w.taskId).number;
    const { socrates } = w.socrates([continueTask()], [
      { toolCalls: [
        call("context_retrieve", { action: "inspect", ref: `topic:t${t}/store-schema` }),
        call("context_retrieve", { action: "memory", query: "migration schema version" }),
        call("context_retrieve", { action: "inspect", ref: "topic:nowhere" }),
        call("context_retrieve", { action: "inspect", ref: "topic:release" }),
      ] },
      final(),
    ]);
    await socrates.handle("Change the schema.");
    // In call order: the calls run in parallel, so they may finish in any order.
    const results = w.store.evidenceForTurn(w.store.turnsForTask(w.taskId).at(-1)!.id).map((e) => e.result!);
    expect(JSON.parse(results[0]!.content).topic).toMatchObject({ ref: `topic:t${t}/store-schema`, text: expect.stringContaining("Bump SCHEMA_VERSION") });
    const found = JSON.parse(results[1]!.content).work_topics.map((x: { ref: string }) => x.ref);
    expect(found).toEqual(expect.arrayContaining([`topic:t${t}/store-schema`, `topic:t${other.number}/schema-backfill`]));
    expect(results[2]!.error?.code).toBe("topic_not_found");
    // A bare name is looked for in this task, then the goal.
    expect(JSON.parse(results[3]!.content).topic.ref).toBe("topic:goal/release");
  });
});

describe("the files", () => {
  it("follow the ledger: named from titles and renamed with them, with you.md, and replaced at startup", () => {
    const store = LedgerStore.open({ path: ":memory:" });
    const dir = path.join(tempDir(), "memory");
    const files = new WorkMemoryFiles(dir);
    const stop = files.follow(store);
    const goal = store.createGoal({ title: "Socrates development" });
    const task = store.createTask(goal.id, { title: "Routing review" });
    seed(store, goal.id, task.id, [{ name: "router", text: "Router\n1. Check labels." }, { name: null, text: "- Router → topic router · turn 1" }]);
    seed(store, goal.id, null, [{ name: null, text: "- Nothing yet" }]);
    const g = path.join(dir, "goals", `g${goal.number}-socrates-development`);
    expect(readFileSync(path.join(g, "tasks", `t${task.number}-routing-review`, "topics", "router.md"), "utf8")).toBe("Router\n1. Check labels.\n");
    expect(readFileSync(path.join(g, "MEMORY.md"), "utf8")).toBe("- Nothing yet\n");

    store.renameGoal(goal.id, "Socrates v2");
    const renamed = path.join(dir, "goals", `g${goal.number}-socrates-v2`);
    expect(existsSync(g)).toBe(false);
    expect(existsSync(path.join(renamed, "tasks", `t${task.number}-routing-review`, "MEMORY.md"))).toBe(true);

    store.saveMemory({ kind: "preference", text: "Prefers short answers.", goalId: null, by: "user" }, {});
    store.saveMemory({ kind: "knowledge", text: "Ships on Fridays.", goalId: goal.id, by: "user" }, {});
    const you = readFileSync(path.join(dir, "you.md"), "utf8");
    expect(you).toContain("## Everywhere\n- m1 · preference · Prefers short answers.");
    expect(you).toContain(`## Goal g${goal.number} · Socrates v2\n- m2 · knowledge · Ships on Fridays.`);
    stop();

    // An edit by hand is replaced at the next start; a note the ledger no longer holds goes.
    writeFileSync(path.join(renamed, "MEMORY.md"), "edited by hand\n");
    writeFileSync(path.join(renamed, "topics-stray.md"), "kept: not a note\n");
    mkdirSync(path.join(renamed, "topics"), { recursive: true });
    writeFileSync(path.join(renamed, "topics", "gone.md"), "old\n");
    expect(files.syncAll(store)).toBe(2);
    expect(readFileSync(path.join(renamed, "MEMORY.md"), "utf8")).toBe("- Nothing yet\n");
    expect(existsSync(path.join(renamed, "topics"))).toBe(false);
    expect(existsSync(path.join(renamed, "topics-stray.md"))).toBe(true);
    expect(files.syncAll(store)).toBe(0);
    store.close();
  });
});

describe("a redo", () => {
  it("takes back what the first attempt wrote, in the ledger and the files", async () => {
    const w = await world();
    const dir = path.join(tempDir(), "memory");
    seed(w.store, w.goalId, w.taskId, [{ name: "port", text: "Port\n1. Use 3000." }, { name: null, text: "- Ports → topic port · turn 1" }]);
    const other = w.store.createTask(w.goalId, { title: "Port settings" });
    const { decider } = workDecider(() => 0.9);
    const { socrates } = w.socrates([continueTask()], [...work,
      { toolCalls: [call("work_memory", { action: "write_topic", level: "task", topic: "port", text: "Port\n1. Use 30 (wrong)." })] },
      { toolCalls: [call("work_memory", { action: "write_topic", level: "goal", topic: "ports", text: "Ports\n1. Wrong task." })] },
      { toolCalls: [call("work_memory", { action: "write_index", level: "goal", text: "- Ports → topic ports · turn 2" })] },
      { text: "Wrote port." },
      final({ full_answer: "Answered where it belongs." }),
    ], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }), access: () => policy(w.root), memoryDir: dir });
    const first = await socrates.handle("Fix the port.");
    if (first.kind !== "answered") throw new Error("expected an answer");
    await socrates.workMemoryIdle();
    expect(w.store.workTopic(w.goalId, w.taskId, "port")!.text).toContain("wrong");
    await socrates.handle("Fix the port.", { target: { taskId: other.id }, pinned: true, redoOf: first.parts[0]!.turn.id });
    await socrates.workMemoryIdle();
    // The task's topic is back to what it was; the goal's notes, written only by that turn, are gone.
    expect(w.store.workTopic(w.goalId, w.taskId, "port")!.text).toBe("Port\n1. Use 3000.");
    expect(w.store.workTopic(w.goalId, null, "ports")).toBeNull();
    expect(w.store.workMemoryIndex(w.goalId, null)).toBeNull();
    const g = path.join(dir, "goals", `g${w.store.requireGoal(w.goalId).number}-project-work`);
    expect(readFileSync(path.join(g, "tasks", `t${w.store.requireTask(w.taskId).number}-fix-the-server`, "topics", "port.md"), "utf8")).toBe("Port\n1. Use 3000.\n");
    expect(existsSync(path.join(g, "MEMORY.md"))).toBe(false);
    expect(existsSync(path.join(g, "topics"))).toBe(false);

    // Replaying the log gives the same: the redone turn's writes stay out.
    const copy = LedgerStore.open({ path: ":memory:" });
    copy.restoreEvents(w.store.listEvents());
    expect(copy.listWorkMemory(w.goalId).map((e) => [e.taskId, e.name, e.text])).toEqual(w.store.listWorkMemory(w.goalId).map((e) => [e.taskId, e.name, e.text]));
    copy.close();
  });
});

describe("a topic the user removes", () => {
  it("leaves with its index line, in the ledger and the files, and a later redo does not bring it back", async () => {
    const w = await world();
    const dir = path.join(tempDir(), "memory");
    const other = w.store.createTask(w.goalId, { title: "Port settings" });
    const { decider } = workDecider(() => 0.9);
    const { socrates } = w.socrates([continueTask()], [...work,
      { toolCalls: [call("work_memory", { action: "write_topic", level: "task", topic: "port", text: "Port\n1. Use 3000." })] },
      { toolCalls: [call("work_memory", { action: "write_topic", level: "task", topic: "host", text: "Host\n1. Use localhost." })] },
      { toolCalls: [call("work_memory", { action: "write_index", level: "task", text: "- Ports → topic port · turn 1\n- Hosts → topic host · turn 1" })] },
      { text: "Wrote port and host." },
      final({ full_answer: "Answered where it belongs." }),
    ], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }), access: () => policy(w.root), memoryDir: dir });
    const first = await socrates.handle("Fix the port.");
    if (first.kind !== "answered") throw new Error("expected an answer");
    await socrates.workMemoryIdle();
    const t = path.join(dir, "goals", `g${w.store.requireGoal(w.goalId).number}-project-work`, "tasks", `t${w.store.requireTask(w.taskId).number}-fix-the-server`);
    expect(existsSync(path.join(t, "topics", "port.md"))).toBe(true);

    expect(w.store.removeWorkTopic({ goalId: w.goalId, taskId: w.taskId, name: "port" })).toBe(true);
    expect(w.store.workTopic(w.goalId, w.taskId, "port")).toBeNull();
    expect(w.store.workMemoryIndex(w.goalId, w.taskId)!.text).toBe("- Hosts → topic host · turn 1");
    expect(w.store.listEvents({ type: "work_memory_written" }).slice(-2).map((e) => (e.payload as EventPayloads["work_memory_written"]).by)).toEqual(["user", "user"]);
    expect(existsSync(path.join(t, "topics", "port.md"))).toBe(false);
    expect(readFileSync(path.join(t, "MEMORY.md"), "utf8")).not.toContain("port");
    expect(w.store.removeWorkTopic({ goalId: w.goalId, taskId: w.taskId, name: "port" })).toBe(false);

    // The last topic takes the index with it.
    w.store.removeWorkTopic({ goalId: w.goalId, taskId: w.taskId, name: "host" });
    expect(w.store.workMemoryIndex(w.goalId, w.taskId)).toBeNull();

    // Redoing the turn that wrote them takes back its own writes; the user's removals stay.
    await socrates.handle("Fix the port.", { target: { taskId: other.id }, pinned: true, redoOf: first.parts[0]!.turn.id });
    await socrates.workMemoryIdle();
    expect(w.store.listWorkMemory(w.goalId).filter((e) => e.taskId === w.taskId)).toEqual([]);
    const copy = LedgerStore.open({ path: ":memory:" });
    copy.restoreEvents(w.store.listEvents());
    expect(copy.listWorkMemory(w.goalId).filter((e) => e.taskId === w.taskId)).toEqual([]);
    copy.close();
  });
});

describe("a folder's memory, from before", () => {
  it("is kept in the log and not projected", () => {
    const store = LedgerStore.open({ path: ":memory:" });
    store.appendEvent("work_memory_written", { project_id: "work-5607f12456", root: "/Users/x/Work", target: "topic", name: "old", text: "Old" }, {});
    const copy = LedgerStore.open({ path: ":memory:" });
    copy.restoreEvents(store.listEvents());
    expect(copy.listWorkTopics()).toEqual([]);
    expect(copy.listEvents({ type: "work_memory_written" })).toHaveLength(1);
    store.close(); copy.close();
  });
});

describe("after a restart", () => {
  it("skips steps left unfinished and writes the files from the ledger", () => {
    const store = LedgerStore.open({ path: ":memory:" });
    const goal = store.createGoal({ title: "g", objective: "g" });
    const task = store.createTask(goal.id, { title: "t", objective: "t" });
    seed(store, goal.id, task.id, [{ name: "a", text: "A" }, { name: null, text: "- A → topic a · turn 1" }]);
    store.recordWorkMemoryStep({ goal_id: goal.id, task_id: task.id, turn_id: null }, { outcome: "pending", detail: null, writes: 0 });
    expect(store.skipUnfinishedWorkMemorySteps()).toBe(0); // a step needs its turn
    const dir = path.join(tempDir(), "memory");
    const files = new WorkMemoryFiles(dir);
    expect(files.syncAll(store)).toBe(2);
    expect(readdirSync(path.join(dir, "goals", `g${goal.number}-g`, "tasks", `t${task.number}-t`)).sort()).toEqual(["MEMORY.md", "topics"]);
    expect(files.syncAll(store)).toBe(0);
    store.close();
  });
});


it("scopes semantic topic retrieval to the goal before the top-20 limit, with competing goals", async () => {
  const w = await world();
  seed(w.store, w.goalId, w.taskId, [{ name: "transport", text: "automobile repair procedure" }]);
  for (let i = 0; i < 30; i++) {
    const other = w.store.createGoal({ title: `Other ${i}` });
    seed(w.store, other.id, null, [{ name: "transport", text: "car maintenance" }]);
  }
  const retrieval = await Retrieval.open({ store: w.store, embedder: new HashEmbedder({ concepts: [["automobile", "car"], ["repair", "maintenance"]] }), uri: tempDir(), workspaceFiles: false });
  try {
    await retrieval.idle();
    const { socrates } = w.socrates([continueTask()], [{ toolCalls: [call("context_retrieve", { action: "memory", query: "car maintenance" })] }, final()], { semantic: retrieval });
    await socrates.handle("Find the procedure");
    const result = JSON.parse(w.store.evidenceForTurn(w.store.turnsForTask(w.taskId).at(-1)!.id)[0]!.result!.content);
    expect(result.work_topics).toEqual([expect.objectContaining({ ref: `topic:t${w.store.requireTask(w.taskId).number}/transport`, title: "automobile repair procedure" })]);
  } finally { await retrieval.close(); }
});
