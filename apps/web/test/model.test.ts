import { describe, expect, it } from "vitest";
import { type Model, currentRoute, emptyModel, orbDocked, orbState, reduce, replayFrom, sendTarget, workLine } from "../src/lib/model";
import type { Activity, ActivityBody, HistoryItem, ServerMessage } from "../src/lib/types";

let seq = 100;
const at = "2026-10-04T10:00:00Z";
const act = (conversation: string, body: ActivityBody): ServerMessage => ({ type: "activity", seq: ++seq, at, conversation, ...body } as { type: "activity" } & Activity);
const run = (model: Model, ...messages: ServerMessage[]) => messages.reduce((m, message) => reduce(m, { type: "server", message }), model);
const route = { goal: { number: 2, title: "Ship auth" }, task: { number: 3, title: "Fix login" } };

const item = (over: Partial<HistoryItem>): HistoryItem => ({
  id: "ev", seq: 10, at, message: "Earlier question", unrouted: false, question: null,
  parts: [{ projectTurn: 1, status: "completed", ...route, lane: null, handedOff: false, answer: "Earlier answer", interrupted: null, toolCalls: [{ handle: "e1", line: "read a.ts", status: "ok" }] }],
  ...over,
});

describe("the conversation model", () => {
  it("turns a sent message into one exchange with its steps, tools and answer, then done", () => {
    let m = reduce(emptyModel(), { type: "sent", id: "c1", text: "Why does login fail?", to: "main", at });
    expect(m.conversations.main![0]).toMatchObject({ key: "cc1", state: "sending", sendId: "c1" });
    expect(orbState(m.conversations.main![0]!, [])).toBe("thinking");
    m = run(m,
      act("main", { kind: "message", text: "Why does login fail?" }),
      act("main", { kind: "routed", turnId: "t1", projectTurn: 4, ...route, lane: null }),
    );
    expect(m.conversations.main).toHaveLength(1);
    expect(m.conversations.main![0]).toMatchObject({ key: `m${seq - 1}`, state: "working", sendId: "c1", route });
    expect(orbDocked(orbState(m.conversations.main![0]!, []))).toBe(false);
    m = run(m,
      act("main", { kind: "step", turnId: "t1", text: "Checking the refresh handler." }),
      act("main", { kind: "tool_started", turnId: "t1", task: "g2/t3", handle: "e4", line: "read src/refresh.ts" }),
    );
    expect(orbState(m.conversations.main![0]!, [])).toBe("working");
    m = run(m,
      act("main", { kind: "tool_finished", turnId: "t1", task: "g2/t3", handle: "e4", status: "ok", preview: "export function refresh", truncated: false }),
      act("main", { kind: "answer", turnId: "t1", text: "The refresh path drops the token." }),
      act("main", { kind: "finished", turnId: "t1", status: "completed", reason: null }),
    );
    const done = m.conversations.main![0]!;
    expect(done.steps).toEqual([
      { kind: "step", text: "Checking the refresh handler." },
      { kind: "tool", handle: "e4", task: "g2/t3", line: "read src/refresh.ts", status: "ok", preview: "export function refresh", truncated: false },
    ]);
    expect(done).toMatchObject({ answers: ["The refresh path drops the token."], state: "done" });
    expect(orbState(done, [])).toBe("done");
    expect(m.seq).toBe(seq);
  });

  it("waits on an approval, records stops, and marks a failed send", () => {
    let m = run(emptyModel(), act("main", { kind: "message", text: "Run it" }), act("main", { kind: "tool_started", turnId: "t1", task: "g1/t1", handle: "e1", line: "terminal npm test" }));
    const approval = { id: "a1", conversation: "main", lane: null, turnId: "t1", task: null, kind: "action", tool: "terminal", detail: "Run npm test", preview: null };
    expect(orbState(m.conversations.main![0]!, [approval])).toBe("waiting");
    m = run(m, act("main", { kind: "finished", turnId: "t1", status: "interrupted", reason: "cancelled" }));
    expect(m.conversations.main![0]).toMatchObject({ state: "stopped", note: "Stopped." });
    m = reduce(m, { type: "sent", id: "c2", text: "Again", to: "main", at });
    m = run(m, { type: "error", id: "c2", code: "lane_limit", message: "Four lanes are already working." });
    expect(m.conversations.main!.at(-1)).toMatchObject({ state: "failed", note: "Four lanes are already working." });
    m = reduce(m, { type: "unsent", id: "c2" });
    expect(m.conversations.main).toHaveLength(1);
  });

  it("moves a message sent to a new lane into that lane, and follows a handoff into the lane", () => {
    let m = reduce(emptyModel(), { type: "sent", id: "c3", text: "Write NOTES.md", to: "new_lane", at });
    expect(m.pending).toHaveLength(1);
    m = run(m, act("lane_1", { kind: "lane", laneId: "lane_1", number: 1, state: "opened" }), { type: "accepted", id: "c3", conversation: "lane_1" });
    expect(m.pending).toEqual([]);
    expect(m.conversations.lane_1![0]).toMatchObject({ message: "Write NOTES.md", conversation: "lane_1", state: "sending" });

    m = run(m,
      act("main", { kind: "message", text: "Also add a line to the notes" }),
      act("main", { kind: "routed", turnId: "t9", projectTurn: 7, ...route, lane: null }),
      act("main", { kind: "handed_off", turnId: "t9", lane: 1 }),
      act("lane_1", { kind: "message", text: "Write NOTES.md" }),
      act("lane_1", { kind: "answer", turnId: "t8", text: "Created." }),
      act("lane_1", { kind: "finished", turnId: "t8", status: "completed", reason: null }),
      act("lane_1", { kind: "tool_started", turnId: "t9", task: "g2/t3", handle: "e2", line: "edit NOTES.md" }),
    );
    expect(m.conversations.main![0]).toMatchObject({ state: "done", steps: [{ kind: "handed_off", lane: 1 }] });
    expect(m.conversations.lane_1!.map((e) => [e.message, e.state])).toEqual([["Write NOTES.md", "done"], ["Also add a line to the notes", "working"]]);
  });

  it("keeps one exchange when a new lane's message is saved before the send is accepted", () => {
    let m = reduce(emptyModel(), { type: "sent", id: "c5", text: "Create NOTES.md", to: "new_lane", at });
    m = run(m,
      act("lane_2", { kind: "lane", laneId: "lane_2", number: 2, state: "opened" }),
      act("lane_2", { kind: "message", text: "Create NOTES.md" }),
      { type: "accepted", id: "c5", conversation: "lane_2" },
      act("lane_2", { kind: "answer", turnId: "t5", text: "Created." }),
    );
    expect(m.pending).toEqual([]);
    expect(m.conversations.lane_2).toHaveLength(1);
    expect(m.conversations.lane_2![0]).toMatchObject({ sendId: "c5", answers: ["Created."], state: "working" });
  });

  it("queues a message to main while main works, and sends everything else", () => {
    expect(sendTarget("main", true)).toBe("queue");
    expect(sendTarget("main", false)).toBe("send");
    expect(sendTarget("lane_1", true)).toBe("send");
  });

  it("loads history oldest first, pages older items, and rebuilds a replayed message from its events", () => {
    let m = reduce(emptyModel(), { type: "history", conversation: "main", items: [item({ seq: 20, message: "Newer" }), item({ seq: 10 })] });
    expect(m.conversations.main!.map((e) => [e.seq, e.message, e.state, e.answers[0]])).toEqual([[10, "Earlier question", "done", "Earlier answer"], [20, "Newer", "done", "Earlier answer"]]);
    expect(m.conversations.main![0]!.steps).toEqual([{ kind: "tool", handle: "e1", task: "g2/t3", line: "read a.ts", status: "ok", preview: null, truncated: false }]);
    m = reduce(m, { type: "history", conversation: "main", items: [item({ seq: 5, message: "Oldest" })], older: true });
    expect(m.conversations.main!.map((e) => e.seq)).toEqual([5, 10, 20]);
    m = run(m, { type: "activity", seq: 20, at, conversation: "main", kind: "message", text: "Newer" } as ServerMessage);
    expect(m.conversations.main!.at(-1)).toMatchObject({ seq: 20, steps: [], answers: [], state: "working" });
    const stopped = reduce(emptyModel(), { type: "history", conversation: "main", items: [item({ parts: [{ ...item({}).parts[0]!, status: "interrupted", interrupted: "restarted", answer: null }] })] });
    expect(stopped.conversations.main![0]).toMatchObject({ state: "stopped", note: "Stopped when Socrates restarted." });
  });

  it("replays from just before the oldest unfinished message, or from the status", () => {
    const working = item({ seq: 30, parts: [{ ...item({}).parts[0]!, status: "in_progress", answer: null }] });
    expect(replayFrom([[item({ seq: 40 }), working], [item({ seq: 35, unrouted: true, parts: [] })]], 50)).toBe(29);
    expect(replayFrom([[item({ seq: 40 })]], 50)).toBe(50);
  });

  it("collects lane notices from results until dismissed", () => {
    let m = run(emptyModel(), { type: "result", id: "c1", conversation: "main", result: { kind: "answered", text: "ok", notices: ["Lane 1 finished: Create NOTES.md"] } });
    expect(m.notices.map((n) => n.text)).toEqual(["Lane 1 finished: Create NOTES.md"]);
    m = reduce(m, { type: "dismiss", id: m.notices[0]!.id });
    expect(m.notices).toEqual([]);
  });
});

