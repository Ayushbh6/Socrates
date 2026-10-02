import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelError, type ModelResponse, type EventPayloads } from "@socrates/contracts";
import { ScriptedModel, TokenCalibration } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import { RunState, type ToolRunner } from "@socrates/tools";
import { DEFAULT_LIMITS, runAgent, assembleContext } from "../src";
import { continueTask } from "../../router/test/helpers";
import { call, contextText, final, world } from "./helpers";

const usage = { promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const response = (text: string): ModelResponse => ({ text, toolCalls: [], usage, stopReason: "end" });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("Agent-stage review regressions", () => {
  it("keeps completed historical work completed unless routing explicitly reopens it", async () => {
    const w = await world();
    w.store.reviseTask(w.taskId, { status: "completed" });
    const at = w.store.requireTask(w.taskId).completedAt;
    const h = w.socrates([continueTask(false), continueTask(true)], [final(), final()]);
    await h.socrates.handle("What did you do?");
    expect(w.store.requireTask(w.taskId)).toMatchObject({ status: "completed", completedAt: at });
    await h.socrates.handle("Resume work.");
    expect(w.store.requireTask(w.taskId)).toMatchObject({ status: "open", completedAt: null });
  });

  it.each([false, true])("cancellation racing with a valid final response persists no proposed state (repair=%s)", async repair => {
    const w = await world({ files: { "PLAN.md": "Plan" } });
    const controller = new AbortController();
    const cancelled = () => {
      controller.abort();
      return final({ goal_note: "Must not persist", task_complete: { reason: "Done" }, anchors: [{ path: "PLAN.md", role: "plan", reason: "Durable" }] });
    };
    const h = w.socrates([continueTask()], [...(repair ? [{ text: "Invalid" }] : []), cancelled]);
    const r = await h.socrates.handle("Work", { signal: controller.signal });
    expect(r.kind === "answered" && r.parts[0]!.status).toBe("interrupted");
    expect(w.store.requireTask(w.taskId).status).toBe("open");
    expect(w.store.requireGoal(w.goalId).note).toBeNull();
    expect(w.store.listAnchors(w.goalId)).toEqual([]);
    expect(w.store.listEvents({ type: "agent_message" })).toHaveLength(repair ? 2 : 1);
  });

  it("treats a permanent repair-provider failure as interruption, without displaying the candidate", async () => {
    const w = await world();
    const h = w.socrates([continueTask()], [{ text: "Partial candidate" }, () => { throw new ModelError("bad repair", "invalid_request", 400); }]);
    const r = await h.socrates.handle("Work");
    expect(r.kind === "answered" && r.parts[0]!.status).toBe("interrupted");
    expect(r.text).not.toContain("Partial candidate");
    expect(w.store.listEvents({ type: "agent_warning" }).map(e => e.payload)).toContainEqual({ kind: "model_error", detail: "bad repair" });
  });

  it("refuses unexpected repair tool calls and does not apply their completion proposal", async () => {
    const w = await world({ files: { "a.txt": "alpha" } });
    const h = w.socrates([continueTask()], [{ text: "Invalid" }, { ...final({ task_complete: { reason: "Edited" }, goal_note: "Changed" }), toolCalls: [call("edit", { path: "a.txt", old_text: "alpha", new_text: "beta" })] }]);
    const r = await h.socrates.handle("Edit");
    if (r.kind !== "answered") throw new Error("route");
    expect(w.store.requireTask(w.taskId).status).toBe("open");
    expect(w.store.requireGoal(w.goalId).note).toBeNull();
    expect(readFileSync(path.join(w.root, "a.txt"), "utf8")).toBe("alpha");
    expect(w.store.evidenceForTurn(r.parts[0]!.turn.id)[0]!.result!.error!.code).toBe("cancelled");
    expect(w.store.listEvents({ type: "agent_warning" }).at(-1)!.payload).toMatchObject({ kind: "final_answer_invalid" });
  });

  it("refuses unexpected wrap-up calls and repairs with matching refused tool results", async () => {
    const w = await world({ files: { "a.txt": "alpha" } });
    const h = w.socrates([continueTask()], [
      { toolCalls: [call("edit", { path: "a.txt", old_text: "alpha", new_text: "beta" })], ...final({ task_complete: { reason: "Wrong" } }) },
      final({ full_answer: "No changes were made." }),
    ], { limits: { maxSteps: 0 } });
    await h.socrates.handle("Edit");
    expect(readFileSync(path.join(w.root, "a.txt"), "utf8")).toBe("alpha");
    const repair = h.model.requests[1]!;
    expect(repair.toolChoice).toBe("none");
    expect(repair.messages.some(m => m.role === "tool" && m.isError)).toBe(true);
    expect(w.store.requireTask(w.taskId).status).toBe("open");
  });

  it("finalizes setup failure and permits the following message to run", async () => {
    const w = await world({ workspace: false });
    const h = w.socrates([continueTask(), continueTask()], [final()], { resolveWorkspace: () => { throw new Error("workspace unavailable"); } });
    const r = await h.socrates.handle("Work");
    expect(r.kind === "answered" && r.parts[0]!.turn.status).toBe("interrupted");
    expect(w.store.listEvents({ type: "agent_warning" }).at(-1)!.payload).toMatchObject({ kind: "agent_error" });
    w.store.bindGoalWorkspace(w.goalId, w.store.createWorkspace("fixed", w.root).id);
    expect((await h.socrates.handle("Continue")).text).toBe("Done.");
  });

  it("preserves whitespace in the current user message exactly", async () => {
    const w = await world();
    const h = w.socrates([continueTask()], [final()]);
    const text = "\n    return 42\n\n";
    await h.socrates.handle(text);
    expect(contextText(h.model.requests[0]!)).toContain(`<CURRENT_USER_MESSAGE>\n${text}\n</CURRENT_USER_MESSAGE>`);
  });

  it("persists intermediate and invalid assistant output, replays it and exposes text through inspect", async () => {
    const w = await world({ files: { "a.txt": "alpha" } });
    const marker = "Exact explanation before calling read.";
    const h = w.socrates([continueTask(), continueTask()], [
      { text: marker, toolCalls: [call("read", { path: "a.txt" })] }, { text: "Invalid candidate" }, final(),
      { toolCalls: [call("context_retrieve", { action: "inspect", turn_number: 2 })] }, final(),
    ]);
    await h.socrates.handle("Read");
    const events = w.store.listEvents({ type: "agent_message" });
    expect(events.map(e => (e.payload as EventPayloads["agent_message"]).response.text)).toEqual([marker, "Invalid candidate", final().text]);
    const restored = LedgerStore.open({ path: ":memory:" });
    try { restored.restoreEvents(w.store.listEvents()); expect(restored.listEvents({ type: "agent_message" })).toEqual(events); }
    finally { restored.close(); }
    await h.socrates.handle("Recall the exact explanation");
    expect(h.model.requests[4]!.messages.at(-1)!.content).toContain(marker);
  });

  it("excludes a delayed test from an older turn from a dependent-part handoff", async () => {
    const w = await world();
    const old = w.store.turnsForTask(w.taskId)[0]!;
    w.clock.advance(1000);
    const user = w.store.recordUserMessage("Fix and document");
    const first = w.store.bindTurn({ userEventId: user.id, taskId: w.taskId, route: "compound", partOrder: 1 });
    const task = w.store.createTask(w.goalId, { title: "Docs" });
    const second = w.store.bindTurn({ userEventId: user.id, taskId: task.id, route: "compound", partOrder: 2 });
    w.clock.advance(1000);
    w.store.recordTerminalExited({ task_id: w.taskId, turn_id: old.id }, { session_id: "old", exit_code: 0, signal: null, reason: "exited", facts: [{ kind: "test", value: "OLD test passed" }] });
    w.store.recordTerminalExited({ task_id: w.taskId, turn_id: first.id }, { session_id: "current", exit_code: 1, signal: null, reason: "exited", facts: [{ kind: "test", value: "CURRENT test failed" }] });
    w.store.completeTurn(first.id, { responseEventId: w.store.recordResponse("Done").id, continuationNote: "Tests failed" });
    const text = assembleContext({ store: w.store, turn: second, capabilities: { skills: [], mcpTools: [] }, dependsOn: [{ order: 1, turn: first }], part: { order: 2, count: 2 }, now: w.clock.now(), timeZone: "UTC" }).map(p => p.text).join("");
    expect(text).toContain("CURRENT test failed");
    expect(text).not.toContain("OLD test passed");
  });

  it("ends a slow provider request at the deadline and never executes its late mutation", async () => {
    const w = await world({ files: { "a.txt": "alpha" } });
    const h = w.socrates([continueTask()], [], { limits: { maxWallMs: 25 } });
    h.model.complete = async request => {
      if (request.toolChoice === "none") return response(final({ full_answer: "Stopped on time." }).text);
      await delay(100);
      return { ...response(""), toolCalls: [{ id: "late", ...call("edit", { path: "a.txt", old_text: "alpha", new_text: "beta" }) }] };
    };
    const r = await h.socrates.handle("Edit");
    expect(r.kind === "answered" && r.parts[0]!.stop).toBe("time");
    await delay(120);
    expect(readFileSync(path.join(w.root, "a.txt"), "utf8")).toBe("alpha");
    expect(w.store.listEvents({ type: "agent_message" })).toHaveLength(1);
  });

  it("cancels a pending approval at the turn deadline, consumes late approval without mutating", async () => {
    const w = await world({ files: { "a.txt": "alpha" } });
    const route = { text: continueTask().text.replace('"workspace_confidence":"high"', '"workspace_confidence":"low"') };
    const h = w.socrates([route], [{ toolCalls: [call("edit", { path: "a.txt", old_text: "alpha", new_text: "beta" })] }, final()], { limits: { maxWallMs: 40 } });
    let release!: (approved: boolean) => void;
    const r = await h.socrates.handle("Edit", { approve: () => new Promise(resolve => { release = resolve; }) });
    expect(r.kind === "answered" && r.parts[0]!.stop).toBe("time");
    release(true); await delay(10);
    expect(readFileSync(path.join(w.root, "a.txt"), "utf8")).toBe("alpha");
    expect(w.store.listEvents({ type: "approval_decided" })).toHaveLength(0);
  });

  it("also bounds a provider that hangs during the tool-free finalization", async () => {
    const w = await world();
    const h = w.socrates([continueTask()], [], { limits: { maxWallMs: 20, finalizationMs: 20 } });
    h.model.complete = () => new Promise(() => {});
    const r = await h.socrates.handle("Work");
    expect(r.kind === "answered" && r.parts[0]!.status).toBe("interrupted");
  });
});

async function boundedRun(context: string, steps: ConstructorParameters<typeof ScriptedModel>[1], runner: ToolRunner) {
  const model = new ScriptedModel("test:ceiling", steps);
  const result = await runAgent({ model, runner, calibration: new TokenCalibration(), system: "Test", tools: [], context: [{ text: context }], scope: { binding: { goalId: "g", taskId: "t", chatId: null, turnId: null }, workspace: null, run: new RunState(), signal: new AbortController().signal }, limits: DEFAULT_LIMITS });
  return { result, model };
}

describe("hard provider request ceiling", () => {
  it("uses an honest stored-state fallback after a large result batch instead of sending an oversized wrap-up", async () => {
    const runner = { concurrency: () => "parallel", async run(c: { id: string; name: string }) { return { callId: c.id, name: c.name, content: "word ".repeat(9500), isError: false }; } } as unknown as ToolRunner;
    const { result, model } = await boundedRun("Read files", [{ toolCalls: Array.from({ length: 20 }, () => call("read", { path: "large.txt" })) }], runner);
    expect(result).toMatchObject({ kind: "limited", stop: "context", toolCalls: 20 });
    expect(model.requests).toHaveLength(1);
  });

  it("guards repair after a large invalid candidate", async () => {
    const { result, model } = await boundedRun("word ".repeat(150000), [{ text: "invalid ".repeat(35000) }], {} as ToolRunner);
    expect(result).toMatchObject({ kind: "limited", stop: "context" });
    expect(model.requests).toHaveLength(1);
  });

  it("counts raw provider replay blocks absent from normalized text", async () => {
    const runner = { concurrency: () => "parallel", async run(c: { id: string; name: string }) { return { callId: c.id, name: c.name, content: "ok", isError: false }; } } as unknown as ToolRunner;
    const { result, model } = await boundedRun("word ".repeat(150000), [() => ({ ...response(""), toolCalls: [{ id: "r", ...call("read", { path: "a.txt" }) }], raw: { provider: "test", content: { reasoning: "word ".repeat(35000) } } })], runner);
    expect(result).toMatchObject({ kind: "limited", stop: "context" });
    expect(model.requests).toHaveLength(1);
  });
});
