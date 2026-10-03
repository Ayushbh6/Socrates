import { describe, expect, it } from "vitest";
import { buildRoutingContext } from "../src/context";
import { setup } from "./helpers";

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
