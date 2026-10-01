import type { RouterDecision } from "@socrates/contracts";
import { ScriptedModel, type ScriptedStep } from "@socrates/providers";
import { fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { GoalRouter } from "../src";

export const TZ = "UTC";

export function setup(start = "2026-09-01T10:00:00Z") {
  const clock = fixedClock(start);
  const store = LedgerStore.open({ path: ":memory:", clock });
  return { store, clock };
}

export function decision(partial: Partial<RouterDecision> & Pick<RouterDecision, "decision">): string {
  return JSON.stringify({
    goal_label: null,
    new_goal_title: null,
    task_decision: null,
    task_label: null,
    new_task_title: null,
    workspace_confidence: "high",
    parts: null,
    reason: "test",
    ...partial,
  });
}

export const general = () => ({ text: decision({ decision: "resume_existing", goal_label: "general", workspace_confidence: null }) });
export const continueTask = () => ({ text: decision({ decision: "continue_current", goal_label: "current", task_decision: "continue_task", task_label: "current" }) });
export const createTask = (title: string) => ({
  text: decision({ decision: "continue_current", goal_label: "current", task_decision: "create_task", new_task_title: title }),
});
export const createGoal = (goal: string, task: string) => ({
  text: decision({ decision: "create_new", new_goal_title: goal, task_decision: "create_task", new_task_title: task }),
});

export function routerWith(store: LedgerStore, steps: ScriptedStep[], main?: ScriptedStep[]) {
  const routerModel = new ScriptedModel("test:router", steps);
  const mainModel = main ? new ScriptedModel("test:main", main) : undefined;
  const router = new GoalRouter({ store, routerModel, ...(mainModel ? { mainModel } : {}), timeZone: TZ });
  return { router, routerModel, mainModel };
}

/** Route a message with one scripted step, then complete the bound turns with a response and note. */
export async function exchange(
  store: LedgerStore,
  message: string,
  step: ScriptedStep,
  response = "ok",
  continuationNote?: string,
) {
  const { router } = routerWith(store, [step]);
  const result = await router.route(message);
  if (result.kind === "routed") {
    const reply = store.recordResponse(response);
    for (const part of result.parts) {
      store.completeTurn(part.turn.id, { responseEventId: reply.id, continuationNote: continuationNote ?? null });
    }
  }
  return result;
}
