import { describe, expect, it, vi } from "vitest";
import { home, models, SCRIPTED, server } from "./helpers";

describe("saved output completeness in Inspect", () => {
  it.each(["cap", "write_failed", "interrupted", null] as const)("preserves capture state %s separately from display truncation", async (gap) => {
    const { rt, request } = await server(home({ settings: SCRIPTED }), models());
    const store = rt.store;
    const goal = store.createGoal({ title: "Review" });
    const task = store.createTask(goal.id, { title: "Archive" });
    const user = store.recordUserMessage("Run");
    const turn = store.bindTurn({ userEventId: user.id, taskId: task.id, route: "continue_current", gateArmed: false, workspaceConfidence: "high" });
    const refs = { goal_id: goal.id, task_id: task.id, chat_id: turn.chatId, turn_id: turn.id };
    const archive = rt.terminalManager.archive!;
    const capture = archive.begin({ workspace: rt.config.home, session_id: "term-1", name: null, command: "fixture", cwd: rt.config.home, pty: false, background: false, origin: { by: "agent", goalId: goal.id, taskId: task.id, chatId: turn.chatId, turnId: turn.id, label: null } })!;
    capture.write("retained output\n"); capture.meta.gap = gap;
    capture.end({ exit_code: 0, signal: null, reason: "exited" });
    const e = store.recordToolCall(refs, { callId: "fixture", tool: "terminal", input: { command: "fixture" } });
    store.recordToolResult(refs, { call_id: "fixture", handle: e.handle, tool: "terminal", status: "ok", content: "{}", result: { output_id: capture.id, output: "preview" }, error: null, diagnostics: null, observed: [], facts: [], wall_time_ms: 1 });
    const response = await request("GET", `/api/evidence?task=g${goal.number}/t${task.number}&handle=${e.handle}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ content: "retained output\n", truncated: false, outputLost: false, captureComplete: gap === null, captureGap: gap });
  });

  it("cancels active background writers through the actual settings endpoint", async () => {
    const { rt, request } = await server(home({ settings: SCRIPTED }), models());
    const cancel = vi.spyOn(rt.socrates!, "cancelWorkMemory");
    const response = await request("PUT", "/api/settings", { memory: { save: false } });
    expect(response.statusCode).toBe(200);
    expect(rt.settings.memory.save).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
