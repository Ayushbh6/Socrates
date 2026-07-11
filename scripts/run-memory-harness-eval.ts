import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import type { ProviderAuthMode, ProviderId, RuntimeConfig, ThinkingEffort, TraceRetrieveMainToolOutput } from "@socrates/contracts"
import {
  CompressorAgent,
  SocratesAgent,
  ToolRegistry,
  buildSocratesSystemPrompt,
  buildSocratesCompressorUserContent,
  renderChatCompactionMarkdown,
  type CompressorAgentModel,
  type CompressorTurnInput,
} from "@socrates/core"
import {
  createDefaultModelProvider,
  estimateTextTokens,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelUsage,
  type StructuredModelRequest,
  type StructuredModelResult,
} from "@socrates/providers"
import { createId } from "@socrates/shared"
import { ProviderCredentialStore } from "../apps/server/src/services/providerCredentials"
import { traceRetrieveTool } from "../packages/core/src/tools/traceRetrieveTool"
import { readTool } from "../packages/core/src/tools/readTool"
import { projectDocsTool } from "../packages/core/src/tools/projectDocsTool"
import type { ToolExecutors } from "../packages/core/src/tools/types"

type GoldenTurn = { turnNo: number; turnId: string; user: string; assistant: string; source: "codex_session" | "synthetic_canary" }
type GoldenDataset = { schemaVersion: 1; source: Record<string, unknown>; turns: GoldenTurn[]; checks: GoldenCheck[] }
type GoldenCheck = { id: string; required?: string[]; forbidden?: string[]; requiredConcepts?: string[] }
type EvalConfig = {
  id: string
  model: CompressorAgentModel
  providerGroup: "deepseek" | "openrouter" | "codex"
  inputRateUsdPerMillion: number
  outputRateUsdPerMillion: number
  rounds: number
}
type DownstreamSeed = { finalSummary: string; rounds: unknown[] }

const args = new Set(process.argv.slice(1))
const live = args.has("--live")
const downstreamOnly = args.has("--downstream-only")
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const datasetPath = path.join(repoRoot, "evals/memory-harness/private/golden-dataset.json")
if (!fs.existsSync(datasetPath)) throw new Error(`Missing ${datasetPath}; run node scripts/export-memory-harness-dataset.mjs first.`)
const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8")) as GoldenDataset

const configs: EvalConfig[] = [
  config("deepseek-flash-off", "deepseek", "deepseek-v4-flash", false, "none", "deepseek", 0.14, 0.28, 5),
  config("deepseek-pro-high", "deepseek", "deepseek-v4-pro", true, "high", "deepseek", 0.28, 0.42, 3),
  config("hy3-none", "openrouter", "tencent/hy3", false, "none", "openrouter", 0.14, 0.58, 2),
  config("hy3-high", "openrouter", "tencent/hy3", true, "high", "openrouter", 0.14, 0.58, 2),
  config("glm-5.2-high", "openrouter", "z-ai/glm-5.2", true, "high", "openrouter", 0.42, 1.32, 2),
  config("gpt-5.6-luna-medium", "openai", "gpt-5.6-luna", true, "medium", "codex", 0, 0, 3, "chatgpt_subscription"),
]
const onlyIds = [...args].find((arg) => arg.startsWith("--only="))?.slice("--only=".length).split(",").filter(Boolean)
const configsToRun = onlyIds ? configs.filter((item) => onlyIds.includes(item.id)) : configs
const roundOverride = Number([...args].find((arg) => arg.startsWith("--rounds="))?.slice("--rounds=".length)) || undefined

