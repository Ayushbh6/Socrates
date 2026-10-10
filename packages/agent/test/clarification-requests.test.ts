import { describe, expect, it } from "vitest";
import { continueTask, createGoal } from "../../router/test/helpers";
import { contextText, final, world } from "./helpers";

const ask = {toolCalls: [{name: "ask_user", input: {question: "Which folder should I use?", candidates: [{label: "Work", detail: "Use the Work folder", goal_label: "current", task_label: "current"}], allow_new: false}}]};

describe("one original request through routing clarification", () => {
  it("resumes after unrelated Standard work and after changing mode, then preserves the exchange in future context", async () => {
    const w = await world();
    const {socrates, model, routerModel} = w.socrates([ask, continueTask()], [final({full_answer: "Independent answer"}), final({full_answer: "Terminal test passed"}), final()]);
    const original = "Please try the terminal test again.";
    const question = await socrates.handle(original, {newRequest: true});
    expect(question.kind).toBe("clarify");
    const pending = w.store.pendingClarification()!;
    await socrates.handle("An unrelated Standard question", {target: {taskId: w.taskId}, alongside: true, newRequest: true});
    const answered = await socrates.handle("yes pls sure", {replyTo: pending.id, target: {taskId: w.taskId}, alongside: true});
    if (answered.kind !== "answered") throw new Error("Expected work");
    expect(w.store.requestForTurn(answered.parts[0]!.turn.id)).toMatchObject({request: original, clarification: {answer: "yes pls sure", question: expect.stringContaining("Which folder")}});
    expect(contextText(model.requests[1]!)).toContain(original);
    expect(routerModel.requests).toHaveLength(2);
    await socrates.handle("What was the test result?", {target: {taskId: w.taskId}, newRequest: true});
    const next = contextText(model.requests[2]!);
    expect(next).toContain(original); expect(next).toContain("yes pls sure"); expect(next).toContain("Terminal test passed");
  });

  it("routes a fresh Flow request independently while an older question is waiting", async () => {
    const w = await world();
    const {socrates} = w.socrates([ask, createGoal("German", "Learn verbs")], [final()]);
    await socrates.handle("Try the terminal test", {newRequest: true});
    const pending = w.store.pendingClarification()!;
    const next = await socrates.handle("Help me learn German verbs", {newRequest: true});
    if (next.kind !== "answered") throw new Error("Expected work");
    expect(w.store.requestForTurn(next.parts[0]!.turn.id)).toMatchObject({request: "Help me learn German verbs", clarification: null});
    expect(w.store.clarification(pending.id).state).toBe("pending");
  });
});