describe("standard mode helpers", () => {
  it("finds the newest routed question and describes work in progress", () => {
    let m = run(emptyModel(), act("main", { kind: "message", text: "One" }), act("main", { kind: "routed", turnId: "a", projectTurn: 1, ...route, lane: null }), act("main", { kind: "message", text: "Two" }));
    expect(currentRoute(m.conversations.main!)).toEqual(route);
    const latest = m.conversations.main!.at(-1)!;
    expect(workLine(orbState(latest, []), latest)).toBe("Thinking…");
    m = run(m, act("main", { kind: "step", turnId: "b", text: "Looking." }));
    expect(workLine(orbState(m.conversations.main!.at(-1)!, []), null)).toBe("Working…");
    expect(workLine("done", null)).toBeNull();
  });
});

describe("drafts of a reply that is arriving", () => {
  const draft = (turnId: string, call: number, kind: "narration" | "answer" | "thinking", text: string, conversation = "main"): ServerMessage => ({ type: "draft", conversation, turnId, call, kind, text });
  const working = () => run(emptyModel(),
    act("main", { kind: "message", text: "Why does login fail?" }),
    act("main", { kind: "routed", turnId: "t1", projectTurn: 4, ...route, lane: null }),
  );
  const exchange = (m: Model, conversation = "main") => m.conversations[conversation]!.at(-1)!;

  it("shows the draft on the exchange of its turn, moves the orb, and never moves the page's place in the log", () => {
    const before = working();
    expect(orbState(exchange(before), [])).toBe("thinking");
    const m = run(before, draft("t1", 1, "answer", "The refresh"));
    expect(exchange(m).draft).toEqual({ turnId: "t1", call: 1, kind: "answer", text: "The refresh" });
    expect(orbState(exchange(m), [])).toBe("working");
    expect(orbDocked(orbState(exchange(m), []))).toBe(true);
    expect(m.seq).toBe(before.seq);
    expect(run(m, draft("t1", 1, "answer", "The refresh path")).conversations.main![0]!.draft!.text).toBe("The refresh path");
  });

  it("lets a later request's draft replace an earlier one, and ignores a stale one", () => {
    let m = run(working(), draft("t1", 2, "answer", "Second request"));
    m = run(m, draft("t1", 1, "narration", "Late and stale"));
    expect(exchange(m).draft).toMatchObject({ call: 2, text: "Second request" });
    m = run(m, draft("t1", 3, "answer", "Third"));
    expect(exchange(m).draft).toMatchObject({ call: 3, text: "Third" });
  });

  it("is replaced by the saved narration, answer or end of its turn, and only for its own turn", () => {
    const base = run(working(), draft("t1", 1, "narration", "Checking the refresh handler"));
    const saved = run(base, act("main", { kind: "step", turnId: "t1", text: "Checking the refresh handler." }));
    expect(exchange(saved).draft).toBeNull();
    expect(exchange(saved).steps).toEqual([{ kind: "step", text: "Checking the refresh handler." }]);
    const answered = run(saved, draft("t1", 2, "answer", "The refresh path"), act("main", { kind: "answer", turnId: "t1", text: "The refresh path drops the token." }));
    expect(exchange(answered).draft).toBeNull();
    expect(exchange(answered).answers).toEqual(["The refresh path drops the token."]);
    // The end of a turn clears a draft whose answer never came, such as a stopped one.
    const stopped = run(base, act("main", { kind: "finished", turnId: "t1", status: "interrupted", reason: "cancelled" }));
    expect(exchange(stopped)).toMatchObject({ draft: null, state: "stopped" });
    // Another turn's activity leaves it alone.
    const other = run(base, act("main", { kind: "answer", turnId: "t0", text: "Something else" }));
    expect(exchange(other).draft).toMatchObject({ turnId: "t1" });
  });

  it("puts a lane's draft in the lane and rebuilds a replayed message without one", () => {
    let m = run(emptyModel(),
      act("lane1", { kind: "lane", laneId: "lane1", number: 1, state: "opened" }),
      act("lane1", { kind: "message", text: "Write the docs." }),
      act("lane1", { kind: "routed", turnId: "t9", projectTurn: 1, ...route, lane: 1 }),
      draft("t9", 1, "answer", "The docs", "lane1"),
    );
    expect(exchange(m, "lane1").draft).toMatchObject({ turnId: "t9", text: "The docs" });
    expect(m.conversations.main).toEqual([]);
    const messageSeq = exchange(m, "lane1").seq!;
    m = reduce(m, { type: "server", message: { type: "activity", seq: messageSeq, at, conversation: "lane1", kind: "message", text: "Write the docs." } });
    expect(exchange(m, "lane1")).toMatchObject({ draft: null, steps: [], answers: [] });
  });

  it("does not count a draft that arrives for a finished exchange as work", () => {
    const done = run(working(), act("main", { kind: "answer", turnId: "t1", text: "Done." }), act("main", { kind: "finished", turnId: "t1", status: "completed", reason: null }));
    expect(exchange(done).state).toBe("done");
    expect(orbState(exchange(run(done, draft("t1", 1, "answer", "late"))), [])).toBe("done");
    expect(exchange(run(done, draft("t1", 1, "answer", "late"))).draft).toBeNull();
  });

  it("ignores late drafts after narration settles, shorter pieces, and unknown finished turns", () => {
    const base = run(working(), draft("t1", 2, "narration", "Checking the configuration."));
    expect(exchange(run(base, draft("t1", 2, "narration", "Checking"))).draft?.text).toBe("Checking the configuration.");
    const settled = run(base, act("main", { kind: "step", turnId: "t1", text: "Checking the configuration." }));
    expect(exchange(run(settled, draft("t1", 1, "answer", "Old attempt"))).draft).toBeNull();
    expect(exchange(run(settled, draft("t1", 2, "narration", "Late callback"))).draft).toBeNull();
    expect(exchange(run(settled, draft("t1", 3, "answer", "New answer"))).draft?.text).toBe("New answer");
    const done = run(settled, act("main", {kind:"finished",turnId:"t1",status:"completed",reason:null}));
    expect(run(done, draft("unknown",1,"answer","Late")).conversations.main).toHaveLength(1);
  });

  it("does not advance the replay cursor to the state sent before replay", () => {
    const model = working();
    const state = { type:"state", seq:model.seq+100, ready:true, setup:[], access:{scope:"folders",folders:[],approvals:"ask"}, busy:true, lanes:[], queue:[], approvals:[] } as const;
    expect(run(model, state as unknown as ServerMessage).seq).toBe(model.seq);
  });

  it("places a handed-off turn in its lane before its first draft, with the exact task", () => {
    const moved = run(working(), act("main",{kind:"handed_off",turnId:"t1",lane:2,laneId:"lane2",...route}), draft("t1",1,"answer","In the lane","lane2"));
    expect(exchange(moved,"lane2")).toMatchObject({route,turns:["t1"],open:["t1"],draft:{text:"In the lane"}});
    expect(exchange(moved).state).toBe("done");
    expect(exchange(moved,"lane2").message).toBe(exchange(moved).message);
  });

  it("restores ordered narration and tool previews and ignores activity already in the snapshot", () => {
    const page = item({throughSeq:500,activities:[
      {seq:12,at,conversation:"main",kind:"step",turnId:"old",text:"Reading first."},
      {seq:13,at,conversation:"main",kind:"tool_started",turnId:"old",task:"g2/t3",handle:"e1",line:"read a.ts"},
      {seq:14,at,conversation:"main",kind:"tool_finished",turnId:"old",task:"g2/t3",handle:"e1",status:"ok",preview:"File text",truncated:false},
    ],parts:[{...item({}).parts[0]!,turnId:"old"}]});
    const model = reduce(emptyModel(), {type:"history",conversation:"main",items:[page]});
    expect(model.conversations.main![0]!.steps).toEqual([{kind:"step",text:"Reading first."},{kind:"tool",task:"g2/t3",handle:"e1",line:"read a.ts",status:"ok",preview:"File text",truncated:false}]);
    const replay = run(model, {type:"activity",seq:10,at,conversation:"main",kind:"message",text:page.message}, {type:"activity",seq:15,at,conversation:"main",kind:"answer",turnId:"old",text:"Duplicate answer"});
    expect(replay.conversations.main).toEqual(model.conversations.main);
  });

  it("keeps the answer written before a stop, in the place its draft had, and marks the question stopped", () => {
    const m = run(working(), draft("t1", 2, "answer", "The refresh path"), act("main", { kind: "finished", turnId: "t1", status: "interrupted", reason: "cancelled", partial: "The refresh path drops" }));
    expect(exchange(m)).toMatchObject({ draft: null, answers: ["The refresh path drops"], state: "stopped", note: "Stopped." });
    const plain = run(working(), act("main", { kind: "finished", turnId: "t1", status: "interrupted", reason: "cancelled" }));
    expect(exchange(plain).answers).toEqual([]);
  });

  it("keeps thinking beside the reply's draft, and a step that only thought leaves the answer being written", () => {
    let m = run(working(), draft("t1", 1, "thinking", "Weighing"), draft("t1", 1, "answer", "The refresh"));
    expect(exchange(m)).toMatchObject({ thinking: { kind: "thinking", text: "Weighing" }, draft: { kind: "answer", text: "The refresh" } });
    expect(orbState({ ...exchange(working()), thinking: exchange(m).thinking }, [])).toBe("working");
    m = run(m, act("main", { kind: "step", turnId: "t1", text: "", thinking: "Weighing it all.", thinkingTruncated: false }));
    expect(exchange(m)).toMatchObject({ thinking: null, draft: { text: "The refresh" } });
    expect(exchange(m).steps).toEqual([{ kind: "thinking", text: "Weighing it all.", truncated: false }]);
    // A late thinking draft of the saved request is ignored; the answer still grows.
    m = run(m, draft("t1", 1, "thinking", "Weighing it all. late"), draft("t1", 1, "answer", "The refresh path"));
    expect(exchange(m)).toMatchObject({ thinking: null, draft: { text: "The refresh path" } });
  });
});


describe("attachments on questions", () => {
  const image = { id: "b".repeat(32), name: "shot.png", media_type: "image/png", width: 10, height: 10, bytes: 99 };
  it("keeps a message's images, from the page that sent it, a page that only sees the activity, and history", () => {
    let m = reduce(emptyModel(), { type: "sent", id: "c9", text: "Look", to: "main", at, attachments: [image] });
    m = run(m, act("main", { kind: "message", text: "Look", attachments: [image] }));
    expect(m.conversations.main![0]).toMatchObject({ sendId: "c9", attachments: [image] });
    expect(run(emptyModel(), act("main", { kind: "message", text: "Look", attachments: [image] })).conversations.main![0]!.attachments).toEqual([image]);
    const loaded = reduce(emptyModel(), { type: "history", conversation: "main", items: [item({ attachments: [image] })] });
    expect(loaded.conversations.main![0]!.attachments).toEqual([image]);
  });
});
