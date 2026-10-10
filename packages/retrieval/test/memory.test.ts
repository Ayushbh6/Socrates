import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HashEmbedder } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import { afterEach, describe, expect, it } from "vitest";
import { Retrieval, type SemanticHit, rankMemories, stem, wherePredicate } from "../src";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function memories() {
  const store = LedgerStore.open({ path: ":memory:" });
  cleanups.push(() => store.close());
  const shop = store.createGoal({ title: "Shop" });
  const other = store.createGoal({ title: "Other" });
  const save = (text: string, goalId: string | null = null) => store.saveMemory({ kind: "knowledge", goalId, text, by: "user" }).memory;
  return { store, shop, other, save };
}
const hit = (sourceId: string, similarity: number): SemanticHit => ({ kind: "memory", sourceId, goalId: null, taskId: null, turnId: null, projectTurn: null, at: "2026-10-10T00:00:00Z", similarity });

describe("ranking memories", () => {
  it("offers an entry unasked only on a strong meaning match, a weaker one with a shared word, or two shared words", () => {
    const { store, shop, other, save } = memories();
    const trip = save("The Berlin trip is from 14 to 18 March.");
    const car = save("The car's next service is due at 60,000 km.");
    const stripe = save("Stripe is the payment provider.", shop.id);
    const flights = save("Flights to Berlin leave Vienna at 7:10.", other.id);
    const rent = save("Rent is due on the 3rd of each month.");
    const rank = (query: string, semantic: SemanticHit[], strict = true, goalId: string | null = shop.id) =>
      rankMemories(store, { query, goalId, semantic, strict, meaningFloor: 0.35, weakFloor: 0.3, limit: 4, now: new Date() }).map((r) => r.memory.handle);

    // Meaning alone, at the floor; a weaker match needs a shared word.
    expect(rank("When do I travel?", [hit(trip.id, 0.4)])).toEqual([trip.handle]);
    expect(rank("When do I travel?", [hit(trip.id, 0.32)])).toEqual([]);
    expect(rank("Add Apple Pay to the payment options.", [hit(stripe.id, 0.34)])).toEqual([stripe.handle]);
    // One common shared word with a weak match is not enough; two shared words are, without meaning.
    expect(rank("Plan the next six weeks of training.", [hit(car.id, 0.27)])).toEqual([]);
    expect(rank("When is the car service?", [])).toEqual([car.handle]);
    expect(rank("When is my rent due?", [])).toEqual([rent.handle]);
    // Another goal's entry never applies here; asked on purpose, any match counts.
    expect(rank("Berlin flights", [hit(flights.id, 0.6)])).toEqual([]);
    expect(rank("Berlin flights", [hit(flights.id, 0.6)], true, other.id)).toContain(flights.handle);
    expect(rank("When is it due?", [hit(rent.id, 0.22)], false)).toEqual([rent.handle, car.handle]);
  });

  it("stems lightly and filters memory documents by place", () => {
    expect(["projects", "deployed", "running", "boxes", "is", "gas"].map(stem)).toEqual(["project", "deploy", "runn", "box", "is", "gas"]);
    expect(wherePredicate({ kinds: ["memory"], goalIdsOrNone: ["g1"] })).toBe("kind IN ('memory') AND (goal_id IS NULL OR goal_id IN ('g1'))");
    expect(wherePredicate({ kinds: ["memory"], goalIdsOrNone: [] })).toBe("kind IN ('memory') AND goal_id IS NULL");
  });

  it("keeps active memories in the meaning index, and drops forgotten ones and other goals' entries from a goal's search", async () => {
    const { store, shop, other, save } = memories();
    const cart = save("The checkout cart limit is 100 items.", shop.id);
    const basket = save("Buying a big basket needs a coupon.", other.id);
    const lesson = save("German lessons are on Tuesdays.");
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "socrates-memory-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const retrieval = await Retrieval.open({ store, embedder: new HashEmbedder({ concepts: [["checkout", "cart", "basket", "buying"], ["german", "lesson", "lessons"]] }), uri: dir, workspaceFiles: false, thresholds: { related: 0.1 } });
    cleanups.push(() => retrieval.close());
    await retrieval.idle();
    const found = async (goalId: string) => (await retrieval.search("cart checkout basket", { kinds: ["memory"], goalIdsOrNone: [goalId], limit: 5 })).map((h) => h.sourceId);
    expect(await found(shop.id)).toContain(cart.id);
    expect(await found(shop.id)).not.toContain(basket.id);
    store.forgetMemory(cart.id, "user");
    await retrieval.sync();
    expect(await found(shop.id)).not.toContain(cart.id);
    expect((await retrieval.search("german lesson", { kinds: ["memory"], goalIdsOrNone: [shop.id], limit: 5 })).map((h) => h.sourceId)).toEqual([lesson.id]);
  });
});
