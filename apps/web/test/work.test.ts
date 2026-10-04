import { describe, expect, it } from "vitest";
import { type Exchange, emptyModel, reduce } from "../src/lib/model";
import type { ServerMessage } from "../src/lib/types";
import { groupLabel, toolGroup, workSegments, workSummary } from "../src/lib/work";

const at = "2026-10-04T10:00:00Z";
let seq = 500;
const run = (...messages: ServerMessage[]) => messages.reduce((m, message) => reduce(m, { type: "server", message }), emptyModel());
const act = (body: Record<string, unknown>, time = at): ServerMessage => ({ type: "activity", seq: ++seq, at: time, conversation: "main", ...body } as ServerMessage);
const tool = (handle: string, line: string): Record<string, unknown> => ({ kind: "tool_started", turnId: "t1", task: "g1/t1", handle, line });
const exchange = (...messages: ServerMessage[]): Exchange => run(act({ kind: "message", text: "Why?" }), act({ kind: "routed", turnId: "t1", projectTurn: 1, goal: { number: 1, title: "G" }, task: { number: 1, title: "T" }, lane: null }), ...messages).conversations.main!.at(-1)!;

describe("the work behind an answer", () => {
  it("knows each tool's kind from its line", () => {
    expect(["read a.ts", "grep \"x\" in src", "glob \"*.ts\"", "edit a.ts", "apply_patch a.ts, b.ts", "terminal: npm test", "terminal_control {}", "context_retrieve {}", "capability_search {}", "demo.create {}"].map(toolGroup))
      .toEqual(["read", "search", "search", "edit", "edit", "terminal", "terminal", "memory", "capability", "other"]);
    expect(groupLabel("read", [{ line: "read a" }, { line: "read b" }])).toBe("Read 2 files");
    expect(groupLabel("terminal", [{ line: "terminal: ls" }, { line: "terminal_control {}" }])).toBe("Ran 1 command");
    expect(groupLabel("terminal", [{ line: "terminal_control {}" }])).toBe("Checked 1 command");
  });

  it("puts thinking first, groups calls of one kind in a row, and keeps narration and other kinds apart", () => {
    const e = exchange(
      act({ kind: "step", turnId: "t1", text: "Reading both files.", thinking: "**Plan** read then test", thinkingTruncated: false }),
      act(tool("e1", "read a.ts")), act(tool("e2", "read b.ts")), act(tool("e3", "terminal: npm test")), act(tool("e4", "read c.ts")),
    );
    expect(workSegments(e).map((s) => s.kind === "tools" ? `${s.group}:${s.steps.length}` : s.kind)).toEqual(["thinking", "narration", "read:2", "terminal:1", "read:1"]);
  });

  it("adds what is arriving now, thinking and narration, at the end while it works", () => {
    const e = run(
      act({ kind: "message", text: "Why?" }),
      act({ kind: "routed", turnId: "t1", projectTurn: 1, goal: { number: 1, title: "G" }, task: { number: 1, title: "T" }, lane: null }),
      act(tool("e1", "read a.ts")),
      { type: "draft", conversation: "main", turnId: "t1", call: 2, kind: "thinking", text: "Now the tests" },
    ).conversations.main!.at(-1)!;
    expect(workSegments(e).at(-1)).toEqual({ kind: "thinking", text: "Now the tests", truncated: false, live: true });
    expect(workSegments({ ...e, state: "done" }).some((s) => s.kind === "thinking")).toBe(false);
  });

  it("folds into one line: how long, whether it thought, and the calls by kind", () => {
    const e = exchange(
      act({ kind: "step", turnId: "t1", text: "", thinking: "Hmm.", thinkingTruncated: false }, "2026-10-04T10:00:05Z"),
      act(tool("e1", "read a.ts"), "2026-10-04T10:00:06Z"), act(tool("e2", "read b.ts"), "2026-10-04T10:00:07Z"), act(tool("e3", "terminal: npm test"), "2026-10-04T10:01:14Z"),
      act({ kind: "answer", turnId: "t1", text: "Done." }), act({ kind: "finished", turnId: "t1", status: "completed", reason: null }),
    );
    expect(workSummary(workSegments(e), e)).toBe("Worked for 1m 14s · thought · read 2 files · ran 1 command");
    expect(workSummary(workSegments(e), { ...e, workedAt: null })).toBe("Thought · read 2 files · ran 1 command");
    expect(workSummary(workSegments(e), { ...e, state: "working", answers: [] }, Date.parse("2026-10-04T10:00:09Z"))).toBe("Working for 9s · thought · read 2 files · ran 1 command");
    // Once the answer is being written, the clock stops at the last step.
    expect(workSummary(workSegments(e), { ...e, state: "working" }, Date.parse("2026-10-04T10:05:00Z"))).toBe("Worked for 1m 14s · thought · read 2 files · ran 1 command");
  });
});
