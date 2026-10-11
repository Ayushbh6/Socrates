import { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { terminalOutputStats } from "../src/observe";

/** The Inspect panel that says whether the shorter terminal preview helps (T1). */
describe("long terminal output stats", () => {
  it("counts outputs cut to a preview, how many were read again by id, and what the reads cost", () => {
    const store = LedgerStore.open({ path: ":memory:" });
    const goal = store.createGoal({ title: "Build", objective: "Build it." });
    const task = store.createTask(goal.id, { title: "Fix the build", objective: "Fix it." });
    const refs = { goal_id: goal.id, task_id: task.id };
    let n = 0;
    const call = (tool: string, input: unknown, result: unknown, content = "{}") => {
      const id = `call_${++n}`;
      const e = store.recordToolCall(refs, { callId: id, tool, input });
      store.recordToolResult(refs, { call_id: id, handle: e.handle, tool, status: "ok", content, result, error: null, diagnostics: null, observed: [], facts: [], wall_time_ms: 1 });
    };
    call("terminal", { command: "pnpm build" }, { output_id: "out_aaaaaaaaaaaa", truncated: true, output: "start\n[… omitted …]\nend\n" });
    call("terminal", { command: "pnpm test" }, { output_id: "out_bbbbbbbbbbbb", truncated: true, output: "ok\n" });
    call("terminal", { command: "echo hi" }, { output_id: "out_cccccccccccc", truncated: false, output: "hi\n" });
    call("terminal_control", { action: "read", output: "out_aaaaaaaaaaaa", search: "error" }, { matches: [] }, JSON.stringify({ matches: [{ line: 4, text: "error TS2304" }] }));
    call("terminal_control", { action: "read", output: "out_aaaaaaaaaaaa", from_line: 1 }, { output: "x" }, "a few tokens of output");
    call("terminal_control", { action: "read", terminal: "svc" }, { output: "live" });
    const stats = terminalOutputStats(store, "all", new Date(), 4_500);
    expect(stats).toMatchObject({ previewTokens: 4_500, longOutputs: 2, readAgain: 1, reads: 2 });
    expect(stats.readTokens).toBeGreaterThan(5);
    expect(stats.previewTokensUsed).toBeGreaterThan(5);
    store.close();
  });
});
