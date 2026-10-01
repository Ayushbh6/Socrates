import { describe, expect, it } from "vitest";
import { countTokens } from "@socrates/shared";
import { runLedgerQuery } from "@socrates/store";
import { buildRoutingContext } from "../src/context";
import { GoalRouter } from "../src/router";
import { emptySeen, validateDecisionText } from "../src/validate";
import { Q_SCENARIO, grade } from "../eval/fixtures";
import { continueTask, createGoal, createTask, decision, defineTask, exchange, general, routerWith, setup } from "./helpers";

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
    const result = await routerWith(store, [{ text: decision({ decision: "resume_existing", goal_label: "older_1", task_decision: "create_task", new_task_title: "Fix SQL injection", ...defineTask("Fix SQL injection") }) }]).router.route("The German one");
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
    const bad = decision({ decision: "continue_current", goal_label: "current", task_decision: "create_task", new_task_title: "Build website", ...defineTask("Build website") });
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
      { ...base, order: 1, request: "Redesign logo", decision: "continue_current", new_task_title: "Redesign logo", ...defineTask("Redesign logo") },
      { ...base, order: 2, request: "Create pricing page", decision: "continue_current", new_task_title: "Create pricing page", ...defineTask("Create pricing page") },
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

describe("router-proposed task definitions", () => {
  it("requires an objective and completion criteria when creating, and persists them", async () => {
    const { store } = setup();
    const bare = decision({ decision: "create_new", new_goal_title: "Website", task_decision: "create_task", new_task_title: "Hero" });
    const { router, routerModel } = routerWith(store, [{ text: bare }, createGoal("Website", "Fix homepage hero on mobile")]);
    const result = await router.route("Fix the homepage hero on mobile for the website");
    const repair = routerModel.requests[1]!.messages.at(-1)!.content;
    expect(repair).toContain("new_goal_objective");
    if (result.kind !== "routed") throw new Error("Expected routing");
    expect(result.parts[0]!.goal.objective).toBe("Deliver Website.");
    expect(result.parts[0]!.task).toMatchObject({
      objective: "Fix homepage hero on mobile.",
      completionCriteria: "Fix homepage hero on mobile is done and verified.",
    });
  });

  it("rejects definitions on routes that create nothing", () => {
    const { store } = setup();
    const ctx = buildRoutingContext(store, "hi", { timeZone: "UTC" });
    const text = decision({ decision: "resume_existing", goal_label: "general", workspace_confidence: null, ...defineTask("Chat") });
    const result = validateDecisionText(text, ctx, store, emptySeen());
    expect(result.ok).toBe(false);
  });

  it("creates fallback tasks with an honest null completion criterion", async () => {
    const { store } = setup();
    const { router } = routerWith(store, [{ text: "garbage" }, { text: "garbage" }]);
    const result = await router.route("Build me a landing page for my bakery please");
    if (result.kind !== "routed") throw new Error("Expected routing");
    expect(result.fallback).toBe("first_goal");
    expect(result.parts[0]!.task.completionCriteria).toBeNull();
  });

  it("does not treat a candidate described as new as a request for new work", async () => {
    const { store } = await seedTwo();
    await routerWith(store, [{ toolCalls: [{ name: "ask_user", input: ask }] }]).router.route("Continue yesterday's project");
    const goalsBefore = store.listGoals().length;
    const { router } = routerWith(store, [{ text: "bad" }, { text: "bad" }]);
    const result = await router.route("the new website one");
    expect(result.kind).toBe("routed");
    expect(result.fallback).not.toBe("clarification_new_goal");
    expect(store.listGoals().length).toBe(goalsBefore);
  });
});

describe("equivalent labels that select the same target", () => {
  it("accepts a first-message greeting as continue_current to general with a stray workspace confidence", async () => {
    const { store } = setup();
    const { router, routerModel } = routerWith(store, [{ text: decision({ decision: "continue_current", goal_label: "general", workspace_confidence: "low" }) }]);
    const result = await router.route("Hi, how are you?");
    if (result.kind !== "routed") throw new Error("Expected route");
    expect(result.fallback).toBeNull();
    expect(routerModel.requests).toHaveLength(1);
    expect(result.parts[0]!.goal.general).toBe(true);
    expect(result.parts[0]!.turn.gateArmed).toBe(false);
  });

  it("still rejects a general route that tries to create a task", async () => {
    const { store } = setup();
    const bad = { text: decision({ decision: "resume_existing", goal_label: "general", task_decision: "create_task", new_task_title: "Chat", ...defineTask("Chat") }) };
    const { router, routerModel } = routerWith(store, [bad, general()]);
    const result = await router.route("Hi, how are you?");
    expect(routerModel.requests).toHaveLength(2);
    if (result.kind !== "routed") throw new Error("Expected route");
    expect(result.parts[0]!.goal.general).toBe(true);
  });

  it("accepts resume_existing with create_task in the current goal", async () => {
    const { store } = setup();
    const first = await exchange(store, "Review memory", createGoal("Socrates development", "Review memory"));
    if (first.kind !== "routed") throw new Error("Expected route");
    const step = { text: decision({ decision: "resume_existing", goal_label: "current", task_decision: "create_task", new_task_title: "Audit endpoints", ...defineTask("Audit endpoints") }) };
    const { router, routerModel } = routerWith(store, [step]);
    const result = await router.route("Now audit the endpoints.");
    if (result.kind !== "routed") throw new Error("Expected route");
    expect(routerModel.requests).toHaveLength(1);
    expect(result.parts[0]!.goal.id).toBe(first.parts[0]!.goal.id);
    expect(result.parts[0]!.created.task).toBe(true);
  });

  const compoundPart = (order: number, request: string, dependsOn?: number[]) => ({
    order, request, decision: "continue_current", goal_label: "current", task_decision: "create_task",
    task_label: null, new_task_title: request, ...defineTask(request), workspace_confidence: "high", reason: "separate work",
    ...(dependsOn ? { depends_on: dependsOn } : {}),
  });

  it("lets part 1 omit depends_on and every part omit new_goal_title", async () => {
    const { store } = setup();
    await exchange(store, "Review memory", createGoal("Socrates development", "Review memory"));
    const parts = [compoundPart(1, "Redesign logo"), compoundPart(2, "create pricing page", [1])];
    const { router, routerModel } = routerWith(store, [{ text: decision({ decision: "compound", workspace_confidence: null, parts: parts as never }) }]);
    const result = await router.route("Redesign logo, then create pricing page");
    if (result.kind !== "routed") throw new Error("Expected route");
    expect(routerModel.requests).toHaveLength(1);
    expect(result.parts.map((p) => p.dependsOn)).toEqual([[], [1]]);
  });

  it("requires a later part to state its dependencies", async () => {
    const { store } = setup();
    await exchange(store, "Review memory", createGoal("Socrates development", "Review memory"));
    const missing = [compoundPart(1, "Redesign logo"), compoundPart(2, "create pricing page")];
    const { router, routerModel } = routerWith(store, [{ text: decision({ decision: "compound", workspace_confidence: null, parts: missing as never }) }, continueTask()]);
    await router.route("Redesign logo, then create pricing page");
    const repair = routerModel.requests[1]!.messages.at(-1)!.content as string;
    expect(repair).toContain("part 2: depends_on is required");
  });
});
