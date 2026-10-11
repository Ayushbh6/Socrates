import { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { routerStats } from "../src/observe";

/** The Inspect panel that tracks avoidable router retries (G1). */
describe("router retry stats", () => {
  it("counts routings that needed a second answer, escalations, fallbacks and normalized answers, and groups the reasons", () => {
    const store = LedgerStore.open({ path: ":memory:" });
    const routed = (extra: Record<string, unknown>) =>
      store.appendEvent("routing_completed", { outcome: "decision", decision: {}, model: "m", attempts: 1, escalated: false, fallback: null, ledger_queries: 0, reason: "r", validation_errors: [], ...extra });
    routed({});
    routed({ normalized: ['general route: set aside task_label "current"; the harness picks the day\'s task.'] });
    routed({ validation_errors: ["openrouter:openai/gpt-6-luna: Return exactly one JSON object matching the routing schema, with no other text."] });
    routed({ validation_errors: ["openrouter:openai/gpt-6-luna: Return exactly one JSON object matching the routing schema, with no other text.", "deepseek:deepseek-flash: part 2: create_task requires new_task_title."], escalated: true, attempts: 2 });
    routed({ fallback: "continue_current", validation_errors: ["m: reason: Invalid input"] });
    const stats = routerStats(store, "all", new Date());
    expect(stats).toMatchObject({ routings: 5, repaired: 3, escalated: 1, fallbacks: 1, normalized: 1 });
    expect(stats.reasons[0]).toEqual({ reason: "Return exactly one JSON object matching the routing schema, with no other text.", count: 2 });
    expect(stats.reasons.map((r) => r.reason)).toContain("create_task requires new_task_title.");
    store.close();
  });
});
