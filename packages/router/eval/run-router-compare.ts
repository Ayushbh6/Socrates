/**
 * Compares routing models on stateful fixtures and recorded Q6/Q11 inputs:
 * for each model, how many decisions land where they should, how long a
 * decision takes, and what it costs (the price OpenRouter reports).
 *
 *   SOCRATES_ENV_FILE=.env pnpm eval:router-compare google/gemini-3.8-flash qwen/qwen3.8-flash
 *   ROUTER_EFFORT=off|minimal|low|medium|high   the thinking level asked of every model (default: the model's own)
 *   ROUTER_PROVIDER=openrouter                  the provider the model ids belong to (default)
 *   ROUTER_RUNS=3                               run every scenario this many times (default 1)
 *   ROUTER_ONLY=G1                              scenario prefix (R or R-Q6 for recorded cases)
 *
 * "repaired" counts decisions that needed a second answer (a rejected answer,
 * an escalation or a fallback): avoidable model calls the harness should keep
 * rare. "normalized" counts answers the harness accepted after setting aside a
 * field that selects nothing different (validate.ts, the general route).
 *
 * Models run side by side; each works through the scenarios in order.
 */
import { type CallRecord, type Effort, type EventPayloads } from "@socrates/contracts";
import { type Provider, makeModel, reportedCost, withRecording } from "@socrates/providers";
import { fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { GoalRouter } from "../src";
import { loadEvaluationEnvironment } from "./environment";
import { SCENARIOS, completeStep, describeExpectation, describeResult, evaluationIdentities, grade } from "./fixtures";
import { RECORDED_CASES, runRecordedCase } from "./recorded-fixtures";

loadEvaluationEnvironment();
const provider = (process.env.ROUTER_PROVIDER ?? "openrouter") as Provider;
const effort = process.env.ROUTER_EFFORT as Effort | undefined;
const models = process.argv.slice(2).filter((a) => a !== "--");
if (!models.length) throw new Error("Name at least one model, such as google/gemini-3.8-flash.");

const runs = Math.max(1, Number(process.env.ROUTER_RUNS ?? 1));
const scenarios = SCENARIOS.filter((s) => !process.env.ROUTER_ONLY || s.name.startsWith(process.env.ROUTER_ONLY));
const recorded = RECORDED_CASES.filter((s) => !process.env.ROUTER_ONLY || s.id.startsWith(process.env.ROUTER_ONLY));

interface Result { model: string; passed: number; total: number; ms: number[]; calls: number; promptTokens: number; outputTokens: number; costUsd: number; failures: string[]; errors: number; repaired: number; normalized: number; repairs: string[]; recorded: Record<string, { passed: number; total: number }> }

async function run(modelName: string): Promise<Result> {
  const r: Result = { model: modelName, passed: 0, total: 0, ms: [], calls: 0, promptTokens: 0, outputTokens: 0, costUsd: 0, failures: [], errors: 0, repaired: 0, normalized: 0, repairs: [], recorded: {} };
  const sink = (call: CallRecord) => {
    r.calls++;
    r.promptTokens += call.response?.usage.promptTokens ?? 0;
    r.outputTokens += call.response?.usage.outputTokens ?? 0;
    r.costUsd += reportedCost(call.response?.meta) ?? 0;
  };
  const routerModel = withRecording(makeModel(provider, modelName), sink);
  for (let run = 0; run < runs; run++) for (const scenario of scenarios) {
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
        if (process.env.ROUTER_PROGRESS) process.stderr.write(`${run+1} ${step.id} ${describeResult(result)}\n`);
        const routed = store.listEvents({ type: "routing_completed" }).at(-1)?.payload as EventPayloads["routing_completed"] | undefined;
        if (routed && (routed.validation_errors?.length || routed.escalated || routed.fallback)) {
          r.repaired++;
          r.repairs.push(`${step.id}: ${[...(routed.validation_errors ?? []), ...(routed.fallback ? [`fallback ${routed.fallback}`] : [])].join(" | ").slice(0, 240)}`);
        }
        if (routed?.normalized?.length) r.normalized++;
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
  for (let run = 0; run < runs; run++) for (const fixture of recorded) {
    const score = r.recorded[fixture.id] ??= { passed: 0, total: 0 };
    score.total++; r.total++;
    const started = Date.now();
    try {
      const result = await runRecordedCase(routerModel, fixture, effort);
      r.ms.push(Date.now() - started);
      if (result.passed) { score.passed++; r.passed++; }
      else r.failures.push(`${fixture.id} run ${run + 1} [${fixture.status}]: expected ${fixture.expectedGoal}/${fixture.expectedTask}; got ${result.detail}`);
      console.log(`${modelName} ${fixture.id} run ${run + 1}: ${result.passed ? "PASS" : "FAIL"} [${fixture.status}] ${result.detail}`);
    } catch (error) {
      r.errors++;
      r.failures.push(`${fixture.id} run ${run + 1}: ERROR ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
    }
  }
  return r;
}

const results = await Promise.all(models.map(run));
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };
console.log(`provider ${provider}, thinking ${effort ?? "model default"}\n`);
console.log(`${runs} run${runs === 1 ? "" : "s"} of ${[...scenarios.map((s) => s.name.split(" ")[0]), ...recorded.map(s => s.id)].join(", ")}\n`);
console.log("model".padEnd(34) + "correct   repaired  normalized  median     p90     calls  prompt   $ all  $/decision");
for (const r of results) {
  console.log(`${r.model.padEnd(34)}${`${r.passed}/${r.total}`.padEnd(10)}${String(r.repaired).padEnd(10)}${String(r.normalized).padEnd(12)}${`${q(r.ms, 0.5)}ms`.padEnd(9)}${`${q(r.ms, 0.9)}ms`.padEnd(8)}${String(r.calls).padEnd(7)}${`${Math.round(r.promptTokens / 1000)}k`.padEnd(8)}${r.costUsd.toFixed(4).padEnd(8)}${(r.costUsd / Math.max(1, r.total)).toFixed(5)}`);
}
for (const r of results) {
  const values = Object.values(r.recorded);
  console.log(`\n${r.model}: stateful scenarios ${r.passed - values.reduce((n, s) => n + s.passed, 0)}/${r.total - values.reduce((n, s) => n + s.total, 0)}`);
  for (const f of recorded) {
    const s = r.recorded[f.id]!;
    console.log(`  ${f.id}: ${s.passed}/${s.total} first decisions [${f.status}] — ${f.name}`);
  }
}
if (recorded.length) console.log("Recorded cases use frozen synthetic context with the current prompt/tools, without repairs or worker execution. R-Q6 remains unresolved regardless of this run's score.");
for (const r of results) if (r.failures.length) console.log(`\n${r.model}:\n  ${r.failures.join("\n  ")}`);
for (const r of results) if (r.repairs.length) console.log(`\n${r.model}, repairs:\n  ${r.repairs.join("\n  ")}`);
