import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import type { ModelMessage, ModelUsage } from "@socrates/providers"
import { computeUsageCost, createDefaultModelProvider } from "@socrates/providers"
import { ProviderCredentialStore } from "../src/services/providerCredentials"

const OPENROUTER_MODEL_ID = "deepseek/deepseek-v4-flash"
const DIRECT_DEEPSEEK_MODEL_ID = "deepseek-v4-flash"
const PROMPT_VERSION = "v2_conservative_semantic"
const DEFAULT_ROUNDS = 3
const DEFAULT_MAX_COST_USD = 0.05
const RECENT_ELIGIBLE_POST_ROUTER_COST_USD = 0.00052085

const decisionSchema = z.enum(["skip_candidate", "required"])
type Decision = z.infer<typeof decisionSchema>

const outputSchema = z
  .object({
    postReview: decisionSchema,
    reason: z.string().min(1).max(500),
  })
  .strict()

const fixtureSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9_]+$/),
    gold: decisionSchema,
    projectName: z.string().min(1),
    projectDescription: z.string().min(1),
    recentMessages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1),
          })
          .strict(),
      )
      .max(8),
    userMessage: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict()

const datasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    description: z.string().min(1),
    fixtures: z.array(fixtureSchema).length(30),
  })
  .strict()

type Fixture = z.infer<typeof fixtureSchema>
type AttemptResult = {
  fixtureId: string
  gold: Decision
  round: number
  prediction?: Decision
  reason?: string
  correct: boolean
  latencyMs: number
  usage?: ReturnType<typeof compactUsage>
  directDeepSeekCounterfactualCostUsd?: number
  error?: string
}

const SYSTEM_PROMPT = `You are evaluating whether Socrates must run its post-evidence Memory Router after completing the current user request.

Return exactly one semantic decision:
- required: The conversation itself establishes, revises, corrects, retires, or explicitly asks to preserve durable state. This includes lasting project decisions, contracts, hard rules, collaboration preferences, blockers, milestones, handoff/restart state, or corrections to stale memory/docs.
- skip_candidate: Nothing in the conversation itself requires durable reconciliation. This includes ordinary questions, explanations, advice, brainstorming, rewrites, status checks, and read-only investigations whose need for reconciliation depends only on what execution later discovers.

skip_candidate never means "unimportant" or "never run the post-router." The backend will override it and run post-review if execution produces any model-visible tool call, mutation, memory note, failure, unresolved task, wait, or resumption. Judge only whether the conversation itself makes post-review mandatory even if execution is otherwise uneventful.

The user does not need to say "remember this" or ask for a document edit. A statement that settles a lasting rule, preference, decision, correction, blocker, milestone, or restart point is required by meaning alone. If you are genuinely uncertain whether the conversation establishes one of those durable categories, choose required. Conversely, merely asking how memory, caching, docs, or a system contract works does not establish durable state. A one-off question, explanation, summary, critique, or rewrite remains skip_candidate unless it also settles a lasting rule or state change.

Use the complete semantic meaning and recent context, not keywords. A temporary instruction such as "do not edit yet" is not automatically a durable preference. A genuine memory opt-out blocks the opted-out content. If one message opts out personal material but separately establishes an allowed durable repository decision, return required for the allowed decision.

The latest user message is the primary signal. Project description and recent messages only resolve references and whether a statement is a new decision or merely a question. Your decision and reason must agree: if the reason identifies durable state, the decision must be required. Return one concise reason without proposing memory edits.`

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const args = parseArgs(process.argv.slice(2))
const rounds = positiveInteger(args.rounds ?? String(DEFAULT_ROUNDS), "rounds")
const limit = positiveInteger(args.limit ?? "30", "limit")
const maxCostUsd = positiveNumber(args.maxCost ?? String(DEFAULT_MAX_COST_USD), "max-cost")
const dryRun = args.dryRun === "true"
const datasetPath = path.resolve(args.dataset ?? path.join(repoRoot, "evals/memory-router-gate/golden-dataset.json"))
const outputPath = path.resolve(args.out ?? path.join(repoRoot, `evals/memory-router-gate/results/openrouter-deepseek-v4-flash-${PROMPT_VERSION}.json`))

