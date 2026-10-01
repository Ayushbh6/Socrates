/**
 * Live routing eval: sends the Goal-router.md fixtures (Q1–Q12, T1–T10) to a
 * real model and grades where each message lands.
 *
 *   pnpm eval:router
 *
 * Select SOCRATES_PROVIDER (gemini by default), SOCRATES_ROUTER_MODEL,
 * optional SOCRATES_MAIN_MODEL ("none" disables escalation), and either
 * provider credentials or SOCRATES_ENV_FILE. Missing credentials fail the run.
 */
import { loadEvaluationEnvironment } from "./environment";
import { makeModel, PROVIDER_DEFAULTS, type Provider } from "@socrates/providers";
import { fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { GoalRouter } from "../src";
import { SCENARIOS, completeStep, describeExpectation, describeResult, grade, evaluationIdentities } from "./fixtures";

loadEvaluationEnvironment();
const provider = process.env.SOCRATES_PROVIDER ?? "gemini";

async function main(): Promise<number> {
  const defaults = PROVIDER_DEFAULTS[provider as Provider];
  if (!defaults) throw new Error(`Unknown SOCRATES_PROVIDER "${provider}". Use anthropic, openai, deepseek, openrouter, or gemini.`);
  if (!defaults.keys.some((k) => process.env[k])) {
    console.log(`Cannot run live router eval: set ${defaults.keys.join(" or ")} (provider: ${provider}).`);
    return 1;
  }
  const routerName = process.env.SOCRATES_ROUTER_MODEL ?? defaults.router;
  const mainName = process.env.SOCRATES_MAIN_MODEL ?? defaults.main;
  const routerModel = makeModel(provider, routerName);
  const mainModel = mainName === "none" || mainName === routerName ? undefined : makeModel(provider, mainName);
  console.log(`Router: ${routerModel.id}${mainModel ? `   Escalation: ${mainModel.id}` : ""}\n`);

  let passed = 0;
  let total = 0;
  for (const scenario of SCENARIOS) {
    console.log(`── ${scenario.name}`);
    const clock = fixedClock(scenario.start);
    const store = LedgerStore.open({ path: ":memory:", clock });
    scenario.seed?.(store, clock);
    clock.set(scenario.start);
    const router = new GoalRouter({ store, routerModel, ...(mainModel ? { mainModel } : {}), timeZone: "UTC" });

    const identities = evaluationIdentities();
    for (const step of scenario.steps) {
      clock.advance(120_000);
      total++;
      const started = Date.now();
      try {
        const result = await router.route(step.message);
        const ok = grade(step.expect, result, identities);
        if (ok) passed++;
        const flags = [result.escalated ? "escalated" : "", result.fallback ? `fallback:${result.fallback}` : ""].filter(Boolean).join(" ");
        console.log(
          `${ok ? "PASS" : "FAIL"}  ${step.id.padEnd(4)} ${String(Date.now() - started).padStart(6)}ms  ` +
            `expected ${describeExpectation(step.expect)}; got ${describeResult(result)}${flags ? `  [${flags}]` : ""}`,
        );
        if (!ok && result.kind === "routed") console.log(JSON.stringify({parts: result.parts.map(p => ({order: p.order, request: p.request, dependsOn: p.dependsOn, goal: p.goal.title, task: p.task.title, created: p.created}))}));
        if (result.fallback) console.log(JSON.stringify({validationErrors: (store.listEvents({type: "routing_completed"}).at(-1)!.payload as {validation_errors?: string[]}).validation_errors}));
        completeStep(store, step, result);
      } catch (error) {
        console.log(`ERROR ${step.id.padEnd(4)} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    store.close();
    console.log("");
  }
  console.log(`${passed}/${total} routing decisions correct.`);
  return passed === total ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
