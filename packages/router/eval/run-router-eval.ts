/**
 * Live routing eval: sends the Goal-router.md fixtures (Q1–Q12, T1–T10) to a
 * real model and grades where each message lands.
 *
 *   pnpm eval:router
 *
 * Configuration (environment):
 *   SOCRATES_PROVIDER      anthropic (default) | openai | deepseek
 *   SOCRATES_ROUTER_MODEL  routing model    (default: claude-haiku-4-5 / gpt-5-mini / deepseek-chat)
 *   SOCRATES_MAIN_MODEL    escalation model (default: claude-opus-5-5 / gpt-5 / deepseek-chat); "none" disables escalation
 *   ANTHROPIC_API_KEY | OPENAI_API_KEY | DEEPSEEK_API_KEY
 *
 * Exits 0 without running when no credentials are configured, 1 when any step fails.
 */
import type { ModelClient } from "@socrates/contracts";
import { AnthropicModel, OpenAICompatibleModel } from "@socrates/providers";
import { fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { GoalRouter } from "../src";
import { SCENARIOS, completeStep, describeExpectation, describeResult, grade } from "./fixtures";

const provider = process.env.SOCRATES_PROVIDER ?? "anthropic";

const DEFAULTS: Record<string, { router: string; main: string; key: string[] }> = {
  anthropic: { router: "claude-haiku-4-5", main: "claude-opus-5-5", key: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] },
  openai: { router: "gpt-5-mini", main: "gpt-5", key: ["OPENAI_API_KEY"] },
  deepseek: { router: "deepseek-chat", main: "deepseek-chat", key: ["DEEPSEEK_API_KEY"] },
};

function makeModel(name: string): ModelClient {
  switch (provider) {
    case "anthropic":
      return new AnthropicModel({ model: name });
    case "openai":
      return new OpenAICompatibleModel({ model: name, provider: "openai", sampling: false });
    case "deepseek":
      return new OpenAICompatibleModel({
        model: name,
        provider: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: process.env.DEEPSEEK_API_KEY!,
        maxTokensParam: "max_tokens",
      });
    default:
      throw new Error(`Unknown SOCRATES_PROVIDER "${provider}".`);
  }
}

async function main(): Promise<number> {
  const defaults = DEFAULTS[provider];
  if (!defaults) throw new Error(`Unknown SOCRATES_PROVIDER "${provider}". Use anthropic, openai, or deepseek.`);
  if (!defaults.key.some((k) => process.env[k])) {
    console.log(`Skipping live router eval: set ${defaults.key.join(" or ")} (provider: ${provider}).`);
    return 0;
  }
  const routerName = process.env.SOCRATES_ROUTER_MODEL ?? defaults.router;
  const mainName = process.env.SOCRATES_MAIN_MODEL ?? defaults.main;
  const routerModel = makeModel(routerName);
  const mainModel = mainName === "none" || mainName === routerName ? undefined : makeModel(mainName);
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

    for (const step of scenario.steps) {
      clock.advance(120_000);
      total++;
      const started = Date.now();
      try {
        const result = await router.route(step.message);
        const ok = grade(step.expect, result);
        if (ok) passed++;
        const flags = [result.escalated ? "escalated" : "", result.fallback ? `fallback:${result.fallback}` : ""].filter(Boolean).join(" ");
        console.log(
          `${ok ? "PASS" : "FAIL"}  ${step.id.padEnd(4)} ${String(Date.now() - started).padStart(6)}ms  ` +
            `expected ${describeExpectation(step.expect)}; got ${describeResult(result)}${flags ? `  [${flags}]` : ""}`,
        );
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
