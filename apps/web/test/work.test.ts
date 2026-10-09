import { describe, expect, it } from "vitest";
import { type Exchange, emptyModel, reduce } from "../src/lib/model";
import type { CallView, ServerMessage } from "../src/lib/types";
import { arriving, callCounts, callFailed, callVerb, groupLabel, thoughtLabel, waitingLine, workSegments, workSummary } from "../src/lib/work";

const at = "2026-10-04T10:00:00Z";
let seq = 500;
const run = (...messages: ServerMessage[]) => messages.reduce((m, message) => reduce(m, { type: "server", message }), emptyModel());
const act = (body: Record<string, unknown>, time = at): ServerMessage => ({ type: "activity", seq: ++seq, at: time, conversation: "main", ...body } as ServerMessage);
const call = (kind: CallView["kind"], verb: string, target: string): CallView => ({ kind, verb, active: `${verb}ing`, target, detail: null });
const CALLS: Record<string, CallView> = {
  read: call("read", "Read", "a.ts"),
  read2: call("read", "Read", "b.ts"),
  test: { ...call("terminal", "Ran", "npm test"), active: "Running" },
  enter: call("terminal", "Pressed", "Enter"),
  edit: call("edit", "Edited", "a.ts"),
};
const tool = (handle: string, name: keyof typeof CALLS): Record<string, unknown> => ({ kind: "tool_started", turnId: "t1", task: "g1/t1", handle, line: name, call: CALLS[name] });
const done = (handle: string, result: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: "tool_finished", turnId: "t1", task: "g1/t1", handle, status: "ok", result: { summary: null, preview: "", truncated: false, diff: null, verb: null, ms: 20, ...result } });
const routed = () => act({ kind: "routed", turnId: "t1", projectTurn: 1, goal: { number: 1, title: "G" }, task: { number: 1, title: "T" }, lane: null });
const exchange = (...messages: ServerMessage[]): Exchange => run(act({ kind: "message", text: "Why?" }), routed(), ...messages).conversations.main!.at(-1)!;
const shape = (e: Exchange) => workSegments(e).map((s) => (s.kind === "group" ? s.items.map((i) => (i.kind === "tool" ? i.step.handle : "thought")).join("+") : s.kind));

