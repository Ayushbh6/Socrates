import { ScriptedModel } from "@socrates/providers";
import { fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { GoalRouter } from "../src";
import { SCENARIOS, completeStep, describeExpectation, describeResult, grade } from "../eval/fixtures";

/**
 * Replays every Goal-router.md fixture with its oracle answer through the
 * real context builder, validator, and binder. A failure means the fixture's
 * expected decision is not expressible or not valid in the context the router
 * actually sees—a design bug, not a model bug.
 */
describe("Goal-router.md fixtures (oracle replay)", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const clock = fixedClock(scenario.start);
      const store = LedgerStore.open({ path: ":memory:", clock });
      scenario.seed?.(store, clock);
      clock.set(scenario.start);

      for (const step of scenario.steps) {
        clock.advance(120_000);
        const oracle = step.oracle;
        const model = new ScriptedModel("oracle", [
          "decision" in oracle ? { text: JSON.stringify(oracle.decision) } : { toolCalls: [{ name: "ask_user", input: oracle.ask }] },
        ]);
        const router = new GoalRouter({ store, routerModel: model, timeZone: "UTC" });
        const result = await router.route(step.message);
        expect({ step: step.id, fallback: result.fallback }).toEqual({ step: step.id, fallback: null });
        expect(`${step.id}: ${describeResult(result)}`).toSatisfy(() => grade(step.expect, result), `${step.id} expected ${describeExpectation(step.expect)}`);
        completeStep(store, step, result);
      }
    });
  }
});
