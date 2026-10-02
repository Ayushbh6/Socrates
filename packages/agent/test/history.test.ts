import type { EventPayloads } from "@socrates/contracts";
import { countTokens, fixedClock } from "@socrates/shared";
import { LedgerStore, type TaskRefs } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { PREVIOUS_TURN_BUDGET_TOKENS, TRIM_FLOOR_TOKENS, renderExchangeTurn, renderFullTurn } from "../src";

function turnWith(calls: { tool: string; input: unknown; content: string; result?: unknown; status?: "ok" | "error" }[]) {
  const store = LedgerStore.open({ path: ":memory:", clock: fixedClock("2026-09-01T10:00:00Z") });
  const goal = store.createGoal({ title: "Memory work", objective: "Never lose information." });
  const task = store.createTask(goal.id, { title: "Fix compaction", objective: "Keep large results." });
  const user = store.recordUserMessage("Why are the memory tests failing?");
  const turn = store.bindTurn({ userEventId: user.id, taskId: task.id, route: "continue_current" });
  const refs: TaskRefs = { goal_id: goal.id, task_id: task.id, chat_id: turn.chatId, turn_id: turn.id };
  calls.forEach((c, i) => {
    const ev = store.recordToolCall(refs, { callId: `c${i}`, tool: c.tool, input: c.input });
    const payload: EventPayloads["tool_completed"] = {
      call_id: `c${i}`, handle: ev.handle, tool: c.tool, status: c.status ?? "ok", content: c.content, result: c.result ?? null,
      error: c.status === "error" ? { code: "command_failed", message: "failed", correction: "fix it", retryable: true } : null,
      diagnostics: null, observed: [], facts: [], wall_time_ms: 1,
    };
    store.recordToolResult(refs, payload);
  });
  const response = store.recordResponse("Two tests fail because compact_history() drops source_ref.");
  store.completeTurn(turn.id, { responseEventId: response.id, continuationNote: "Found the cause." });
  return { store, turn: store.requireTurn(turn.id) };
}

/** A file read of about `tokens` tokens. */
function readOf(file: string, tokens: number) {
  const line = (i: number) => `${i}: const value${i} = computeSomething(${i}, "${file}");`;
  let lines = Array.from({ length: Math.ceil(tokens / 19) }, (_, i) => line(i + 1));
  while (countTokens(lines.join("\n")) < tokens) lines = Array.from({ length: Math.ceil(lines.length * 1.1) }, (_, i) => line(i + 1));
  return { tool: "read", input: { path: file }, content: `${file} — lines 1–${lines.length} of ${lines.length}\n${lines.join("\n")}`, result: { path: file, lines: [{ number: 1 }, { number: lines.length }], total_lines: lines.length } };
}
const edit = (file: string) => ({ tool: "edit", input: { path: file, old_text: "a", new_text: "b" }, content: "{}", result: { path: file, diff: `--- a/${file}\n+++ b/${file}\n-a\n+b\n+c` } });
const grep = (pattern: string) => ({ tool: "grep", input: { pattern }, content: JSON.stringify({ matches: Array(50).fill("x.ts:1: match"), returned: 50 }), result: { returned: 50 } });
const passingTest = { tool: "terminal", input: { command: "pytest tests/memory" }, content: "x".repeat(4000), result: { status: "completed", exit_code: 0, output: "....\n24 passed" } };

describe("turn N−1 fitting", () => {
  it("keeps a turn that fits unchanged", () => {
    const { store, turn } = turnWith([readOf("a.ts", 500), edit("a.ts")]);
    const text = renderFullTurn(store, turn);
    expect(text).toContain("TOOL CALL [e1] read");
    expect(text).toContain("TOOL CALL [e2] edit");
    expect(text).toContain("const value1 = computeSomething");
    expect(text.startsWith(`[TURN ${turn.projectTurn} — full]\nUSER:\nWhy are the memory tests failing?`)).toBe(true);
    expect(text.endsWith("SOCRATES:\nTwo tests fail because compact_history() drops source_ref.")).toBe(true);
  });

  it("collapses reproducible calls, then trims the largest reads evenly (the 35k example)", () => {
    const { store, turn } = turnWith([readOf("a.ts", 9000), readOf("b.ts", 9000), readOf("c.ts", 9000), edit("x.ts"), edit("y.ts"), grep("source_ref"), grep("compact"), passingTest]);
    const text = renderFullTurn(store, turn);
    expect(countTokens(text)).toBeLessThanOrEqual(PREVIOUS_TURN_BUDGET_TOKENS);
    expect(text).toContain("TOOL CALL [e4] edit x.ts (+2 −1)");
    expect(text).toContain('TOOL CALL [e6] grep "source_ref" → 50 matches');
    expect(text).toContain('TOOL CALL [e8] terminal: pytest tests/memory → exit 0 · last line: "24 passed"');
    // All three reads stay visible, each trimmed with its handle.
    for (const handle of ["e1", "e2", "e3"]) expect(text).toContain(`context_retrieve inspect ${handle} returns the complete result`);
    for (const file of ["a.ts", "b.ts", "c.ts"]) expect(text).toContain(`computeSomething(1, "${file}")`);
    expect(text).toContain("SOCRATES:\nTwo tests fail");
  });

  it("collapses a read of a file the same turn changed later", () => {
    const { store, turn } = turnWith([readOf("a.ts", 12000), edit("a.ts"), readOf("b.ts", 12000)]);
    const text = renderFullTurn(store, turn);
    expect(text).toContain("TOOL CALL [e1] read a.ts (lines 1–");
    expect(text).toContain("— changed later in this turn");
    expect(text).toContain('computeSomething(1, "b.ts")');
  });

  it("keeps a failed command's head and tail, and collapses the oldest calls when the floor is not enough", () => {
    const failing = { tool: "terminal", input: { command: "npm test" }, status: "ok" as const, content: `HEAD-LINE\n${"noise line\n".repeat(6000)}TAIL-LINE`, result: { status: "completed", exit_code: 1 } };
    const { store, turn } = turnWith([failing]);
    const trimmed = renderFullTurn(store, turn, 3000);
    expect(trimmed).toContain("HEAD-LINE");
    expect(trimmed).toContain("TAIL-LINE");

    const many = turnWith(Array.from({ length: 6 }, (_, i) => readOf(`f${i}.ts`, 3000)));
    const text = renderFullTurn(many.store, many.turn, 6000);
    expect(countTokens(text)).toBeLessThanOrEqual(6000 + 200);
    expect(text).toContain("TOOL CALL [e1] read f0.ts (lines 1–");
    expect(text).toContain('computeSomething(1, "f5.ts")');
    expect(TRIM_FLOOR_TOKENS).toBe(1500);
  });

  it("renders older turns as the request and answer only", () => {
    const { store, turn } = turnWith([readOf("a.ts", 100)]);
    expect(renderExchangeTurn(store, turn)).toBe(`[TURN ${turn.projectTurn}]\nUSER:\nWhy are the memory tests failing?\n\nSOCRATES:\nTwo tests fail because compact_history() drops source_ref.`);
  });
});
