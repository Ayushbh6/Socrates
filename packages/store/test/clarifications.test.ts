import { describe, expect, it } from "vitest";
import { LedgerStore } from "../src";
import { setup } from "../../router/test/helpers";

function pending() {
  const {store, clock} = setup("2026-10-10T21:59:00Z");
  const goal = store.createGoal({title: "Website"});
  const task = store.createTask(goal.id, {title: "Checkout"});
  const request = store.recordUserMessage("Please try the terminal test again.");
  const question = store.recordClarification(request.id, "Which folder? Work folder (suggested)");
  store.appendEvent("clarification_asked", {question: "Which folder?", candidates: [{label: "Work folder"}], allow_new: false, zero_history: false}, {turn_id: question.id});
  return {store, clock, task, request, question};
}

describe("durable routing clarification requests", () => {
  it("remains pending across unrelated Standard work and restart/event restoration", () => {
    const {store, task, request, question} = pending();
    const event = store.recordUserMessage("An independent question.");
    store.bindTurn({userEventId: event.id, taskId: task.id, route: "standard"});
    expect(store.pendingClarification()?.id).toBe(question.id);
    const restored = LedgerStore.open({path: ":memory:"});
    restored.restoreEvents(store.listEvents());
    expect(restored.clarification(question.id)).toMatchObject({requestId: request.id, state: "pending"});
    restored.close(); store.close();
  });

  it("claims an explicit reply atomically and rejects a second tab's reply", () => {
    const {store, request, question} = pending();
    const answer = store.recordClarificationReply(question.id, "Yes, use Work.");
    expect(store.requestRoot(answer.id).id).toBe(request.id);
    expect(store.clarification(question.id)).toMatchObject({state: "resuming", answer: "Yes, use Work."});
    expect(() => store.recordClarificationReply(question.id, "Another reply")).toThrow("no longer waiting");
    store.close();
  });

  it("allows retry after an unbound reply is interrupted, while preserving the original request", () => {
    const {store, request, question, task} = pending();
    const first = store.recordClarificationReply(question.id, "Yes");
    store.recoverClarificationReplies();
    expect(store.clarification(question.id)).toMatchObject({state: "pending", error: expect.stringContaining("restarted")});
    const second = store.recordClarificationReply(question.id, "Use Work");
    const turn = store.bindTurn({userEventId: second.id, taskId: task.id, route: "general", requestEventId: request.id, clarificationTurnId: question.id});
    expect(store.requestForTurn(turn.id)).toMatchObject({request: request.payload.text, clarification: {answer: "Use Work"}});
    expect(store.requestMessages(request.id).map(e => e.id)).toEqual([request.id, first.id, second.id]);
    expect(store.clarification(question.id).state).toBe("answered");
    store.close();
  });

  it("backfills an old answered exchange from existing binding records without rewriting events", () => {
    const {store, request, question, task} = pending();
    const answer = store.recordUserMessage("yes pls sure");
    const turn = store.bindTurn({userEventId: answer.id, taskId: task.id, route: "general", requestEventId: request.id, clarificationTurnId: question.id});
    store.completeTurn(turn.id, {responseEventId: store.recordResponse("Test passed").id, continuationNote: "Verified"});
    const before = store.listEvents();
    expect(store.requestRoot(answer.id).id).toBe(request.id);
    expect([...store.recentExchanges()]).toHaveLength(1);
    expect([...store.recentExchanges()][0]).toMatchObject({userMessage: request.payload.text, kind: "task"});
    expect([...store.recentExchanges()][0]!.response).toContain("yes pls sure");
    expect(store.listEvents()).toEqual(before);
    store.close();
  });

  it("persists cancellation and prevents a cancelled question from consuming later messages", () => {
    const {store, question} = pending();
    store.cancelClarification(question.id);
    expect(store.pendingClarification()).toBeNull();
    expect(() => store.recordClarificationReply(question.id, "Yes")).toThrow("no longer waiting");
    const copy = LedgerStore.open({path: ":memory:"}); copy.restoreEvents(store.listEvents());
    expect(copy.clarification(question.id).state).toBe("cancelled");
    copy.close(); store.close();
  });

  it("keeps one General day when resumed after midnight, even after a newer day exists", () => {
    const {store, clock, request} = pending();
    const original = store.ensureGeneral("Europe/Vienna", new Date(request.at));
    clock.advance(120000);
    const next = store.ensureGeneral("Europe/Vienna");
    expect(next.task.id).not.toBe(original.task.id);
    expect(store.ensureGeneral("Europe/Vienna", new Date(request.at)).task.id).toBe(original.task.id);
    const restored = LedgerStore.open({path: ":memory:", clock}); restored.restoreEvents(store.listEvents());
    expect(restored.ensureGeneral("Europe/Vienna", new Date(request.at)).task.id).toBe(original.task.id);
    restored.close(); store.close();
  });

  it("dates a legacy General label once, using its actual local day", () => {
    const {store} = setup("2026-10-08T22:49:00Z");
    const goal = store.createGoal({title: "General conversation", general: true});
    const old = store.createTask(goal.id, {title: "General", general: true});
    store.dateGeneralTasks("Europe/Vienna");
    expect(store.requireTask(old.id).title).toBe("General · Fri 9 Oct");
    const events = store.listEvents(); store.dateGeneralTasks("Europe/Vienna");
    expect(store.listEvents()).toEqual(events);
    store.close();
  });
  it("keeps a General day stable when the configured timezone later changes", () => {
    const {store} = setup("2026-10-09T22:30:00Z");
    const day = store.ensureGeneral("Europe/Vienna");
    expect(store.generalDay(day.task.id)).toBe("2026-10-10");
    expect(store.ensureGeneral("America/New_York", new Date("2026-10-09T22:30:00Z"), "2026-10-10").task.id).toBe(day.task.id);
    const copy = LedgerStore.open({path: ":memory:"}); copy.restoreEvents(store.listEvents());
    expect(copy.generalDay(day.task.id)).toBe("2026-10-10");
    copy.close(); store.close();
  });

});
