import { describe, expect, it } from "vitest";
import type { EventPayloads } from "@socrates/contracts";
import { searchLabel } from "../src";
import { createGoal, decision, exchange, general, routerWith, setup } from "./helpers";

/** docs/visible-routing-plan.md, R1: the router's reason and searches reach the page. */
const boundReason = (store: ReturnType<typeof setup>["store"], turnId: string) =>
  (store.listEvents({ turnId, type: "turn_bound" })[0]!.payload as EventPayloads["turn_bound"]).reason;

describe("the routing reason the page shows", () => {
  it("is saved on the bound turn", async () => {
    const { store } = setup();
    const { router } = routerWith(store, [{ text: decision({ decision: "resume_existing", goal_label: "general", workspace_confidence: null, reason: "You're asking a quick question that isn't part of a project." }) }]);
    const result = await router.route("What date is next Monday?");
    if (result.kind !== "routed") throw new Error("Expected route");
    expect(boundReason(store, result.parts[0]!.turn.id)).toBe("You're asking a quick question that isn't part of a project.");
  });

  it("gives each part of a split message its own reason", async () => {
    const { store } = setup();
    const part = (order: number, title: string, reason: string) => ({
      order, request: title, decision: "create_new", goal_label: null, new_goal_title: title, new_goal_objective: `Deliver ${title}.`,
      task_decision: "create_task", task_label: null, new_task_title: title, new_task_objective: `${title}.`, new_task_completion_criteria: `${title} is done.`,
      workspace_confidence: "high", reason, depends_on: [],
    });
    const { router } = routerWith(store, [{ text: decision({ decision: "compound", workspace_confidence: null, parts: [part(1, "Plan a trip", "This is a new trip to plan."), part(2, "Fix the bike", "This is a separate bike repair.")] as never, reason: "Two separate things." }) }]);
    const result = await router.route("Plan a trip and Fix the bike");
    if (result.kind !== "routed") throw new Error("Expected route");
    expect(result.parts.map((p) => boundReason(store, p.turn.id))).toEqual(["This is a new trip to plan.", "This is a separate bike repair."]);
  });

  it("is left out for a harness fallback, whose reason is for Inspect", async () => {
    const { store } = setup();
    const { router } = routerWith(store, [{ text: "not json" }, { text: "still not json" }], [{ text: "nor this" }]);
    const result = await router.route("Start my German lessons");
    if (result.kind !== "routed") throw new Error("Expected route");
    expect((store.listEvents({ type: "routing_completed" }).at(-1)!.payload as EventPayloads["routing_completed"]).fallback).not.toBeNull();
    expect(boundReason(store, result.parts[0]!.turn.id)).toBeUndefined();
  });

  it("is left out when the harness had to fill it in", async () => {
    const { store } = setup();
    const { reason: _, ...unexplained } = JSON.parse(general().text) as Record<string, unknown>;
    const { router } = routerWith(store, [{ text: JSON.stringify(unexplained) }]);
    const result = await router.route("Hi there");
    if (result.kind !== "routed") throw new Error("Expected route");
    expect(boundReason(store, result.parts[0]!.turn.id)).toBeUndefined();
  });
});

describe("what a routing search looked for", () => {
  it("is reported with the searching stage", async () => {
    const { store } = setup();
    const { router } = routerWith(store, [{ toolCalls: [{ name: "ledger_query", input: { match: "headings list" } }] }, general()]);
    const stages: [string, string | undefined][] = [];
    await router.route("How is the headings list going?", undefined, { onProgress: (stage, detail) => stages.push([stage, detail]) });
    expect(stages).toContainEqual(["searching", "headings list"]);
  });

  it("names a goal or task by its title, else the dates", async () => {
    const { store } = setup();
    await exchange(store, "Review memory", createGoal("Socrates development", "Review memory"));
    expect(searchLabel(store, { goal: "g1" })).toBe("Socrates development");
    expect(searchLabel(store, { task: "g1/t1" })).toBe("Review memory");
    expect(searchLabel(store, { goal: "German" })).toBe("German");
    expect(searchLabel(store, { from: "2026-10-01", to: "2026-10-31" })).toBe("2026-10-01 to 2026-10-31");
    expect(searchLabel(store, { status: "open" })).toBeNull();
    expect(searchLabel(store, { limit: "x" })).toBeNull();
  });
});

describe("the router's thinking (R2)", () => {
  it("streams to a listener and is kept on the decision, across a search", async () => {
    const { store } = setup();
    const { router, routerModel } = routerWith(store, [
      { toolCalls: [{ name: "ledger_query", input: { match: "headings" } }], reasoning: "Maybe an earlier task has the headings." },
      { ...general(), reasoning: "Nothing matched, so this is a quick aside." },
    ]);
    const seen: string[] = [];
    await router.route("How are the headings going?", undefined, { onThinking: (text) => seen.push(text) });
    const both = "Maybe an earlier task has the headings.\n\nNothing matched, so this is a quick aside.";
    expect(seen.at(-1)).toBe(both);
    expect(seen.some((t) => t.length < both.length)).toBe(true);
    expect((store.listEvents({ type: "routing_completed" }).at(-1)!.payload as EventPayloads["routing_completed"]).thinking).toBe(both);
    expect(routerModel.requests.length).toBe(2);
  });

  it("is kept without a listener, and absent when the model gives none", async () => {
    const { store } = setup();
    const { router } = routerWith(store, [{ ...general(), reasoning: "A greeting." }]);
    await router.route("Hello");
    expect((store.listEvents({ type: "routing_completed" }).at(-1)!.payload as EventPayloads["routing_completed"]).thinking).toBe("A greeting.");
    const quiet = routerWith(store, [general()]);
    await quiet.router.route("Hi again");
    expect(store.listEvents({ type: "routing_completed" }).at(-1)!.payload).not.toHaveProperty("thinking");
  });
});
