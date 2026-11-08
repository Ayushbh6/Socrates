import { describe, expect, it } from "vitest";
import { type Model, emptyModel, reduce } from "../src/lib/model";
import { STRAND_RECENT_MS, strands } from "../src/lib/strands";
import type { Activity, ActivityBody, ServerMessage } from "../src/lib/types";
import { line } from "../src/components/Strands";

let seq = 0;
const at = "2026-11-08T10:00:00Z";
const now = Date.parse(at) + 90_000;
const act = (conversation: string, body: ActivityBody, when = at): ServerMessage => ({ type: "activity", seq: ++seq, at: when, conversation, ...body } as { type: "activity" } & Activity);
const run = (model: Model, ...messages: ServerMessage[]) => messages.reduce((m, message) => reduce(m, { type: "server", message }), model);
const route = (task: string) => ({ goal: { number: 2, title: "Andy site" }, task: { number: 3, title: task } });
const readCall = { kind: "read" as const, verb: "Read", active: "Reading", target: "hero.css", detail: null };
const state = (lanes: { id: string; number: number; running: boolean; waitingForApproval: boolean }[], busy = true): ServerMessage =>
  ({ type: "state", seq: 0, ready: true, setup: [], access: { scope: "full", folders: [], approvals: "ask" }, busy, lanes: lanes.map((l) => ({ ...l, openedAt: at, closedAt: null })), queue: [], approvals: [], routingQuestions: [] } as unknown as ServerMessage);

describe("the board", () => {
  it("is empty while main works alone", () => {
    const m = run(emptyModel(), state([]), act("main", { kind: "message", text: "Fix the hero" }), act("main", { kind: "routed", turnId: "t1", projectTurn: 1, ...route("Hero on mobile"), lane: null }));
    expect(strands(m, now)).toEqual([]);
  });

  it("lists main and each lane with its task, state and latest step, main first", () => {
    const m = run(emptyModel(),
      state([{ id: "lane_1", number: 1, running: true, waitingForApproval: false }, { id: "lane_2", number: 2, running: true, waitingForApproval: true }]),
      act("main", { kind: "message", text: "Fix the hero" }),
      act("main", { kind: "routed", turnId: "t1", projectTurn: 1, ...route("Hero on mobile"), lane: null }),
      act("main", { kind: "tool_started", turnId: "t1", task: "g2/t3", handle: "e1", line: "read hero.css", call: readCall }),
      act("lane_1", { kind: "lane", laneId: "lane_1", number: 1, state: "opened" }),
      act("lane_1", { kind: "message", text: "Check my calendar" }),
      act("lane_1", { kind: "routed", turnId: "t2", projectTurn: 2, goal: { number: 1, title: "General" }, task: { number: 4, title: "General · Sat 8 Nov" }, lane: 1 }),
      act("lane_2", { kind: "lane", laneId: "lane_2", number: 2, state: "opened" }),
      act("lane_2", { kind: "message", text: "Run the tests" }),
      act("lane_2", { kind: "routed", turnId: "t3", projectTurn: 3, ...route("Server tests"), lane: 2 }),
      act("lane_2", { kind: "tool_started", turnId: "t3", task: "g2/t3", handle: "e2", line: "terminal: pnpm test", call: { kind: "terminal", verb: "Ran", active: "Running", target: "pnpm test", detail: null } }),
    );
    const list = strands(m, now);
    expect(list.map((s) => [s.conversation, s.label, s.title, s.status, s.step, s.closable])).toEqual([
      ["main", "Main", "Hero on mobile", "working", "Reading hero.css", false],
      ["lane_1", "Lane 1", "General · Sat 8 Nov", "working", null, false],
      ["lane_2", "Lane 2", "Server tests", "waiting", "Running pnpm test", false],
    ]);
    expect(line(list[0]!, now)).toBe("Reading hero.css · 1m");
    expect(line(list[1]!, now)).toBe("Working · 1m");
    expect(line(list[2]!, now)).toBe("Waiting for your approval · Running pnpm test");
  });

  it("keeps a finished lane on the board for a while, closable, and drops it later", () => {
    const m = run(emptyModel(),
      state([{ id: "lane_1", number: 1, running: false, waitingForApproval: false }], false),
      act("main", { kind: "message", text: "Fix the hero" }),
      act("main", { kind: "routed", turnId: "t1", projectTurn: 1, ...route("Hero on mobile"), lane: null }),
      act("main", { kind: "answer", turnId: "t1", text: "Fixed." }),
      act("main", { kind: "finished", turnId: "t1", status: "completed", reason: null }),
      act("lane_1", { kind: "lane", laneId: "lane_1", number: 1, state: "opened" }),
      act("lane_1", { kind: "message", text: "Check my calendar" }),
      act("lane_1", { kind: "routed", turnId: "t2", projectTurn: 2, goal: { number: 1, title: "General" }, task: { number: 4, title: "General · Sat 8 Nov" }, lane: 1 }),
      act("lane_1", { kind: "answer", turnId: "t2", text: "Two meetings." }),
      act("lane_1", { kind: "finished", turnId: "t2", status: "completed", reason: null }),
    );
    const soon = strands(m, now);
    expect(soon.map((s) => [s.conversation, s.status, s.closable])).toEqual([["main", "done", false], ["lane_1", "done", true]]);
    expect(line(soon[1]!, now)).toBe("Done 1m ago");
    expect(strands(m, Date.parse(at) + STRAND_RECENT_MS + 1)).toEqual([]);
  });
});