describe("the work behind an answer", () => {
  it("puts everything between two lines of narration into one group, as Codex does", () => {
    const e = exchange(
      act({ kind: "step", turnId: "t1", text: "Reading both files.", thinking: "**Plan** read then test", thinkingTruncated: false }),
      act(tool("e1", "read")), act(tool("e2", "read2")), act(tool("e3", "test")),
      act({ kind: "step", turnId: "t1", text: "", thinking: "Tests pass.", thinkingTruncated: false }),
      act(tool("e4", "edit")),
      act({ kind: "step", turnId: "t1", text: "Now the docs.", thinking: null }),
      act({ kind: "warning", turnId: "t1", detail: "Careful" }),
    );
    expect(shape(e)).toEqual(["thought", "narration", "e1+e2+e3+thought+e4", "narration", "meta"]);
  });

  it("labels a group by what its calls did, and a group that only thought by how long", () => {
    const ok = (c: CallView) => ({ call: c, status: "ok" as const });
    expect(callCounts([CALLS.read!, CALLS.read!, CALLS.read2!, CALLS.test!, CALLS.enter!, CALLS.edit!].map(ok))).toEqual(["Read 2 files", "Ran 1 command", "Edited 1 file"]);
    expect(callCounts([CALLS.enter!, call("terminal", "Waited for", "configure")].map(ok))).toEqual(["Worked in 2 terminals"]);
    expect(callCounts([call("search", "Searched for", "x")].map(ok))).toEqual(["Searched once"]);
  });

  it("never counts a failed call as done, and puts every failure, of any kind, in one last part", () => {
    const failed = (c: CallView) => ({ call: c, status: "error" as const });
    expect(callCounts([failed(CALLS.test!)])).toEqual(["1 tool call failed"]);
    expect(callCounts([{ call: CALLS.test!, status: "ok" }, failed(CALLS.test!), failed(CALLS.edit!), { call: CALLS.read!, status: "running" }, failed(CALLS.read2!)])).toEqual(["Ran 1 command", "Read 1 file", "3 tool calls failed"]);
    // A command that ran and exited non-zero is a failure like any other.
    const exited = { call: CALLS.test!, status: "ok" as const, result: { summary: "exit 1", preview: "", truncated: false, diff: null, verb: null, ms: 10, failed: true } };
    expect(callCounts([exited, { call: CALLS.read!, status: "ok" }])).toEqual(["Read 1 file", "1 tool call failed"]);
    expect(callFailed(exited)).toBe(true);
    const e = exchange(act(tool("e1", "read")), act(tool("e2", "test")));
    const group = workSegments(e)[0]!;
    expect(group.kind === "group" && groupLabel(group.items)).toBe("Read 1 file, ran 1 command");
    expect(groupLabel([{ kind: "thinking", text: "a", truncated: false, live: false, ms: 4_000 }, { kind: "thinking", text: "b", truncated: false, live: false, ms: 2_400 }])).toBe("Thought for 6s");
    expect(thoughtLabel(null)).toBe("Thought");
  });

  it("times each thought from the work before it", () => {
    const e = exchange(
      act({ kind: "step", turnId: "t1", text: "", thinking: "First.", thinkingTruncated: false }, "2026-10-04T10:00:07Z"),
      act(tool("e1", "read"), "2026-10-04T10:00:07Z"), act(done("e1"), "2026-10-04T10:00:08Z"),
      act({ kind: "step", turnId: "t1", text: "", thinking: "Second.", thinkingTruncated: false }, "2026-10-04T10:00:20Z"),
    );
    expect(e.steps.flatMap((s) => (s.kind === "thinking" ? [s.ms] : []))).toEqual([7_000, 12_000]);
  });

  it("shows a running call's output until its result replaces it", () => {
    let m = run(act({ kind: "message", text: "Install" }), routed(), act(tool("e1", "test")));
    m = reduce(m, { type: "server", message: { type: "draft", conversation: "main", turnId: "t1", call: 1, kind: "output", handle: "e1", text: "added 12 packages\n" } });
    let e = m.conversations.main![0]!;
    const item = (x: Exchange) => { const g = workSegments(x)[0]!; return g.kind === "group" ? g.items[0]! : null; };
    expect(item(e)).toMatchObject({ kind: "tool", output: "added 12 packages\n" });
    expect(callVerb(e.steps[0] as never)).toBe("Running");
    expect(arriving(e)).toBe(true);
    m = reduce(m, { type: "server", message: act(done("e1", { summary: "exit 0" })) });
    e = m.conversations.main![0]!;
    expect(e.outputs).toEqual({});
    expect(item(e)).toMatchObject({ kind: "tool", output: null, step: { status: "ok", result: { summary: "exit 0" } } });
    // Output that arrives after the result is not shown again.
    m = reduce(m, { type: "server", message: { type: "draft", conversation: "main", turnId: "t1", call: 1, kind: "output", handle: "e1", text: "late" } });
    expect(m.conversations.main![0]!.outputs).toEqual({});
    expect(arriving(m.conversations.main![0]!)).toBe(false);
  });

  it("says what it waits on before anything arrives", () => {
    const sent = run(act({ kind: "message", text: "Why?" })).conversations.main![0]!;
    expect(waitingLine(sent)).toBe("Reading your message");
    expect(waitingLine(exchange())).toBe("Thinking");
    expect(arriving(exchange())).toBe(false);
  });

  it("uses the result's own verb once it knows it", () => {
    const e = exchange(act(tool("e1", "edit")), act(done("e1", { verb: "Created", summary: "+3 −0" })));
    expect(callVerb(e.steps[0] as never)).toBe("Created");
  });

  it("adds what is arriving now, thinking and narration, at the end while it works", () => {
    const e = run(
      act({ kind: "message", text: "Why?" }), routed(), act(tool("e1", "read")),
      { type: "draft", conversation: "main", turnId: "t1", call: 2, kind: "thinking", text: "Now the tests" },
    ).conversations.main!.at(-1)!;
    const last = workSegments(e).at(-1)!;
    expect(last.kind === "group" && last.items.at(-1)).toEqual({ kind: "thinking", text: "Now the tests", truncated: false, live: true, ms: null });
    const writing = { ...e, draft: { turnId: "t1", call: 2, kind: "answer" as const, text: "Because" } };
    const thought = workSegments(writing).at(-1)!;
    expect(thought.kind === "group" && thought.items.at(-1)).toMatchObject({ kind: "thinking", live: false });
    expect(workSegments({ ...e, state: "done" }).flatMap((s) => (s.kind === "group" ? s.items : [])).some((i) => i.kind === "thinking")).toBe(false);
  });

  it("folds into one line: how long, whether it thought, and the calls by kind", () => {
    const e = exchange(
      act({ kind: "step", turnId: "t1", text: "", thinking: "Hmm.", thinkingTruncated: false }, "2026-10-04T10:00:05Z"),
      act(tool("e1", "read"), "2026-10-04T10:00:06Z"), act(tool("e2", "read2"), "2026-10-04T10:00:07Z"), act(tool("e3", "test"), "2026-10-04T10:01:14Z"),
      act({ kind: "answer", turnId: "t1", text: "Done." }), act({ kind: "finished", turnId: "t1", status: "completed", reason: null }),
    );
    expect(workSummary(workSegments(e), e)).toBe("Worked for 1m 14s · thought · read 2 files · ran 1 command");
    expect(workSummary(workSegments(e), { ...e, workedAt: null })).toBe("Thought · read 2 files · ran 1 command");
    expect(workSummary(workSegments(e), { ...e, state: "working", answers: [] }, Date.parse("2026-10-04T10:00:09Z"))).toBe("Working for 9s · thought · read 2 files · ran 1 command");
    // Once the answer is being written, the clock stops at the last step.
    expect(workSummary(workSegments(e), { ...e, state: "working" }, Date.parse("2026-10-04T10:05:00Z"))).toBe("Worked for 1m 14s · thought · read 2 files · ran 1 command");
  });
});
