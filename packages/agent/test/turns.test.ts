import { readFileSync } from "node:fs";
import path from "node:path";
import { type EventPayloads, ModelError } from "@socrates/contracts";
import { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { continueTask, createGoal, decision, defineTask, general } from "../../router/test/helpers";
import { call, contextParts, contextText, final, world } from "./helpers";

/** A compound route: part 1 continues the current task, part 2 creates a task that depends on it. */
function compound() {
  const part = (order: number, extra: object) => ({
    order,
    request: order === 1 ? "Fix a.txt" : "write the docs",
    goal_label: "current",
    new_goal_title: null,
    task_label: null,
    new_task_title: null,
    workspace_confidence: "high",
    reason: "r",
    depends_on: order === 2 ? [1] : [],
    ...extra,
  });
  return {
    text: decision({
      decision: "compound",
      workspace_confidence: null,
      parts: [
        part(1, { decision: "continue_current", task_decision: "continue_task", task_label: "current" }),
        part(2, { decision: "continue_current", task_decision: "create_task", new_task_title: "Write the docs", ...defineTask("Write the docs") }),
      ] as never,
    }),
  };
}

describe("turn lifecycle", () => {
  it("attaches history in three tiers and keeps everything before the in-flight turn byte-stable", async () => {
    const w = await world({ files: { "a.txt": "alpha\n" } });
    const first = w.socrates([continueTask()], [{ toolCalls: [call("read", { path: "a.txt" })] }, final({ full_answer: "a.txt says alpha." })]);
    await first.socrates.handle("What does a.txt say?");
    await first.socrates.close();

    const second = w.socrates([continueTask()], [{ toolCalls: [call("grep", { pattern: "alpha" })] }, final({ full_answer: "Found it." })]);
    await second.socrates.handle("Where is alpha?");
    const [step1, step2] = second.model.requests;
    const text = contextText(step1!);
    expect(text).toContain("[TURN 1]\nUSER:\nStart the project work.\n\nSOCRATES:\nStarted.");
    expect(text).toContain("[TURN 2 — full]\nUSER:\nWhat does a.txt say?\n\nTOOL CALL [e1] read");
    expect(text).not.toContain("[TURN 1 — full]");

    // Within the turn, the assembled context never changes; only the rolling breakpoint moves.
    expect(contextParts(step2!).map((p) => p.text)).toEqual(contextParts(step1!).map((p) => p.text));
    const marks = (r: typeof step1) => r!.messages.flatMap((m) => (m.role === "user" && typeof m.content !== "string" ? m.content.filter((p) => p.cache).map((p) => p.text.slice(0, 14)) : m.role === "tool" && m.cache ? ["tool"] : []));
    expect(marks(step1)).toEqual(["[TURN 1]\nUSER:", "[TURN 2 — full", "<GOAL_STATE>\nn"]);
    expect(marks(step2)).toEqual(["[TURN 1]\nUSER:", "[TURN 2 — full", "tool"]);
    // Across turns, the goal-stable block is identical.
    expect(contextParts(step1!)[0]!.text).toBe(contextParts(first.model.requests[0]!)[0]!.text);
  });

  it("runs dependent compound parts in order with a bounded evidence handoff", async () => {
    const w = await world({ files: { "a.txt": "alpha\n" } });
    const { socrates, model } = w.socrates([compound()], [
      { toolCalls: [call("edit", { path: "a.txt", old_text: "alpha", new_text: "beta" })] },
      final({ full_answer: "Fixed a.txt.", continuation_note: "a.txt now says beta." }),
      { toolCalls: [call("context_retrieve", { action: "inspect", ref: "g1/t1/e1" })] },
      final({ full_answer: "Docs written." }),
    ]);
    const acknowledgments: string[] = [];
    const result = await socrates.handle("Fix a.txt, then write the docs", { onAcknowledgment: (t) => acknowledgments.push(t) });
    expect(acknowledgments).toEqual(["Two things here — I'll do Fix the server first, then Write the docs."]);
    expect(result).toMatchObject({ kind: "answered", text: "Two things here — I'll do Fix the server first, then Write the docs.\n\n**1. Fix the server**\n\nFixed a.txt.\n\n**2. Write the docs**\n\nDocs written." });

    const part2 = contextText(model.requests[2]!);
    expect(part2).toContain('<EVIDENCE_FROM_PART_1 task="Fix the server">\nfiles_changed: a.txt\nnote: a.txt now says beta.\nevidence: g1/t1/e1 (edit)');
    expect(part2).toContain('this_turn: part 2 of 2 of the user\'s message — "write the docs"');
    expect(part2).toContain("<CURRENT_USER_MESSAGE>\nFix a.txt, then write the docs\n</CURRENT_USER_MESSAGE>");
    // Part 2 has clean history: it is a new task.
    expect(part2).not.toContain("[TURN");
    // The qualified handle opens part 1's evidence from part 2's task.
    expect(model.requests[3]!.messages.at(-1)!.content).toContain('"ref":"e1"');
    expect(model.requests[3]!.messages.at(-1)).not.toMatchObject({ isError: true });

    const exchange = w.store.recentExchanges().next().value!;
    expect(exchange.response).toBe("Fixed a.txt.\n\nDocs written.");
    expect(readFileSync(path.join(w.root, "a.txt"), "utf8")).toBe("beta\n");
  });

  it("does not start later parts after an interrupted part", async () => {
    const w = await world();
    const { socrates } = w.socrates([compound()], [
      () => {
        throw new ModelError("bad", "invalid_request", 400);
      },
    ]);
    const result = await socrates.handle("Fix a.txt, then write the docs");
    if (result.kind !== "answered") throw new Error("expected an answer");
    expect(result.parts.map((p) => [p.status, p.turn.status])).toEqual([
      ["interrupted", "interrupted"],
      ["interrupted", "interrupted"],
    ]);
    expect(result.text).toContain("**2. Write the docs**\n\nNot started.");
  });

  it("accepts durable anchor proposals as provisional and records rejections", async () => {
    const w = await world({ files: { "PLAN.md": "# Plan\n", "node_modules/x/index.js": "x" } });
    const anchors = [
      { path: "PLAN.md", role: "goal_plan", reason: "Defines the plan." },
      { path: "missing.md", role: "spec", reason: "Spec." },
      { path: "node_modules/x/index.js", role: "dependency", reason: "Used." },
    ];
    const { socrates } = w.socrates([continueTask(), continueTask()], [final({ anchors }), final()]);
    await socrates.handle("Write the plan.");
    expect(w.store.listAnchors(w.goalId)).toMatchObject([{ path: "PLAN.md", role: "goal_plan", status: "provisional", summary: "Defines the plan." }]);
    const warnings = w.store.listEvents({ type: "agent_warning" }).map((e) => (e.payload as EventPayloads["agent_warning"]).detail);
    expect(warnings).toEqual(["missing.md (spec): not an existing file of the workspace", "node_modules/x/index.js (dependency): temporary or generated files are not anchors"]);
  });

  it.each(["workspace", "acknowledgment"])("finalizes every compound part after a %s setup failure", async failure => {
    const w = await world({ workspace: false });
    const { socrates, model } = w.socrates([compound()], [], {
      ...(failure === "workspace" ? { resolveWorkspace: () => { throw new Error("Unavailable workspace"); } } : {}),
    });
    const result = await socrates.handle("Fix a.txt, then write the docs", {
      ...(failure === "acknowledgment" ? { onAcknowledgment: () => { throw undefined; } } : {}),
    });
    if (result.kind !== "answered") throw new Error("route");
    expect(result.parts.map(p => p.turn.status)).toEqual(["interrupted", "interrupted"]);
    expect(model.requests).toHaveLength(0);
  });

  it("rolls back the response and anchor revisions if final persistence fails", async () => {
    const w = await world({ files: { "PLAN.md": "Plan" } });
    const { socrates } = w.socrates([continueTask()], [final({ anchors: [{ path: "PLAN.md", role: "goal_plan", reason: "Durable" }], task_complete: { reason: "Done" } })]);
    const complete = w.store.completeTurn.bind(w.store);
    w.store.completeTurn = () => { throw new Error("Projection failure"); };
    try {
      const result = await socrates.handle("Plan the work");
      if (result.kind !== "answered") throw new Error("route");
      expect(result.parts[0]!.status).toBe("interrupted");
      expect(w.store.listEvents({ type: "assistant_response", turnId: result.parts[0]!.turn.id })).toEqual([]);
      expect(w.store.listAnchors(w.goalId)).toEqual([]);
      expect(w.store.requireTask(w.taskId).status).toBe("open");
    } finally { w.store.completeTurn = complete; }
  });

  it("gives the general task recent activity and ignores goal state and completion", async () => {
    const w = await world();
    const { socrates, model } = w.socrates([general()], [final({ full_answer: "Hi! Last time we started the server work.", goal_note: "chatty", task_complete: { reason: "greeted" } })]);
    await socrates.handle("Hi, how's it going?");
    const text = contextText(model.requests[0]!);
    expect(text).toContain("<RECENT_ACTIVITY>");
    expect(text).toContain("Project work · Fix the server");
    expect(text).not.toContain("<CURRENT_TASK>");
    expect(text).not.toContain("<GOAL_STATE>");
    const generalGoal = w.store.getGeneralGoal()!;
    expect(generalGoal.note).toBeNull();
    expect(w.store.listTasks(generalGoal.id)[0]!.status).toBe("open");
  });

  it("groups the general conversation by day, and lets standard mode continue a day but not start one", async () => {
    const w = await world();
    const { socrates } = w.socrates([general(), general()], [final(), final(), final()]);
    await socrates.handle("Hi!");
    const today = w.store.listTasks(w.store.getGeneralGoal()!.id)[0]!;
    expect(today.title).toBe("General · Tue 1 Sept");
    w.clock.advance(24 * 60 * 60 * 1000);
    const next = await socrates.handle("What's the date?");
    expect(next).toMatchObject({ kind: "answered", parts: [{ task: { title: "General · Wed 2 Sept" } }] });
    expect(await socrates.handle("One more thing from yesterday.", { target: { taskId: today.id } })).toMatchObject({ kind: "answered", parts: [{ task: { id: today.id } }] });
    await expect(socrates.handle("A new chat.", { target: { goalId: today.goalId, title: "New" } })).rejects.toThrow(/cannot be started in the general conversation/);
  });

  it("restores interrupted and completed turns from the event log alone", async () => {
    const w = await world();
    const controller = new AbortController();
    const { socrates } = w.socrates([continueTask(), continueTask()], [
      final({ full_answer: "One." }),
      () => {
        controller.abort();
        return { text: "" };
      },
    ]);
    await socrates.handle("First.");
    await socrates.handle("Second.", { signal: controller.signal });
    const restored = LedgerStore.open({ path: ":memory:" });
    restored.restoreEvents(w.store.listEvents());
    const statuses = (s: LedgerStore) => s.turnsForTask(w.taskId).map((t) => t.status);
    expect(statuses(restored)).toEqual(statuses(w.store));
    expect(statuses(restored)).toEqual(["completed", "completed", "interrupted"]);
    const interrupted = restored.turnsForTask(w.taskId).at(-1)!;
    expect(restored.interruption(interrupted.id)).toMatchObject({ reason: "cancelled", tool_calls: 0 });
    restored.close();
  });

  it("renders an interrupted turn honestly in the next turn's history", async () => {
    const w = await world();
    const controller = new AbortController();
    const first = w.socrates([continueTask()], [
      () => {
        controller.abort();
        return { text: "" };
      },
    ]);
    await first.socrates.handle("Do the long thing.", { signal: controller.signal });
    const second = w.socrates([continueTask()], [final()]);
    await second.socrates.handle("Continue.");
    const text = contextText(second.model.requests[0]!);
    expect(text).toContain("USER:\nDo the long thing.\n\nSOCRATES:\n(The user stopped this turn after 0 tool calls; no answer was given.)");
    expect(text).toContain("note: Interrupted by the user after 0 tool calls.");
  });

  it("binds the application's workspace to a new goal before the agent runs", async () => {
    const w = await world({ files: { "notes.txt": "hello\n" } });
    const { socrates, model } = w.socrates([createGoal("Notes", "Read the notes")], [{ toolCalls: [call("read", { path: "notes.txt" })] }, final()], {
      resolveWorkspace: () => ({ name: "project", rootPath: w.root }),
    });
    const result = await socrates.handle("Start a new notes project and read notes.txt.");
    const goal = result.kind === "answered" ? w.store.requireGoal(result.parts[0]!.turn.goalId!) : null;
    expect(w.store.getWorkspace(goal!.workspaceId!)).toMatchObject({ name: "project", rootPath: w.root });
    expect(model.requests[1]!.messages.at(-1)!.content).toContain("hello");
  });

  it("the main conversation handles one message at a time", async () => {
    const w = await world();
    const { socrates } = w.socrates([continueTask(), continueTask()], [final(), final()]);
    const running = socrates.handle("One.");
    expect(socrates.busy).toBe(true);
    await expect(socrates.handle("Two.")).rejects.toMatchObject({ name: "SocratesBusyError", reason: "main_busy" });
    await running;
    expect(socrates.busy).toBe(false);
  });
});
