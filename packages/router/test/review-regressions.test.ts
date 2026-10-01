import { describe, expect, it } from "vitest";
import { countTokens } from "@socrates/shared";
import { runLedgerQuery } from "@socrates/store";
import { buildRoutingContext } from "../src/context";
import { GoalRouter } from "../src/router";
import { emptySeen, validateDecisionText } from "../src/validate";
import { Q_SCENARIO, grade } from "../eval/fixtures";
import { continueTask, createGoal, createTask, decision, exchange, general, routerWith, setup } from "./helpers";

const ask = {
  question: "Which project?",
  candidates: [
    { label: "Website", detail: "Checkout work", suggested: true },
    { label: "German", detail: "German lessons" },
  ],
  allow_new: true,
};

async function seedTwo() {
  const s = setup();
  await exchange(s.store, "German lessons", createGoal("German", "Day 1"));
  s.clock.advance(1000);
  await exchange(s.store, "Website work", createGoal("Website", "Checkout"));
  return s;
}

describe("PR 3 independent architecture regressions", () => {
  it("carries previous ledger results into the escalation request", async () => {
    const { store, clock } = setup("2026-08-01T10:00:00Z");
    await exchange(store, "old work", createGoal("Archived goal", "Legacy repair"));
    clock.set("2026-09-01T10:00:00Z");
    await exchange(store, "website", createGoal("Website", "Checkout"), "current response ".repeat(100));
    const q = { toolCalls: [{ name: "ledger_query", input: { from: "2026-08-01", to: "2026-08-31" } }] };
    const { routerModel, mainModel } = routerWith(store, [q, q, q, { text: "bad" }, { text: "bad" }], [q, continueTask()]);
    const router = new GoalRouter({ store, routerModel, mainModel, timeZone: "UTC", historyBudgetTokens: 30 });
    await router.route("Please resume August's project");
    const mainFirst = mainModel!.requests[0]!;
    expect(mainFirst.messages[0]!.content.includes("Archived goal")).toBe(false);
    expect(mainModel!.requests[1]!.messages.at(-1)!.content.includes("ledger_query_limit")).toBe(true);
    expect(mainFirst.messages.some(m => m.role === "tool" && m.content.includes("g1 Archived goal"))).toBe(true);
  });

  it("does not repeat a clarification after the user answers", async () => {
    const { store } = await seedTwo();
    await routerWith(store, [{ toolCalls: [{ name: "ask_user", input: ask }] }]).router.route("Continue yesterday's project");
    const { router } = routerWith(store, [{ text: "bad" }, { text: "bad" }]);
    const result = await router.route("The German one");
    expect(result.kind).toBe("routed");
  });

  it("retains the actionable request when binding a clarification answer", async () => {
    const { store } = await seedTwo();
    const request = "Review yesterday's project for SQL injection and fix the unsafe queries.";
    await routerWith(store, [{ toolCalls: [{ name: "ask_user", input: ask }] }]).router.route(request);
    const result = await routerWith(store, [{ text: decision({ decision: "resume_existing", goal_label: "older_1", task_decision: "create_task", new_task_title: "Fix SQL injection" }) }]).router.route("The German one");
    if (result.kind !== "routed") throw new Error("Expected routing");
    expect(result.parts[0]!.request.includes(request)).toBe(true);
  });

  it("reopens a completed task when the user resumes it", async () => {
    const { store } = setup();
    const initial = await exchange(store, "Fix hero", createGoal("Website", "Fix hero"));
    if (initial.kind !== "routed") throw new Error("Expected routing");
    const taskId = initial.parts[0]!.task.id;
    store.reviseTask(taskId, { status: "completed" });
    const result = await routerWith(store, [continueTask(true)]).router.route("The hero regressed; fix it again");
    if (result.kind !== "routed") throw new Error("Expected routing");
    expect(result.parts[0]!.task.status).toBe("open");
  });

  it("applies ledger workspace filters before truncating FTS matches", () => {
    const { store } = setup();
    const other = store.createWorkspace("other");
    const desired = store.createWorkspace("desired");
    const noise = store.createGoal({ title: "Other work", workspaceId: other.id });
    for (let i = 0; i < 220; i++) store.createTask(noise.id, { title: "payments", objective: "payments" });
    const goal = store.createGoal({ title: "Target work", workspaceId: desired.id });
    store.createTask(goal.id, { title: "Repair integration", objective: "Fix payments retry failures in checkout integration." });
    expect(runLedgerQuery(store, { match: "payments", workspace: "desired" }, "UTC")).toHaveLength(1);
  });

  it("rejects a create_task instruction under the reserved general route", async () => {
    const { store } = setup();
    await exchange(store, "hi", general());
    const ctx = buildRoutingContext(store, "Build a website", { timeZone: "UTC" });
    const bad = decision({ decision: "continue_current", goal_label: "current", task_decision: "create_task", new_task_title: "Build website" });
    expect(validateDecisionText(bad, ctx, store, emptySeen()).ok).toBe(false);
  });

  it("records the canonical user-event binding in the event log", () => {
    const { store } = setup();
    const goal = store.createGoal({ title: "Website" });
    const task = store.createTask(goal.id, { title: "Checkout" });
    const a = store.recordUserMessage("request A");
    store.recordUserMessage("request B");
    const turn = store.bindTurn({ userEventId: a.id, taskId: task.id, route: "continue_current" });
    const event = store.listEvents({ type: "turn_bound", turnId: turn.id })[0]!;
    expect(JSON.stringify(event).includes(a.id)).toBe(true);
  });

  it("logs anchor lifecycle changes so the projection can be rebuilt", () => {
    const { store } = setup();
    const goal = store.createGoal({ title: "German" });
    const before = store.listEvents().length;
    store.upsertAnchor({ goalId: goal.id, path: "plan.md", role: "goal_plan", summary: "Curriculum", status: "active" });
    expect(store.listEvents().length).toBeGreaterThan(before);
  });

  it("keeps task objectives within the documented metadata budget", async () => {
    const { store } = setup();
    const result = await routerWith(store, [createGoal("Website", "Implement checkout")]).router.route("Implement checkout. " + "Acceptance criterion. ".repeat(500));
    if (result.kind !== "routed") throw new Error("Expected routing");
    expect(countTokens(result.parts[0]!.task.objective)).toBeLessThanOrEqual(25);
  });

  it("grades compound ownership and dependencies rather than part count alone", async () => {
    const { store } = setup();
    await exchange(store, "Review memory", createGoal("Socrates development", "Review memory"));
    const base = { goal_label: "current", new_goal_title: null, task_decision: "create_task", task_label: null, workspace_confidence: "high", reason: "wrong work", depends_on: [] };
    const result = await routerWith(store, [{ text: decision({ decision: "compound", workspace_confidence: null, parts: [
      { ...base, order: 1, request: "Redesign logo", decision: "continue_current", new_task_title: "Redesign logo" },
      { ...base, order: 2, request: "Create pricing page", decision: "continue_current", new_task_title: "Create pricing page" },
    ] as never }) }]).router.route(Q_SCENARIO.steps[9]!.message);
    expect(grade(Q_SCENARIO.steps[9]!.expect, result)).toBe(false);
  });

});