const dataset = datasetSchema.parse(JSON.parse(fs.readFileSync(datasetPath, "utf8")))
validateDataset(dataset.fixtures)
const selected = dataset.fixtures.slice(0, Math.min(limit, dataset.fixtures.length))

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        datasetPath,
        fixtures: selected.length,
        rounds,
        attempts: selected.length * rounds,
        promptVersion: PROMPT_VERSION,
        gold: countBy(selected.map((fixture) => fixture.gold)),
        model: { providerId: "openrouter", modelId: OPENROUTER_MODEL_ID, thinkingEnabled: false, thinkingEffort: "none" },
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

await main()

async function main() {
  const credentials = new ProviderCredentialStore({ socratesHome: path.join(os.homedir(), ".Socrates") })
  const credentialStatus = credentials.check("openrouter")
  if (!credentialStatus.configured) {
    throw new Error("OpenRouter credential is not configured in the Socrates credential store.")
  }

  const provider = createDefaultModelProvider(credentials)
  if (!provider.generateStructured) {
    throw new Error("The configured provider stack does not support structured generation.")
  }

  console.log(
    JSON.stringify(
      {
        status: "starting",
        fixtures: selected.length,
        rounds,
        attempts: selected.length * rounds,
        promptVersion: PROMPT_VERSION,
        credential: { providerId: "openrouter", configured: true, source: credentialStatus.source },
        model: { providerId: "openrouter", modelId: OPENROUTER_MODEL_ID, thinkingEnabled: false, thinkingEffort: "none" },
        maxCostUsd,
      },
      null,
      2,
    ),
  )

  const attempts: AttemptResult[] = []
  let actualOpenRouterCostUsd = 0
  let directDeepSeekCounterfactualCostUsd = 0

  for (const fixture of selected) {
    for (let round = 1; round <= rounds; round += 1) {
      const startedAt = Date.now()
      try {
        const result = await provider.generateStructured({
          providerId: "openrouter",
          modelId: OPENROUTER_MODEL_ID,
          sessionId: "eval_memory_router_gate",
          modelCallId: `eval_memory_router_gate_${fixture.id}_${round}`,
          cacheKey: `eval-memory-router-post-review-${PROMPT_VERSION}`,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: renderFixture(fixture) }],
          runtimeConfig: {
            providerId: "openrouter",
            authMode: "api_key",
            modelId: OPENROUTER_MODEL_ID,
            thinkingEnabled: false,
            thinkingEffort: "none",
            approvalMode: "read_only_auto",
            sandboxMode: "read_only",
          },
          schema: outputSchema,
        })
        const output = outputSchema.parse(result.output)
        const usage = compactUsage(result.usage)
        const directCost = result.usage
          ? computeUsageCost("deepseek", DIRECT_DEEPSEEK_MODEL_ID, result.usage).costUsd
          : undefined
        actualOpenRouterCostUsd += usage?.costUsd ?? 0
        directDeepSeekCounterfactualCostUsd += directCost ?? 0
        if (actualOpenRouterCostUsd > maxCostUsd) {
          throw new Error(`OpenRouter budget guard exceeded $${maxCostUsd.toFixed(6)}.`)
        }
        const attempt: AttemptResult = {
          fixtureId: fixture.id,
          gold: fixture.gold,
          round,
          prediction: output.postReview,
          reason: output.reason,
          correct: output.postReview === fixture.gold,
          latencyMs: Date.now() - startedAt,
          ...(usage ? { usage } : {}),
          ...(directCost === undefined ? {} : { directDeepSeekCounterfactualCostUsd: directCost }),
        }
        attempts.push(attempt)
        console.log(
          `[${attempt.correct ? "PASS" : "FAIL"}] ${fixture.id} round=${round} gold=${fixture.gold} predicted=${output.postReview} ` +
            `latency=${attempt.latencyMs}ms cost=${formatUsd(usage?.costUsd)} route=${usage?.routedProvider ?? "unknown"}`,
        )
      } catch (error) {
        const attempt: AttemptResult = {
          fixtureId: fixture.id,
          gold: fixture.gold,
          round,
          correct: false,
          latencyMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }
        attempts.push(attempt)
        console.log(`[ERROR] ${fixture.id} round=${round}: ${attempt.error}`)
      }
    }
  }

  const summary = summarize(selected, attempts, actualOpenRouterCostUsd, directDeepSeekCounterfactualCostUsd)
  const report = {
    schemaVersion: 1,
    startedFrom: {
      datasetPath,
      fixtures: selected.length,
      rounds,
      promptVersion: PROMPT_VERSION,
      model: { providerId: "openrouter", modelId: OPENROUTER_MODEL_ID, thinkingEnabled: false, thinkingEffort: "none" },
      credentialSource: credentialStatus.source,
      systemPrompt: SYSTEM_PROMPT,
    },
    completedAt: new Date().toISOString(),
    fixtures: selected,
    attempts,
    summary,
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n${JSON.stringify({ outputPath, summary }, null, 2)}`)
  if (summary.errors > 0) process.exitCode = 1
}

function renderFixture(fixture: Fixture): string {
  const recent = fixture.recentMessages.length === 0
    ? "(none)"
    : fixture.recentMessages
        .map((message, index) => `## ${index + 1}. ${message.role}\n${message.content}`)
        .join("\n\n")
  return [
    "# Active Project",
    `name: ${fixture.projectName}`,
    `description: ${fixture.projectDescription}`,
    "",
    "# Latest User Message",
    fixture.userMessage,
    "",
    "# Recent Visible Messages",
    recent,
  ].join("\n")
}

