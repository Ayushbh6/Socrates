import type { SemanticHit, SemanticQuery, SemanticSearch } from "@socrates/retrieval";
import { ScriptedModel } from "@socrates/providers";
import { describe, expect, it } from "vitest";
import { GoalRouter, selectOlderCandidates } from "../src";
import { TZ, createGoal, exchange, general, setup } from "./helpers";

/** docs/visible-routing-plan.md, R3: candidate goals are also searched with the user's previous message. */
const goalHit = (goalId: string, similarity = 0.4): SemanticHit => ({ kind: "goal", sourceId: goalId, goalId, taskId: null, turnId: null, projectTurn: null, at: "", similarity });

async function threeGoals() {
  const { store, clock } = setup();
  await exchange(store, "Start my German course.", createGoal("German flashcard app", "Day 1"), "ok");
  clock.advance(10 * 86_400_000);
  await exchange(store, "Fix the checkout bug.", createGoal("Shop checkout", "Cart limit"), "ok");
  await exchange(store, "Plan the garden beds.", createGoal("Garden planning", "Beds"), "ok");
  await exchange(store, "Sort the tax receipts.", createGoal("Tax filing", "Receipts"), "ok");
  clock.advance(10 * 86_400_000);
  const id = (title: string) => store.listGoals().find((g) => g.title === title)!.id;
  return { store, id };
}

describe("candidate goals from the previous message", () => {
  it("bring a follow-up the goal named just before, after the current message's own matches", async () => {
    const { store, id } = await threeGoals();
    const now = store.clock.now();
    const follow = "ok and add a test for that one too";
    expect(selectOlderCandidates(store, follow, now, null, [goalHit(id("Shop checkout")), goalHit(id("Garden planning")), goalHit(id("Tax filing"))]).map((g) => g.title)).not.toContain("German flashcard app");
    const withPrevious = selectOlderCandidates(store, follow, now, null, [goalHit(id("Shop checkout")), goalHit(id("Garden planning")), goalHit(id("Tax filing"))], { message: "How is the German flashcard app doing?", semantic: [goalHit(id("German flashcard app"))] });
    expect(withPrevious.map((g) => g.title)).toContain("German flashcard app");
  });

  it("never outrank a goal the current message names itself", async () => {
    const { store, id } = await threeGoals();
    const picked = selectOlderCandidates(store, "fix the checkout cart", store.clock.now(), null, [goalHit(id("Shop checkout"))], { message: "German flashcard app", semantic: [goalHit(id("German flashcard app"))] });
    expect(picked[0]!.title).toBe("Shop checkout");
  });

  it("is the previous message of the same conversation, skipping replies and Standard chats", () => {
    const { store } = setup();
    store.recordUserMessage("Main one", null);
    store.recordUserMessage("Lane one", "lane_x");
    store.recordUserMessage("", null);
    const now = store.recordUserMessage("Current", null);
    expect(store.previousUserMessage(now.seq, null)).toBe("Main one");
    expect(store.previousUserMessage(now.seq, "lane_x")).toBe("Lane one");
    expect(store.previousUserMessage(1, null)).toBeNull();
  });

  it("is searched beside the message, but not when answering a routing question", async () => {
    const { store } = setup();
    const queries: string[] = [];
    const semantic: SemanticSearch = { async search(query: string, _filter: SemanticQuery) { queries.push(query); return []; } };
    const router = new GoalRouter({ store, routerModel: new ScriptedModel("test:router", [general(), general()]), timeZone: TZ, semantic });
    await router.route("Tell me about the German app");
    await router.route("and the tests?");
    expect(queries).toEqual(["Tell me about the German app", "and the tests?", "Tell me about the German app"]);
  });
});