describe("clarification recovery and completed-task intent", () => {
  it("keeps a completed task completed for a question about its output", async () => {
    const {store} = setup();
    const initial = await exchange(store, "Fix hero", createGoal("Website", "Fix hero"));
    if (initial.kind !== "routed") throw new Error("Expected route");
    const taskId = initial.parts[0]!.task.id;
    store.reviseTask(taskId, {status: "completed"});
    const result = await routerWith(store, [continueTask(false)]).router.route("What file did you change?");
    if (result.kind !== "routed") throw new Error("Expected route");
    expect(result.fallback).toBeNull();
    expect(result.parts[0]!.task.status).toBe("completed");
    expect(result.parts[0]!.task.completedAt).not.toBeNull();
  });

  it("requires an explicit reopen choice for a completed task and repairs it", async () => {
    const {store} = setup();
    const initial = await exchange(store, "Fix hero", createGoal("Website", "Fix hero"));
    if (initial.kind !== "routed") throw new Error("Expected route");
    store.reviseTask(initial.parts[0]!.task.id, {status: "completed"});
    const missing = {text: decision({decision: "continue_current", goal_label: "current", task_decision: "continue_task", task_label: "current"})};
    const {router, routerModel} = routerWith(store, [missing, continueTask(true)]);
    const result = await router.route("The hero regressed; fix it again.");
    expect(routerModel.requests).toHaveLength(2);
    expect(result.kind === "routed" && result.parts[0]!.task.status).toBe("open");
  });

  it("recovers a numeric candidate answer using the persisted binding", async () => {
    const {store} = await seedTwo();
    await routerWith(store, [{toolCalls: [{name: "ask_user", input: ask}]}]).router.route("Review yesterday's project.");
    const result = await routerWith(store, [{text: "bad"}, {text: "bad"}]).router.route("The second one.");
    if (result.kind !== "routed") throw new Error("Expected route");
    expect(result.parts[0]!.goal.title).toBe("German");
    expect(result.parts[0]!.request).toBe("Review yesterday's project.");
    expect(result.parts[0]!.clarification?.answer).toBe("The second one.");
  });

  it("retains pending clarification even when its exchange exceeds the history budget", async () => {
    const {store} = await seedTwo();
    await routerWith(store, [{toolCalls: [{name: "ask_user", input: ask}]}]).router.route("Review yesterday's project. " + "Criteria. ".repeat(200));
    const ctx = buildRoutingContext(store, "German", {timeZone: "UTC", historyBudgetTokens: 1});
    expect(ctx.answeringClarification).toBe(true);
    expect(ctx.pending?.request).toContain("Review yesterday's project.");
  });
});
