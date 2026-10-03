import type { SemanticHit, SemanticQuery, SemanticSearch } from "@socrates/retrieval";
import { ScriptedModel } from "@socrates/providers";
import { describe, expect, it } from "vitest";
import { GoalRouter, selectOlderCandidates } from "../src";
import { TZ, createGoal, exchange, setup } from "./helpers";

const goalHit = (goalId: string, similarity = 0.4, kind: "goal" | "task" = "goal"): SemanticHit => ({ kind, sourceId: goalId, goalId, taskId: null, turnId: null, projectTurn: null, at: "", similarity });

describe("meaning-based goal candidates", () => {
  it("shortlists a goal that matches only in meaning, fused with keyword matches", async () => {
    const { store, clock } = setup();
    await exchange(store, "Start my German course.", createGoal("Ongoing German learning", "Day 9"), "ok");
    clock.advance(10 * 86_400_000);
    await exchange(store, "Fix the checkout bug.", createGoal("Shop checkout", "Cart limit"), "ok");
    await exchange(store, "Plan the garden beds.", createGoal("Garden planning", "Beds"), "ok");
    clock.advance(10 * 86_400_000);
    const german = store.listGoals().find((g) => g.title === "Ongoing German learning")!;
    const shop = store.listGoals().find((g) => g.title === "Shop checkout")!;
    const now = store.clock.now();
    // Nothing older than a week, no shared words: keywords alone find nothing.
    expect(selectOlderCandidates(store, "let's start today's lesson", now, null)).toEqual([]);
    expect(selectOlderCandidates(store, "let's start today's lesson", now, null, [goalHit(german.id)]).map((g) => g.title)).toEqual(["Ongoing German learning"]);
    // A goal found both ways ranks above one found only one way.
    const both = selectOlderCandidates(store, "checkout", now, null, [goalHit(german.id, 0.5), goalHit(shop.id, 0.3, "task")]);
    expect(both.map((g) => g.title)).toEqual(["Shop checkout", "Ongoing German learning"]);
  });

  it("searches goals and tasks with the message, and routes normally when meaning search returns nothing", async () => {
    const { store } = setup();
    const queries: { query: string; filter: SemanticQuery }[] = [];
    const semantic: SemanticSearch = { async search(query, filter) { queries.push({ query, filter }); return []; } };
    const router = new GoalRouter({ store, routerModel: new ScriptedModel("test:router", [createGoal("German", "Lesson")]), timeZone: TZ, semantic });
    const result = await router.route("Let's start today's lesson");
    expect(result.kind).toBe("routed");
    expect(queries).toEqual([{ query: "Let's start today's lesson", filter: { kinds: ["goal", "task"], limit: 30 } }]);
  });
});
