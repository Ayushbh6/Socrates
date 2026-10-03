import { describe, expect, it } from "vitest";
import { buildRoutingContext } from "../src/context";
import { createGoal, decision, exchange, routerWith, setup } from "./helpers";

describe("routing in lanes", () => {
  it("a lane sees the main conversation and its own exchanges, never another lane's, and starts from main's current task", () => {
    const { store } = setup();
    const goal = store.createGoal({ title: "Shop" });
    const checkout = store.createTask(goal.id, { title: "Checkout" });
    const docs = store.createTask(goal.id, { title: "Docs" });
    const mine = store.openLane();
    const other = store.openLane();
    const exchange = (taskId: string, text: string, laneId: string | null) => {
      const turn = store.bindTurn({ userEventId: store.recordUserMessage(text, laneId).id, taskId, route: "test" });
      store.completeTurn(turn.id, { responseEventId: store.recordResponse("ok", { turn_id: turn.id }).id });
    };
    exchange(checkout.id, "Main: fix checkout.", null);
    exchange(docs.id, "Other lane: docs.", other.id);

    const fresh = buildRoutingContext(store, "Start something.", { timeZone: "UTC", laneId: mine.id });
    expect(fresh.current?.task.id).toBe(checkout.id);
    expect(fresh.input).toContain("Main: fix checkout.");
    expect(fresh.input).not.toContain("Other lane: docs.");

    exchange(docs.id, "My lane: docs too.", mine.id);
    const later = buildRoutingContext(store, "Next.", { timeZone: "UTC", laneId: mine.id });
    expect(later.current?.task.id).toBe(docs.id);
    expect(later.input).toContain("My lane: docs too.");
    const main = buildRoutingContext(store, "Next.", { timeZone: "UTC" });
    expect(main.current?.task.id).toBe(checkout.id);
    expect(main.input).not.toContain("docs");
  });
});

describe("routing with lanes beside the conversation", () => {
  it("shows open lanes with selectors it may route to, leaving out the routed lane, closed lanes, and lanes done a day ago", async () => {
    const { store, clock } = setup();
    const goal = store.createGoal({ title: "Shop" });
    const checkout = store.createTask(goal.id, { title: "Checkout" });
    const docs = store.createTask(goal.id, { title: "Docs" });
    const working = store.openLane();
    const done = store.openLane();
    const closed = store.openLane();
    store.bindTurn({ userEventId: store.recordUserMessage("Fix checkout.", working.id).id, taskId: checkout.id, route: "test" });
    const finished = store.bindTurn({ userEventId: store.recordUserMessage("Write docs.", done.id).id, taskId: docs.id, route: "test" });
    store.completeTurn(finished.id, { responseEventId: store.recordResponse("Docs written.", { turn_id: finished.id }).id });
    store.closeLane(closed.id);

    const ctx = buildRoutingContext(store, "How is it going?", { timeZone: "UTC" });
    expect(ctx.input).toContain(`<LANES>\nlane 1 — working — goal g1 "Shop" · task g1/t1 "Checkout" · workspace —\nlane 2 — finished at 10:00 — goal g1 "Shop" · task g1/t2 "Docs" · workspace —\n</LANES>`);
    expect(ctx.laneSelectors).toEqual({ goals: [1, 1], tasks: ["g1/t1", "g1/t2"] });
    expect(buildRoutingContext(store, "Next.", { timeZone: "UTC", laneId: working.id }).input).not.toContain("lane 1 —");

    clock.advance(25 * 3_600_000);
    const later = buildRoutingContext(store, "How is it going?", { timeZone: "UTC" });
    expect(later.input).toContain("lane 1 — working");
    expect(later.input).not.toContain("lane 2");
    store.closeLane(working.id);
    expect(buildRoutingContext(store, "How is it going?", { timeZone: "UTC" }).input).not.toContain("<LANES>");
  });

  it("routes to a lane's task with the selectors LANES shows, without a ledger query", async () => {
    const { store } = setup();
    await exchange(store, "Start the shop.", createGoal("Shop", "Checkout"));
    const other = await exchange(store, "Plan the garden.", createGoal("Garden", "Plan beds"));
    const lane = store.openLane();
    const shopTask = store.listTasks(store.listGoals().find((g) => g.title === "Shop")!.id)[0]!;
    store.bindTurn({ userEventId: store.recordUserMessage("Fix checkout.", lane.id).id, taskId: shopTask.id, route: "test" });
    expect(other.kind).toBe("routed");

    const { router, routerModel } = routerWith(store, [{ text: decision({ decision: "resume_existing", goal_label: "g1", task_decision: "resume_task", task_label: "g1/t1" }) }]);
    const routed = await router.route("Tell the checkout lane to also log errors.");
    expect(routed.kind === "routed" && routed.parts[0]!.task.id).toBe(shopTask.id);
    expect(routerModel.requests).toHaveLength(1);
  });
});
