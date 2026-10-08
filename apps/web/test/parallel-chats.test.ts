import { describe, expect, it } from "vitest";
import { allQuestions } from "../src/lib/chats";
import { type Model, chatBusy, emptyModel, orbState, reduce } from "../src/lib/model";
import type { Activity, ActivityBody, LiveState, PendingApproval, ServerMessage } from "../src/lib/types";

let seq = 500;
const at = (minute: number) => `2026-10-08T10:${String(minute).padStart(2, "0")}:00Z`;
const act = (conversation: string, body: ActivityBody, minute = 0): ServerMessage => ({ type: "activity", seq: ++seq, at: at(minute), conversation, ...body } as { type: "activity" } & Activity);
const run = (model: Model, ...messages: ServerMessage[]) => messages.reduce((m, message) => reduce(m, { type: "server", message }), model);
const chatA = { goal: { number: 1, title: "Chats" }, task: { number: 1, title: "A" } };
const chatB = { goal: { number: 1, title: "Chats" }, task: { number: 2, title: "B" } };

describe("standard-mode chats working at once", () => {
  it("joins each new turn to the message it answers, not merely the newest one", () => {
    let m = run(emptyModel(), act("main", { kind: "message", text: "Question A" }));
    const a = seq;
    m = run(m, act("main", { kind: "message", text: "Question B" }));
    const b = seq;
    // A's turn is bound after B was saved.
    m = run(m,
      act("main", { kind: "routed", turnId: "tb", messageSeq: b, projectTurn: 2, ...chatB, lane: null }),
      act("main", { kind: "routed", turnId: "ta", messageSeq: a, projectTurn: 1, ...chatA, lane: null }),
      act("main", { kind: "answer", turnId: "ta", text: "Answer A" }),
      act("main", { kind: "finished", turnId: "ta", status: "completed", reason: null }),
    );
    const [first, second] = m.conversations.main!;
    expect(first).toMatchObject({ message: "Question A", route: chatA, turns: ["ta"], answers: ["Answer A"], state: "done" });
    expect(second).toMatchObject({ message: "Question B", route: chatB, turns: ["tb"], answers: [], state: "working" });
  });

  it("knows a message it queued once it starts, by the saved message the server names", () => {
    let m = run(emptyModel(), act("main", { kind: "message", text: "Queued for A" }));
    m = run(m, { type: "accepted", id: "c9", conversation: "main", seq });
    expect(m.conversations.main![0]!.sendId).toBe("c9");
  });

  it("shows a lane's work in its chat, and a question handed whole to a lane once", () => {
    let m = run(emptyModel(),
      act("main", { kind: "message", text: "Handed over" }, 1),
      act("main", { kind: "routed", turnId: "t1", projectTurn: 1, ...chatA, lane: null }, 1),
      act("main", { kind: "handed_off", turnId: "t1", lane: 1, laneId: "lane-1", ...chatA }, 1),
    );
    m = run(m,
      act("lane-1", { kind: "answer", turnId: "t1", text: "Done in the lane" }, 2),
      act("main", { kind: "message", text: "Later in main" }, 3),
    );
    const all = allQuestions(m.conversations);
    expect(all.map((e) => [e.conversation, e.message])).toEqual([["lane-1", "Handed over"], ["main", "Later in main"]]);
    expect(all[0]!.answers).toEqual(["Done in the lane"]);
  });

  it("says which chats work, and waits only for its own question's approval", () => {
    const live = { busy: false, working: [{ goal: 1, task: 2 }] } as LiveState;
    expect(chatBusy(live, { goal: 1, task: 2 })).toBe(true);
    expect(chatBusy(live, { goal: 1, task: 1 })).toBe(false);
    expect(chatBusy(live, { goal: 1, task: null })).toBe(false);

    const m = run(emptyModel(),
      act("main", { kind: "message", text: "A" }),
      act("main", { kind: "routed", turnId: "ta", messageSeq: seq, projectTurn: 1, ...chatA, lane: null }),
    );
    const exchange = m.conversations.main![0]!;
    const approval = (turnId: string): PendingApproval => ({ id: "p", conversation: "main", lane: null, turnId, task: null, kind: "action", tool: "terminal", detail: "npm test", preview: null });
    expect(orbState(exchange, [approval("tb")])).toBe("thinking");
    expect(orbState(exchange, [approval("ta")])).toBe("waiting");
  });
});
