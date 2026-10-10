/**
 * Compares routing models on the Goal-router.md fixtures (Q1–Q12, T1–T10):
 * for each model, how many decisions land where they should, how long a
 * decision takes, and what it costs (the price OpenRouter reports).
 *
 *   SOCRATES_ENV_FILE=.env pnpm eval:router-compare google/gemini-3.8-flash qwen/qwen3.8-flash
 *   ROUTER_EFFORT=off|minimal|low|medium|high   the thinking level asked of every model (default: the model's own)
 *   ROUTER_PROVIDER=openrouter                  the provider the model ids belong to (default)
 *
 * Models run side by side; each works through the scenarios in order.
 */
import { type CallRecord, type Effort } from "@socrates/contracts";
import { type Provider, makeModel, reportedCost, withRecording } from "@socrates/providers";
import { fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { GoalRouter } from "../src";
import { loadEvaluationEnvironment } from "./environment";
import { SCENARIOS, completeStep, describeExpectation, describeResult, evaluationIdentities, grade } from "./fixtures";

loadEvaluationEnvironment();
const provider = (process.env.ROUTER_PROVIDER ?? "openrouter") as Provider;
const effort = process.env.ROUTER_EFFORT as Effort | undefined;
const models = process.argv.slice(2).filter((a) => a !== "--");
if (!models.length) throw new Error("Name at least one model, such as google/gemini-3.8-flash.");

interface Result { model: string; passed: number; total: number; ms: number[]; calls: number; promptTokens: number; outputTokens: number; costUsd: number; failures: string[]; errors: number }

async function run(modelName: string): Promise<Result> {
  const r: Result = { model: modelName, passed: 0, total: 0, ms: [], calls: 0, promptTokens: 0, outputTokens: 0, costUsd: 0, failures: [], errors: 0 };
  const sink = (call: CallRecord) => {
    r.calls++;
    r.promptTokens += call.response?.usage.promptTokens ?? 0;
    r.outputTokens += call.response?.usage.outputTokens ?? 0;
    r.costUsd += reportedCost(call.response?.meta) ?? 0;
  };
  const routerModel = withRecording(makeModel(provider, modelName), sink);
  for (const scenario of SCENARIOS) {
    const clock = fixedClock(scenario.start);
    const store = LedgerStore.open({ path: ":memory:", clock });
    scenario.seed?.(store, clock);
    clock.set(scenario.start);
    const router = new GoalRouter({ store, routerModel, timeZone: "UTC", ...(effort ? { effort } : {}) });
    const identities = evaluationIdentities();
    for (const step of scenario.steps) {
      clock.advance(120_000);
      r.total++;
      const started = Date.now();
      try {
        const result = await router.route(step.message);
        r.ms.push(Date.now() - started);
        if (grade(step.expect, result, identities)) r.passed++;
        else r.failures.push(`${step.id}: expected ${describeExpectation(step.expect)}; got ${describeResult(result)}`);
        completeStep(store, step, result);
      } catch (error) {
        r.errors++;
        r.failures.push(`${step.id}: ERROR ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
      }
    }
    store.close();
  }
  return r;
}

const results = await Promise.all(models.map(run));
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };
console.log(`provider ${provider}, thinking ${effort ?? "model default"}\n`);
console.log("model".padEnd(34) + "correct   median     p90     calls  prompt   $ all  $/decision");
for (const r of results) {
  console.log(`${r.model.padEnd(34)}${`${r.passed}/${r.total}`.padEnd(10)}${`${q(r.ms, 0.5)}ms`.padEnd(9)}${`${q(r.ms, 0.9)}ms`.padEnd(8)}${String(r.calls).padEnd(7)}${`${Math.round(r.promptTokens / 1000)}k`.padEnd(8)}${r.costUsd.toFixed(4).padEnd(8)}${(r.costUsd / Math.max(1, r.total)).toFixed(5)}`);
}
for (const r of results) if (r.failures.length) console.log(`\n${r.model}:\n  ${r.failures.join("\n  ")}`);
