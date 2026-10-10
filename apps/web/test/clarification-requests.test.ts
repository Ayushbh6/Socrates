import { describe, expect, it } from "vitest";
import { emptyModel, fromHistory, orbState, reduce, workLine } from "../src/lib/model";
import { chatThread } from "../src/lib/chats";
import { redoBlock } from "../src/components/RedoMenu";
import type { ClarificationView, HistoryItem, ServerMessage } from "../src/lib/types";

const q: ClarificationView = {turnId: "question", requestId: "original", messageSeq: 1, at: "2026-10-10T13:03:00Z", message: "Try the terminal test again", conversation: "main", question: "Which folder?", detail: "Which folder? Work (suggested)", answer: null, answerEventId: null, state: "pending", error: null};
const original = {id: "original", seq: 1, at: q.at, message: q.message, attachments: []};
const place = {goal: {number: 1, title: "General"}, task: {number: 2, title: "General · Sat 10 Oct"}, chat: 1};
const event = (seq: number, body: object) => ({type: "server" as const, message: {type: "activity", seq, at: q.at, conversation: "main", ...body} as ServerMessage});

describe("one visible routing clarification exchange", () => {
  it("waits for a reply, then links live answer/work to the original question despite intervening messages", () => {
    let model = reduce(emptyModel(), event(1, {kind: "message", requestId: q.requestId, text: q.message, attachments: []}));
    model = reduce(model, event(2, {kind: "question", turnId: q.turnId, requestSeq: 1, text: q.detail, clarification: q, original}));
    expect(model.conversations.main![0]!.state).toBe("waiting");
    expect(workLine(orbState(model.conversations.main![0]!, []), model.conversations.main![0]!)).toBe("Waiting for your reply…");
    model = reduce(model, event(3, {kind: "message", text: "An unrelated request", attachments: []}));
    const answered = {...q, answer: "yes pls sure", answerEventId: "reply", state: "resuming" as const};
    model = reduce(model, event(4, {kind: "clarification_changed", turnId: q.turnId, requestSeq: 1, original, clarification: answered}));
    model = reduce(model, event(5, {kind: "routed", turnId: "work", requestSeq: 1, messageSeq: 1, projectTurn: 5, ...place, lane: null, original, clarification: {...answered, state: "answered"}}));
    model = reduce(model, event(6, {kind: "answer", turnId: "work", text: "The terminal test passed"}));
    model = reduce(model, event(7, {kind: "finished", turnId: "work", status: "completed", reason: null}));
    expect(model.conversations.main).toHaveLength(2);
    expect(model.conversations.main!.at(-1)).toMatchObject({message: q.message, answers: ["The terminal test passed"], clarification: {answer: "yes pls sure"}, state: "done", open: []});
    expect(chatThread(model.conversations.main!, 1, 2)).toHaveLength(1);
    expect(chatThread(model.conversations.main!, 1, 1)).toHaveLength(0);
    expect(redoBlock(model.conversations.main!.at(-1)!, model.conversations.main!)).toBeNull();
  });

  it("reconstructs the complete original when a late routed event arrives outside loaded pages", () => {
    const answered = {...q, state: "answered" as const, answer: "Work", answerEventId: "reply"};
    const model = reduce(emptyModel(), event(5, {kind: "routed", turnId: "work", messageSeq: 1, requestSeq: 1, original, projectTurn: 5, ...place, lane: null, clarification: answered}));
    expect(model.conversations.main).toHaveLength(1);
    expect(model.conversations.main![0]).toMatchObject({requestId: "original", message: q.message, clarification: {answer: "Work"}, state: "working"});
  });

  it("restores the finished grouped history exactly once, preserving the final state after activities", () => {
    const snapshot: HistoryItem = {id: q.requestId, seq: 1, pageSeq: 4, throughSeq: 7, at: q.at, message: q.message, attachments: [], unrouted: false, question: q.detail, clarification: {...q, state: "answered", answer: "yes pls sure", answerEventId: "reply"}, activities: [{seq: 5, at: q.at, conversation: "main", kind: "routed", turnId: "work", messageSeq: 1, projectTurn: 5, ...place, lane: null}], parts: [{turnId: "work", projectTurn: 5, status: "completed", ...place, lane: null, handedOff: false, answer: "Test passed", interrupted: null, toolCalls: []}]};
    const exchange = fromHistory(snapshot, "main");
    expect(exchange).toMatchObject({message: q.message, state: "done", clarification: {answer: "yes pls sure"}, answers: ["Test passed"]});
    let model = reduce(emptyModel(), {type: "history", conversation: "main", items: [snapshot]});
    model = reduce(model, {type: "history", conversation: "main", items: [snapshot], older: true});
    expect(model.conversations.main).toHaveLength(1);
  });
});