function compactUsage(usage: ModelUsage | undefined) {
  if (!usage) return undefined
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    uncachedInputTokens: usage.uncachedInputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    costUsd: usage.costUsd,
    costSource: usage.costSource,
    routedProvider: usage.routedProvider,
    pricingSnapshot: usage.pricingSnapshot,
  }
}

function summarize(
  fixtures: Fixture[],
  attempts: AttemptResult[],
  actualOpenRouterCostUsd: number,
  directDeepSeekCounterfactualCostUsd: number,
) {
  const completed = attempts.filter((attempt): attempt is AttemptResult & { prediction: Decision } => Boolean(attempt.prediction))
  const errors = attempts.length - completed.length
  const trueRequired = completed.filter((attempt) => attempt.gold === "required" && attempt.prediction === "required").length
  const falseRequired = completed.filter((attempt) => attempt.gold === "skip_candidate" && attempt.prediction === "required").length
  const trueSkip = completed.filter((attempt) => attempt.gold === "skip_candidate" && attempt.prediction === "skip_candidate").length
  const unsafeSkips = completed.filter((attempt) => attempt.gold === "required" && attempt.prediction === "skip_candidate")
  const correct = trueRequired + trueSkip
  const fixtureDetails = fixtures.map((fixture) => {
    const rows = completed.filter((attempt) => attempt.fixtureId === fixture.id)
    const predictions = rows.map((attempt) => attempt.prediction)
    const requiredVotes = predictions.filter((value) => value === "required").length
    const skipVotes = predictions.filter((value) => value === "skip_candidate").length
    const majority = requiredVotes >= skipVotes ? "required" : "skip_candidate"
    return {
      id: fixture.id,
      gold: fixture.gold,
      predictions,
      unanimous: new Set(predictions).size === 1 && predictions.length > 0,
      allCorrect: rows.length > 0 && rows.every((attempt) => attempt.correct),
      majority,
      majorityCorrect: majority === fixture.gold,
    }
  })
  const latencies = completed.map((attempt) => attempt.latencyMs).sort((a, b) => a - b)
  const inputTokens = sum(completed.map((attempt) => attempt.usage?.inputTokens ?? 0))
  const outputTokens = sum(completed.map((attempt) => attempt.usage?.outputTokens ?? 0))
  const cachedInputTokens = sum(completed.map((attempt) => attempt.usage?.cachedInputTokens ?? 0))
  const predictedSkipCount = trueSkip + unsafeSkips.length
  const actualRequiredCount = trueRequired + unsafeSkips.length
  const accuracy = ratio(correct, completed.length)
  const requiredRecall = ratio(trueRequired, actualRequiredCount)
  const skipPrecision = ratio(trueSkip, predictedSkipCount)
  const fixtureUnanimity = ratio(fixtureDetails.filter((fixture) => fixture.unanimous).length, fixtureDetails.length)
  const majorityAccuracy = ratio(fixtureDetails.filter((fixture) => fixture.majorityCorrect).length, fixtureDetails.length)
  const classificationReady =
    errors === 0 &&
    unsafeSkips.length === 0 &&
    accuracy >= 0.95 &&
    requiredRecall === 1 &&
    skipPrecision >= 0.95 &&
    fixtureUnanimity >= 0.95
  return {
    attempts: attempts.length,
    completed: completed.length,
    errors,
    confusionMatrix: { trueRequired, falseRequired, trueSkip, unsafeSkipRequiredAsCandidate: unsafeSkips.length },
    accuracy,
    requiredRecall,
    skipPrecision,
    fixtureUnanimity,
    majorityAccuracy,
    perfectFixtures: fixtureDetails.filter((fixture) => fixture.allCorrect).length,
    unsafeSkipFixtures: [...new Set(unsafeSkips.map((attempt) => attempt.fixtureId))],
    nonUnanimousFixtures: fixtureDetails.filter((fixture) => !fixture.unanimous).map((fixture) => fixture.id),
    majorityFailures: fixtureDetails.filter((fixture) => !fixture.majorityCorrect).map((fixture) => fixture.id),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? 0 },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cachedInput: cachedInputTokens,
      cacheReadRatio: ratio(cachedInputTokens, inputTokens),
    },
    routedProviders: countBy(completed.map((attempt) => attempt.usage?.routedProvider ?? "unknown")),
    costComparison: {
      actualOpenRouterUsd: actualOpenRouterCostUsd,
      directDeepSeekCounterfactualUsd: directDeepSeekCounterfactualCostUsd,
      openRouterMinusDirectUsd: actualOpenRouterCostUsd - directDeepSeekCounterfactualCostUsd,
      openRouterVsDirectPercent:
        directDeepSeekCounterfactualCostUsd === 0
          ? undefined
          : ((actualOpenRouterCostUsd / directDeepSeekCounterfactualCostUsd) - 1) * 100,
      recentPostRouterCostAvoidedPerEligibleTurnUsd: RECENT_ELIGIBLE_POST_ROUTER_COST_USD,
      benchmarkCallsAreEvalOnly: true,
      productionClassifierWouldReuseExistingPreRouterCall: true,
    },
    thresholds: {
      errors: 0,
      unsafeSkips: 0,
      minimumAccuracy: 0.95,
      requiredRecall: 1,
      minimumSkipPrecision: 0.95,
      minimumFixtureUnanimity: 0.95,
    },
    classificationReadyForShadowIntegration: classificationReady,
    recommendation: classificationReady
      ? "Proceed to a production-shadow integration test; do not enable skipping until the deterministic execution overrides are wired and verified."
      : "Do not integrate yet; inspect the listed failures and revise the semantic decision contract or fixtures first.",
    fixtureDetails,
  }
}

