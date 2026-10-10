import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type DeciderClient, type DecisionRequest, type DecisionResponse, userText } from "@socrates/contracts";
import { WorkspaceRoot } from "@socrates/tools";
import { describe, expect, it } from "vitest";
import { continueTask } from "../../router/test/helpers";
import { MemoryGate, WORK_MEMORY_INDEX_MAX_TOKENS, WORK_QUESTION, didRealWork, workMemoryBlock, workMemorySkill, workState } from "../src";
import { call, contextParts, contextText, final, tempDir, world, writeFiles } from "./helpers";

/** A decider that answers the work question from a script and remembers what it was asked. */
function workDecider(work: () => number) {
  const asked: DecisionRequest[] = [];
  const decider: DeciderClient = {
    id: "fake:decider",
    async decide(request: DecisionRequest): Promise<DecisionResponse> {
      asked.push(request);
      return { model: "fake", probabilities: Object.fromEntries(Object.keys(request.questions).map((q) => [q, q === "work" ? work() : 0])), usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, id: null };
    },
  };
  return { decider, asked };
}

const INDEX = "- Change the store schema → memory/store-schema.md · turns 4, 9\n- Fix a flaky test → memory/flaky-tests.md · turn 12\n";

describe("the project's index", () => {
  it("is shown as <WORK_MEMORY> in the stable first part, read from the project, and absent without one", async () => {
    const w = await world({ files: { ".socrates/MEMORY.md": INDEX } });
    const { socrates, model } = w.socrates([continueTask(), continueTask()], [final(), final()]);
    await socrates.handle("Change the schema.");
    const first = contextParts(model.requests[0]!)[0]!.text;
    expect(first).toContain(`<WORK_MEMORY>\n${INDEX.trim()}\n</WORK_MEMORY>`);
    // Part of the stable first part, ahead of the goal's own blocks.
    expect(first.indexOf("<WORK_MEMORY>")).toBeLessThan(first.indexOf("<GOAL>"));
    expect(contextText(model.requests[0]!).indexOf("<WORK_MEMORY>")).toBeLessThan(contextText(model.requests[0]!).indexOf("<GOAL_STATE>"));

    // Edited on disk between turns: the next turn shows the new index.
    writeFileSync(path.join(w.root, ".socrates/MEMORY.md"), "- Release → memory/release.md · turn 20\n");
    await socrates.handle("Release it.");
    expect(contextParts(model.requests.at(-1)!)[0]!.text).toContain("<WORK_MEMORY>\n- Release → memory/release.md · turn 20\n</WORK_MEMORY>");
  });

  it("is left out when it is empty, missing, a link, or memories are not used, and is held to its budget", () => {
    const dir = tempDir();
    const workspace = WorkspaceRoot.open("project", dir);
    expect(workMemoryBlock(workspace, null, null)).toBeNull();
    writeFiles(dir, { ".socrates/MEMORY.md": "  \n" });
    expect(workMemoryBlock(workspace, null, null)).toBeNull();
    writeFiles(dir, { ".socrates/MEMORY.md": INDEX });
    expect(workMemoryBlock(workspace, null, { save: true, use: false })).toBeNull();
    expect(workMemoryBlock(workspace, null, { save: true, use: true })).toContain("Fix a flaky test");
    expect(workMemoryBlock(null, null, null)).toBeNull();

    // A link to a file outside the project is not read.
    const other = tempDir();
    const outside = tempDir();
    writeFiles(outside, { "real.md": INDEX });
    writeFiles(other, { ".socrates/keep": "" });
    symlinkSync(path.join(outside, "real.md"), path.join(other, ".socrates/MEMORY.md"));
    expect(workMemoryBlock(WorkspaceRoot.open("linked", other), null, null)).toBeNull();

    // Newest lines first: past the budget the oldest are cut and the agent is told to tidy.
    const many = tempDir();
    const lines = Array.from({ length: 200 }, (_, i) => `- Topic number ${i} with some words to cost tokens → memory/topic-${i}.md · turns ${i}`);
    writeFiles(many, { ".socrates/MEMORY.md": lines.join("\n") });
    const block = workMemoryBlock(WorkspaceRoot.open("big", many), null, null)!;
    expect(block).toContain("Topic number 0 ");
    expect(block).not.toContain("Topic number 199 ");
    expect(block).toMatch(/\(\d+ older lines not shown: the index is over its budget of 1500 tokens; merge related lines or drop the stalest/);
    expect(block.split("\n").length).toBeLessThan(120);
    expect(WORK_MEMORY_INDEX_MAX_TOKENS).toBe(1_500);
  });
});

describe("which turns are asked about", () => {
  const ev = (tool: string, input: unknown, status: "ok" | "error" = "ok") => ({ taskId: "t", number: 1, handle: "e1", callId: "c", tool, turnId: "x", input, status, result: null, createdAt: "" });

  it("are those with several calls, one of them a change or a command; the decider reads them as lines", () => {
    expect(didRealWork([ev("read", { path: "a" }), ev("grep", { pattern: "x" }), ev("glob", { pattern: "*" })])).toBe(false);
    expect(didRealWork([ev("edit", { path: "a" }), ev("read", { path: "b" })])).toBe(false);
    const calls = [ev("read", { path: "src/schema.ts" }), ev("edit", { path: "src/schema.ts" }), ev("terminal", { command: "pnpm test" }, "error"), ev("terminal", { command: "pnpm test" })];
    expect(didRealWork(calls)).toBe(true);
    expect(workState({ request: "Add a column to the store.", calls, answer: "Done: v8 with an upgrade step." })).toBe(
      "The user asked:\nAdd a column to the store.\n\nWhat the assistant did (tool calls, in order):\n- read src/schema.ts\n- edit src/schema.ts\n- terminal: pnpm test ✗\n- terminal: pnpm test\n\nThe assistant's answer:\nDone: v8 with an upgrade step.",
    );
    const long = workState({ request: "x", calls: Array.from({ length: 60 }, (_, i) => ev("read", { path: `f${i}` })), answer: "y" });
    expect(long).toContain("- read f0");
    expect(long).toContain("- … 36 more calls");
    expect(long).toContain("- read f59");
    expect(long).not.toContain("- read f30");
    expect(WORK_QUESTION.instructions).toContain("repeatable procedure");
  });
});

describe("recording what a turn established", () => {
  const work = [
    { toolCalls: [call("edit", { path: "src/a.ts", old_text: "", new_text: "export const a = 1;\n" }), call("edit", { path: "src/b.ts", old_text: "", new_text: "export const b = 2;\n" }), call("glob", { pattern: "src/*.ts" })] },
    final({ full_answer: "Added a and b; the checks pass." }),
  ];
  const memory = [
    { toolCalls: [
      call("edit", { path: ".socrates/memory/new-module.md", old_text: "", new_text: "New module\nSteps\n1. Add the file.\nEvidence: turns 2\n" }),
      call("edit", { path: ".socrates/MEMORY.md", old_text: "", new_text: "- Add a module → memory/new-module.md · turn 2\n" }),
    ] },
    { text: "Wrote .socrates/memory/new-module.md and the index." },
  ];
  const policy = (root: string) => ({ folders: [root], approvals: "ask" as const, protected: [] });

  it("writes the notes in one extra step when the decider says the work is worth it, without asking, and keeps the answer", async () => {
    const w = await world();
    const { decider, asked } = workDecider(() => 0.9);
    const { socrates, model } = w.socrates([continueTask()], [...work, ...memory], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }), access: () => policy(w.root) });
    const result = await socrates.handle("Add the modules a and b.");

    // The decider read the request, the calls and the answer; the guide came after the answer, with this turn's number.
    expect(asked).toHaveLength(2);
    expect(Object.keys(asked.at(-1)!.questions)).toEqual(["work"]);
    expect(asked.at(-1)!.state).toContain("- edit src/a.ts\n- edit src/b.ts\n- glob \"src/*.ts\"");
    expect(asked.at(-1)!.state).toContain("Added a and b; the checks pass.");
    const turn = w.store.turnsForTask(w.taskId).at(-1)!;
    expect(model.requests).toHaveLength(4);
    const prompt = model.requests[2]!.messages.at(-1)!;
    expect(prompt.role === "user" ? userText(prompt.content) : "").toContain(`this turn is turn ${turn.projectTurn}`);

    expect(readFileSync(path.join(w.root, ".socrates/MEMORY.md"), "utf8")).toBe("- Add a module → memory/new-module.md · turn 2\n");
    expect(existsSync(path.join(w.root, ".socrates/memory/new-module.md"))).toBe(true);
    // The project's own edits asked (ask-first mode); the notes did not.
    expect(w.approvals.map((a) => a.detail)).toEqual(["Create src/a.ts", "Create src/b.ts"]);
    // The user sees the answer the work ended with, not the extra step's sentence.
    expect(result.kind === "answered" && result.text).toBe("Added a and b; the checks pass.");
    expect(w.store.turnsForTask(w.taskId).at(-1)).toMatchObject({ status: "completed" });
  });

  it("does nothing more when the decider says it is not worth it, when the work was small, or with the switches off", async () => {
    for (const setup of [
      { work: 0.1, steps: work, memory: { save: true, use: true }, expected: 2 },
      { work: 0.9, steps: [{ toolCalls: [call("edit", { path: "src/a.ts", old_text: "", new_text: "x\n" })] }, final()], memory: { save: true, use: true }, expected: 0 },
      { work: 0.9, steps: work, memory: { save: false, use: true }, expected: 0 },
    ]) {
      const w = await world();
      const { decider, asked } = workDecider(() => setup.work);
      const { socrates, model } = w.socrates([continueTask()], [...setup.steps, ...memory], { gate: () => new MemoryGate({ decider }), memory: () => setup.memory, access: () => policy(w.root) });
      await socrates.handle("Add the modules a and b.");
      expect(model.requests).toHaveLength(setup.steps.length);
      expect(asked.filter((r) => "work" in r.questions)).toHaveLength(setup.expected ? 1 : 0);
      expect(existsSync(path.join(w.root, ".socrates/MEMORY.md"))).toBe(false);
    }
  });

  it("asks before writing anything but the notes, even in the extra step", async () => {
    const w = await world();
    const { decider } = workDecider(() => 0.9);
    const sneaky = [{ toolCalls: [call("edit", { path: "src/evil.ts", old_text: "", new_text: "x\n" })] }, { text: "Done." }];
    const { socrates } = w.socrates([continueTask()], [...work, ...sneaky], { gate: () => new MemoryGate({ decider }), memory: () => ({ save: true, use: true }), access: () => policy(w.root), approve: false });
    await socrates.handle("Add the modules a and b.");
    expect(w.approvals.map((a) => a.tool)).toContain("edit");
    expect(w.approvals.at(-1)!.detail).toContain("src/evil.ts");
    expect(existsSync(path.join(w.root, "src/evil.ts"))).toBe(false);
  });

  it("carries a guide that names the budget, the files and the turn", () => {
    const guide = workMemorySkill(41);
    expect(guide).toContain("this turn is turn 41");
    expect(guide).toContain(".socrates/memory/<topic>.md");
    expect(guide).toContain(".socrates/MEMORY.md");
    expect(guide).toContain("about 40 lines");
    expect(guide).toContain("Nothing to record.");
  });
});