async function main() {
  console.log(JSON.stringify({ argv: [...args], live }))
  // The screenshot baseline was $0.86. Reserve $0.04 for any provider-side work
  // from interrupted duplicate launches before the process guard was fixed.
  const budget = new BudgetLedger({ deepseek: { start: 0.92, cap: 1.05 }, openrouter: { start: 0.05, cap: 1.5 } })
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    live,
    dataset: { ...dataset.source, turns: dataset.turns.length, checks: dataset.checks.length },
    budgets: budget.snapshot(),
    configs: configsToRun.map((item) => ({ id: item.id, model: item.model, providerGroup: item.providerGroup, rounds: item.rounds })),
    results: [] as unknown[],
  }
  if (!live) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  const credentials = new ProviderCredentialStore({ socratesHome: path.join(os.homedir(), ".Socrates") })
  const provider = createDefaultModelProvider(credentials)
  const outputPath = path.join(repoRoot, "evals/memory-harness/results/live-results.json")
  const downstreamSeeds = downstreamOnly && fs.existsSync(outputPath)
    ? new Map(((JSON.parse(fs.readFileSync(outputPath, "utf8")) as { results?: Array<{ id?: string; finalSummary?: string; rounds?: unknown[] }> }).results ?? [])
      .filter((result): result is { id: string; finalSummary: string; rounds?: unknown[] } => Boolean(result.id && result.finalSummary))
      .map((result) => [result.id, { finalSummary: result.finalSummary, rounds: result.rounds ?? [] } satisfies DownstreamSeed]))
    : new Map<string, DownstreamSeed>()
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify({ ...report, partial: true }, null, 2)}\n`)
  for (const evalConfig of configsToRun) {
    let result: unknown
    try {
      result = await runConfiguration(provider, evalConfig, dataset, budget, downstreamSeeds.get(evalConfig.id))
    } catch (error) {
      result = { id: evalConfig.id, model: evalConfig.model, error: error instanceof Error ? error.message : String(error) }
    }
    report.results.push(result)
    report.budgets = budget.snapshot()
    fs.writeFileSync(outputPath, `${JSON.stringify({ ...report, partial: true }, null, 2)}\n`)
    const compact = result && typeof result === "object" ? result as Record<string, unknown> : {}
    console.log(JSON.stringify({ completed: evalConfig.id, finalScore: compact.finalScore, cost: compact.cost, downstream: compact.downstream, error: compact.error }, null, 2))
  }
  report.budgets = budget.snapshot()
  fs.writeFileSync(outputPath, `${JSON.stringify({ ...report, completedAt: new Date().toISOString() }, null, 2)}\n`)
  console.log(JSON.stringify({ outputPath, budgets: budget.snapshot() }, null, 2))
}

async function runConfiguration(baseProvider: ModelProvider, evalConfig: EvalConfig, golden: GoldenDataset, ledger: BudgetLedger, downstreamSeed?: DownstreamSeed) {
  const provider = new BudgetedProvider(baseProvider, evalConfig, ledger)
  const batches = downstreamSeed ? [] : chronologicalBatches(golden.turns, roundOverride ?? evalConfig.rounds)
  let previousSummary: string | undefined = downstreamSeed?.finalSummary
  const rounds: unknown[] = [...(downstreamSeed?.rounds ?? [])]
  for (const [roundIndex, batch] of batches.entries()) {
    console.log(JSON.stringify({ config: evalConfig.id, round: roundIndex + 1, status: "starting" }))
    const headTurns: CompressorTurnInput[] = batch.map((turn) => ({
      turnNo: turn.turnNo,
      turnId: turn.turnId,
      messages: [
        { role: "user", id: `${turn.turnId}_u`, turnId: turn.turnId, content: turn.user },
        { role: "assistant", id: `${turn.turnId}_a`, turnId: turn.turnId, content: turn.assistant },
      ],
    }))
    const allowed = [
      ...batch.map((turn) => turn.turnNo),
      ...Array.from(previousSummary?.matchAll(/\bTurn (\d+):/g) ?? []).map((match) => Number(match[1])),
    ]
    const startedAt = Date.now()
    const compressed = await new CompressorAgent().run({
      provider,
      mode: "chat",
      primary: evalConfig.model,
      system: (await import("@socrates/core")).SOCRATES_COMPRESSOR_SYSTEM_PROMPT,
      userContent: buildSocratesCompressorUserContent({ ...(previousSummary ? { previousSummary } : {}), headTurns }),
      allowedTurnNumbers: [...new Set(allowed)],
    })
    previousSummary = renderChatCompactionMarkdown(compressed.output)
    rounds.push({
      round: roundIndex + 1,
      addedTurns: batch.map((turn) => turn.turnNo),
      summaryChars: previousSummary.length,
      score: scoreSummary(previousSummary, golden.checks),
      attempts: compressed.attempts,
      repairedAnchors: compressed.repairedAnchors,
      durationMs: Date.now() - startedAt,
      usage: compressed.usage,
    })
  }
  console.log(JSON.stringify({ config: evalConfig.id, status: "downstream_starting" }))
  let downstream: unknown
  try {
    downstream = await runDownstreamHarness(provider, evalConfig, previousSummary ?? "", golden)
  } catch (error) {
    downstream = { error: error instanceof Error ? error.message : String(error) }
  }
  return {
    id: evalConfig.id,
    model: evalConfig.model,
    rounds,
    finalScore: scoreSummary(previousSummary ?? "", golden.checks),
    downstream,
    cost: provider.costSnapshot(),
    finalSummary: previousSummary,
  }
}

async function runDownstreamHarness(provider: ModelProvider, evalConfig: EvalConfig, summary: string, golden: GoldenDataset) {
  const registry = new ToolRegistry([traceRetrieveTool, readTool, projectDocsTool])
  const agent = new SocratesAgent(provider, registry)
  let answer = ""
  const tools: string[] = []
  const attachmentPath = ".socrates/attachments/pasted-text-eval.txt"
  const attachmentEvidence = "ATTACHMENT-EVIDENCE-942"
  const completionMarker = `MEMORY_HARNESS_E2E_COMPLETE: ${attachmentEvidence}`
  let projectMemory = "# Project Memory\n\nThe repeated-compaction recovery check is still open."
  const originalEvidence = golden.turns.filter((turn) => turn.source === "synthetic_canary").map((turn) => `Turn ${turn.turnNo}\nUser: ${turn.user}\nAssistant: ${turn.assistant}`).join("\n\n")
  const traceOutput: TraceRetrieveMainToolOutput = {
    results: [{
      resultNumber: 1,
      content: originalEvidence,
      turnId: "canary_trace_bundle",
      conversationTitle: "Memory harness golden history",
      turnNumber: 1,
      matchedRole: "user",
      status: "complete",
      occurredAt: "2026-07-11T00:00:00.000Z",
    }],
    totalMatches: 1,
  }
  const toolExecutors = {
    trace_retrieve: async () => traceOutput,
    read: async (input: { path: string }) => ({
      path: input.path,
      kind: "file" as const,
      content: input.path === attachmentPath ? `${attachmentEvidence}: selective source read succeeded.` : "",
      truncation: { truncated: false, charLimit: 20_000, returnedLength: 56 },
    }),
    project_docs: async (input: { operation: string; area: "memory" | "notes"; text?: string; oldText?: string; newText?: string }) => {
      if (input.operation === "edit" && input.area === "memory" && (input.text !== undefined || input.newText !== undefined)) {
        const writtenText = input.text ?? input.newText ?? ""
        if (writtenText.includes(completionMarker)) {
          projectMemory = projectMemory.replace(
            "The repeated-compaction recovery check is still open.",
            "The repeated-compaction recovery check completed after exact trace and attachment verification.",
          )
        }
        if (input.newText !== undefined) {
          projectMemory = input.newText
        } else if (!projectMemory.includes(writtenText)) {
          projectMemory += `\n${writtenText}`
        }
        if (projectMemory.includes(completionMarker)) {
          projectMemory = projectMemory.replaceAll(
            "The repeated-compaction recovery check is still open.",
            "The repeated-compaction recovery check completed after exact trace and attachment verification.",
          )
        }
        return {
          operation: "edit" as const,
          area: "memory" as const,
          path: ".socrates/MEMORY.md",
          content: projectMemory,
          changed: true,
          truncation: { truncated: false, charLimit: 20_000, returnedLength: projectMemory.length },
        }
      }
      return {
        operation: input.operation === "read_section" ? "read_section" as const : "read" as const,
        area: input.area,
        path: input.area === "memory" ? ".socrates/MEMORY.md" : ".socrates/PROJECT_NOTES.md",
        content: input.area === "memory" ? projectMemory : "",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: input.area === "memory" ? projectMemory.length : 0 },
      }
    },
  } as unknown as ToolExecutors
  const runtimeConfig: RuntimeConfig = {
    providerId: evalConfig.model.providerId,
    authMode: evalConfig.model.authMode ?? "api_key",
    modelId: evalConfig.model.modelId,
    thinkingEnabled: evalConfig.model.thinkingEnabled ?? false,
    ...(evalConfig.model.thinkingEffort ? { thinkingEffort: evalConfig.model.thinkingEffort } : {}),
    approvalMode: "read_only_auto",
    sandboxMode: "read_only",
  }
  for await (const event of agent.streamTurn({
    providerId: evalConfig.model.providerId,
    modelId: evalConfig.model.modelId,
    runtimeConfig,
    systemPromptOverride: buildSocratesSystemPrompt(),
    messages: [
      { role: "developer", content: `<socrates_internal_context_compaction>\n${summary}\n</socrates_internal_context_compaction>` },
      {
        role: "user",
        content: `Continue the work. State the current hard cap and post-compaction target. You must call trace_retrieve successfully even if the summary appears sufficient. Use this valid search shape: {"operation":"search","mode":"lexical","query":"ORCHID-NEBULA-731"}. From the returned original evidence, give the exact Turn 5 user sentence beginning "Remember the exact recovery phrase"; do not substitute the later Turn 36 sentence. Read ${attachmentPath} selectively and report its exact evidence token. After verifying both sources, close the old repeated-compaction open item and append the exact durable marker "${completionMarker}" to project memory with project_docs. Do not treat superseded values as current.`,
      },
    ],
    workspacePath: os.tmpdir(),
    toolExecutors,
    requestApproval: async () => ({ decision: "rejected", reason: "Read-only evaluation" }),
    maxToolCallsPerTurn: 8,
  })) {
    if (event.type === "model.answer.delta") answer += event.text
    if (event.type === "tool.call.started") tools.push(event.toolName)
  }
  let freshAnswer = ""
  const freshTools: string[] = []
  const freshAgent = new SocratesAgent(provider, registry)
  for await (const event of freshAgent.streamTurn({
    providerId: evalConfig.model.providerId,
    modelId: evalConfig.model.modelId,
    runtimeConfig,
    systemPromptOverride: buildSocratesSystemPrompt(),
    messages: [{ role: "user", content: `This is a fresh conversation. Read project memory and report the exact ${completionMarker} marker if the previous work finished.` }],
    workspacePath: os.tmpdir(),
    toolExecutors,
    requestApproval: async () => ({ decision: "rejected", reason: "Read-only evaluation except dedicated project memory." }),
    maxToolCallsPerTurn: 4,
  })) {
    if (event.type === "model.answer.delta") freshAnswer += event.text
    if (event.type === "tool.call.started") freshTools.push(event.toolName)
  }
  return {
    answer,
    tools,
    traceRetrieveUsed: tools.includes("trace_retrieve"),
    currentCapCorrect: answer.includes("180000") || answer.includes("180,000"),
    targetCorrect: answer.includes("120000") || answer.includes("120,000"),
    exactSentenceRecovered: answer.includes("Remember the exact recovery phrase ORCHID-NEBULA-731. It must remain exact."),
    staleCapUsedAsCurrent: /(?:current|final)[^\n.]{0,50}(?:200000|200,000)/i.test(answer),
    attachmentReadUsed: tools.includes("read"),
    attachmentEvidenceRecovered: answer.includes(attachmentEvidence),
    projectMemoryUpdated: projectMemory.includes(completionMarker),
    staleProjectOpenLoopCleared: !projectMemory.includes("still open"),
    freshConversation: {
      answer: freshAnswer,
      tools: freshTools,
      projectMemoryRead: freshTools.includes("project_docs"),
      completionRecovered:
        projectMemory.includes(completionMarker) &&
        freshAnswer.includes(completionMarker) &&
        !/(?:not present|not found|does not exist|no evidence)/i.test(freshAnswer),
    },
  }
}

class BudgetedProvider implements ModelProvider {
  private inputTokens = 0
  private outputTokens = 0
  private costUsd = 0
  private calls = 0

  constructor(private readonly inner: ModelProvider, private readonly config: EvalConfig, private readonly ledger: BudgetLedger) {}

  countTokens(request: ModelRequest) { return this.inner.countTokens(request) }

  async generateStructured<TOutput>(request: StructuredModelRequest<TOutput>): Promise<StructuredModelResult<TOutput>> {
    this.reserve(request)
    if (!this.inner.generateStructured) throw new Error("Structured generation unavailable")
    const result = await this.inner.generateStructured(request)
    this.record(result.usage, request)
    return result
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.reserve(request)
    let completedUsage: ModelUsage | undefined
    for await (const event of this.inner.stream(request)) {
      if (event.type === "model.completed") completedUsage = event.usage
      yield event
    }
    this.record(completedUsage, request)
  }

  costSnapshot() { return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens, costUsd: this.costUsd } }

  private reserve(request: ModelRequest | StructuredModelRequest<unknown>) {
    const estimatedInput = estimateTextTokens(`${request.system}\n${JSON.stringify(request.messages)}`, {
      providerId: request.providerId,
      modelId: request.modelId,
    }).inputTokens
    const conservative = costFor(estimatedInput, 4_000, this.config)
    this.ledger.assertCanSpend(this.config.providerGroup, conservative, this.config.id)
  }

  private record(usage: ModelUsage | undefined, request: ModelRequest | StructuredModelRequest<unknown>) {
    const inputTokens = usage?.inputTokens ?? estimateTextTokens(`${request.system}\n${JSON.stringify(request.messages)}`).inputTokens
    const outputTokens = usage?.outputTokens ?? 0
    const cost = usage?.costUsd ?? costFor(inputTokens, outputTokens, this.config)
    this.inputTokens += inputTokens
    this.outputTokens += outputTokens
    this.costUsd += cost
    this.calls += 1
    this.ledger.record(this.config.providerGroup, cost)
  }
}

class BudgetLedger {
  private spent = { deepseek: 0, openrouter: 0, codex: 0 }
  constructor(private readonly limits: { deepseek: { start: number; cap: number }; openrouter: { start: number; cap: number } }) {}
  assertCanSpend(group: EvalConfig["providerGroup"], projected: number, configId: string) {
    if (group === "codex") return
    const limit = this.limits[group]
    if (limit.start + this.spent[group] + projected > limit.cap) {
      throw new Error(`${group} budget guard stopped ${configId}: projected total ${(limit.start + this.spent[group] + projected).toFixed(6)} exceeds ${limit.cap}.`)
    }
  }
  record(group: EvalConfig["providerGroup"], cost: number) { this.spent[group] += cost }
  snapshot() {
    return {
      deepseek: { ...this.limits.deepseek, additionalSpent: this.spent.deepseek, projectedAccountTotal: this.limits.deepseek.start + this.spent.deepseek },
      openrouter: { ...this.limits.openrouter, additionalSpent: this.spent.openrouter, projectedAccountTotal: this.limits.openrouter.start + this.spent.openrouter },
      codex: { subscription: true, callsTrackedWithoutDollarCap: true, reportedCost: this.spent.codex },
    }
  }
}

function config(id: string, providerId: ProviderId, modelId: string, thinkingEnabled: boolean, thinkingEffort: ThinkingEffort, providerGroup: EvalConfig["providerGroup"], inputRateUsdPerMillion: number, outputRateUsdPerMillion: number, rounds: number, authMode: ProviderAuthMode = "api_key"): EvalConfig {
  return { id, model: { providerId, authMode, modelId, thinkingEnabled, thinkingEffort }, providerGroup, inputRateUsdPerMillion, outputRateUsdPerMillion, rounds }
}

function costFor(inputTokens: number, outputTokens: number, config: EvalConfig): number {
  return (inputTokens * config.inputRateUsdPerMillion + outputTokens * config.outputRateUsdPerMillion) / 1_000_000
}

function chronologicalBatches<T>(items: T[], count: number): T[][] {
  return Array.from({ length: count }, (_, index) => items.slice(Math.floor(index * items.length / count), Math.floor((index + 1) * items.length / count)))
}

function scoreSummary(summary: string, checks: GoldenCheck[]) {
  const normalized = summary.toLowerCase()
  const details = checks.map((check) => {
    const required = (check.required ?? []).every((value) => normalized.includes(value.toLowerCase()))
    const concepts = (check.requiredConcepts ?? []).every((value) => normalized.includes(value.toLowerCase()))
    const forbidden = (check.forbidden ?? []).every((value) => !normalized.includes(value.toLowerCase()))
    const pass = required && concepts && forbidden
    return { id: check.id, pass }
  })
  return { passed: details.filter((item) => item.pass).length, total: details.length, details }
}

await main()