function validateDataset(fixtures: Fixture[]) {
  const ids = fixtures.map((fixture) => fixture.id)
  if (new Set(ids).size !== ids.length) throw new Error("Fixture ids must be unique.")
  const labels = countBy(fixtures.map((fixture) => fixture.gold))
  if (labels.skip_candidate !== 15 || labels.required !== 15) {
    throw new Error(`Expected a balanced 15/15 dataset, received ${JSON.stringify(labels)}.`)
  }
  for (const fixture of fixtures) {
    const visible = `${fixture.userMessage}\n${fixture.recentMessages.map((message) => message.content).join("\n")}`.toLowerCase()
    if (visible.includes("skip_candidate") || visible.includes("postreview: required")) {
      throw new Error(`Fixture ${fixture.id} leaks classifier labels into model-visible conversation text.`)
    }
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const argument of argv) {
    if (argument === "--dry-run") {
      parsed.dryRun = "true"
      continue
    }
    const match = argument.match(/^--([^=]+)=(.*)$/)
    if (!match) throw new Error(`Unknown argument: ${argument}`)
    parsed[toCamelCase(match[1]!)] = match[2]!
  }
  return parsed
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`--${label} must be a positive integer.`)
  return parsed
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${label} must be a positive number.`)
  return parsed
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1
    return counts
  }, {})
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))] ?? 0
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? "unknown" : `$${value.toFixed(8)}`
}
