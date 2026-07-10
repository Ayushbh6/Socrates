import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type {
  EditFilesToolInput,
  RuntimeConfig,
  SkillWriteToolInput,
  SkillWriteToolOutput,
  ThinkingEffort,
  TraceRetrieveGlobalToolInput,
} from "@socrates/contracts"
import { buildSocratesSystemPrompt, SocratesAgent, type SocratesAgentEvent, type ToolExecutors } from "@socrates/core"
import {
  DeepSeekChatProvider,
  type EmbeddingProvider,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelUsage,
  type ProviderCredentialResolver,
  type StructuredModelRequest,
  type StructuredModelResult,
} from "@socrates/providers"
import { createId, SocratesError } from "@socrates/shared"
import { openDatabase, runMigrations, type DatabaseHandle } from "../apps/server/src/db/client"
import { SocratesStore } from "../apps/server/src/services/store"
import { runSkillWriterTurn } from "../apps/server/src/services/store/skillWriterAgentRunner"
import { currentRuntimeTime } from "../apps/server/src/services/store/runtimeContext"

type Evidence = {
  sourceAnchor: string
  timestamp: string
  conversationTitle: string
  projectKey?: string
  user: string
  assistant: string
  synthetic: boolean
}
type GoldenCase = { id: string; kind: "create" | "update" | "negative" | "heldout_use"; evidence: Evidence[]; expected: Record<string, unknown> }
type GoldenDataset = { schemaVersion: 1; cases: GoldenCase[] }
type EvalConfig = { id: string; modelId: "deepseek-v4-flash" | "deepseek-v4-pro"; thinking: "off" | "high" | "max"; thinkingEnabled: boolean; thinkingEffort?: ThinkingEffort }
type ProposalRow = { id: string; status: string; rationale: string | null; patchJson: string; metadataJson: string | null }

const options = parseArgs(process.argv.slice(2))
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const datasetPath = path.resolve(repoRoot, options.dataset ?? "evals/skill-learning/private/golden-dataset.json")
const outputPath = path.resolve(repoRoot, options.output ?? `evals/skill-learning/results/run-${new Date().toISOString().replaceAll(":", "-")}.json`)
const budgetUsd = Number(options["budget-usd"] ?? "0.60")
const live = options.live === "true"
const fullOnly = options["full-only"] === "true"
const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8")) as GoldenDataset
validateDataset(dataset)

if (options["rescore-result"]) {
  rescoreSavedResult(path.resolve(repoRoot, options["rescore-result"]), dataset)
  process.exit(0)
}

const configs: EvalConfig[] = [
  config("flash-off", "deepseek-v4-flash", "off"),
  config("flash-high", "deepseek-v4-flash", "high"),
  config("flash-max", "deepseek-v4-flash", "max"),
  config("pro-off", "deepseek-v4-pro", "off"),
  config("pro-high", "deepseek-v4-pro", "high"),
  config("pro-max", "deepseek-v4-pro", "max"),
]

if (!live) {
  console.log(JSON.stringify({ live: false, datasetPath, budgetUsd, configs: configs.map(({ id, modelId, thinking }) => ({ id, modelId, thinking })) }, null, 2))
  process.exit(0)
}

process.env.NODE_ENV = "test"
let ledger: CostLedger

const main = async (): Promise<void> => {
  if (options["seed-check"] === "true") {
    const unavailableProvider: ModelProvider = {
      countTokens: async (request) => ({ providerId: request.providerId, modelId: request.modelId, inputTokens: 0, baseTokens: 0, method: "heuristic", safetyMarginPercent: 0 }),
      async *stream() { throw new Error("Seed check must not call a model provider.") },
    }
    const sandbox = createSandbox("maturation-seed-check", unavailableProvider, { getApiKey: () => undefined })
    try {
      seedMaturationStartingState(sandbox, "phased-collaboration")
      const journalCount = (sandbox.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM memory_agent_journal").get() as { count: number }).count
      const proposalCount = (sandbox.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM memory_agent_actions WHERE target_kind = 'skill_request'").get() as { count: number }).count
      const writerCount = (sandbox.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM skill_writer_jobs WHERE status = 'completed'").get() as { count: number }).count
      const skillExists = fs.existsSync(path.join(sandbox.socratesHome, "skills", "phased-collaboration", "SKILL.md"))
      if (!skillExists || journalCount !== 1 || proposalCount !== 1 || writerCount !== 1) throw new Error("Maturation seed state failed deterministic validation.")
      console.log(JSON.stringify({ seedCheck: "passed", skillExists, journalCount, proposalCount, writerCount }, null, 2))
      return
    } finally {
      await sandbox.close()
    }
  }
  const apiKey = readDeepSeekKey()
  const credentials: ProviderCredentialResolver = { getApiKey: (providerId) => providerId === "deepseek" ? apiKey : undefined }
  ledger = new CostLedger(budgetUsd)
  const provider = new BudgetedProvider(new DeepSeekChatProvider(credentials), ledger)
  if (options["maturation-only"] === "true") {
    const requestedPair = options.pair?.split("+") ?? ["pro-high", "flash-off"]
    const memoryConfig = configs.find((item) => item.id === requestedPair[0])
    const writerConfig = configs.find((item) => item.id === requestedPair[1])
    if (!memoryConfig || !writerConfig) throw new Error(`Unknown maturation pair: ${requestedPair.join("+")}`)
    ledger.phase = `maturation:${memoryConfig.id}+${writerConfig.id}`
    const maturationRun = await runMaturationSubset(memoryConfig, writerConfig, dataset, provider, credentials)
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: "maturation-only",
      parameters: {
        providerId: "deepseek",
        apiBase: "https://api.deepseek.com",
        pair: { memory: memoryConfig, writer: writerConfig },
        budgetUsd,
        isolated: true,
        seededFromPreviouslyProvenStage: "skill-v1-created-and-heldout-v1-reached",
      },
      maturationRun,
      cost: ledger.summary(),
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify({ outputPath, maturationRun, cost: report.cost }, null, 2))
    return
  }
  const memoryScreens: Array<Awaited<ReturnType<typeof screenMemoryConfig>>> = []
  if (!fullOnly) {
    for (const candidate of configs) {
      ledger.phase = `screen:memory:${candidate.id}`
      memoryScreens.push(await screenMemoryConfig(candidate, dataset, provider, credentials))
      checkpoint({ stage: "memory-screen", config: candidate.id, costUsd: ledger.totalCostUsd })
    }
  }

  const writerScreens: Array<Awaited<ReturnType<typeof screenWriterConfig>>> = []
  if (!fullOnly) {
    for (const candidate of configs) {
      ledger.phase = `screen:writer:${candidate.id}`
      writerScreens.push(await screenWriterConfig(candidate, dataset, provider, credentials))
      checkpoint({ stage: "writer-screen", config: candidate.id, costUsd: ledger.totalCostUsd })
    }
  }

  const rankedMemory = [...memoryScreens].sort(rankResult)
  const rankedWriter = [...writerScreens].sort(rankResult)
  const requestedPair = options.pair?.split("+")
  const pairCandidates = fullOnly
    ? requestedPair?.length === 2
      ? [{ memory: configs.find((item) => item.id === requestedPair[0]), writer: configs.find((item) => item.id === requestedPair[1]) }]
      : [
        { memory: configs.find((item) => item.id === "pro-high"), writer: configs.find((item) => item.id === "flash-off") },
        { memory: configs.find((item) => item.id === "flash-max"), writer: configs.find((item) => item.id === "flash-off") },
      ]
    : uniquePairs([
        { memory: rankedMemory[0]?.config, writer: rankedWriter[0]?.config },
        { memory: bestValue(rankedMemory)?.config, writer: bestValue(rankedWriter)?.config },
      ])
  const fullRuns = []
  for (const pair of pairCandidates) {
    if (!pair.memory || !pair.writer) continue
    ledger.phase = `full:${pair.memory.id}+${pair.writer.id}`
    try {
      fullRuns.push(await runFullLoop(pair.memory, pair.writer, dataset, provider, credentials))
    } catch (error) {
      fullRuns.push({
        pair: { memory: pair.memory.id, writer: pair.writer.id },
        passed: false,
        score: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    checkpoint({ stage: "full-loop", pair: `${pair.memory.id}+${pair.writer.id}`, costUsd: ledger.totalCostUsd })
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dataset: {
      path: "evals/skill-learning/private/golden-dataset.json",
      naturalEvidence: dataset.cases.flatMap((item) => item.evidence).filter((item) => !item.synthetic).length,
      syntheticEvidence: dataset.cases.flatMap((item) => item.evidence).filter((item) => item.synthetic).length,
    },
    parameters: {
      providerId: "deepseek",
      apiBase: "https://api.deepseek.com",
      configurations: configs.map(({ id, modelId, thinking, thinkingEnabled, thinkingEffort }) => ({ id, modelId, thinking, thinkingEnabled, thinkingEffort })),
      budgetUsd,
      isolated: true,
      memoryMaxToolCalls: 60,
      writerMaxToolCalls: 20,
      mainUseMaxToolCalls: 12,
    },
    memoryScreens,
    writerScreens,
    fullRuns,
    recommendation: {
      memory: rankedMemory[0]?.config.id,
      writer: rankedWriter[0]?.config.id,
      valueMemory: bestValue(rankedMemory)?.config.id,
      valueWriter: bestValue(rankedWriter)?.config.id,
      bestFullPair: [...fullRuns].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.pair,
    },
    cost: ledger.summary(),
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ outputPath, recommendation: report.recommendation, cost: report.cost, fullRuns: report.fullRuns.map((run) => ({ pair: run.pair, passed: run.passed, score: run.score })) }, null, 2))
}

const runMaturationSubset = async (
  memoryConfig: EvalConfig,
  writerConfig: EvalConfig,
  source: GoldenDataset,
  modelProvider: ModelProvider,
  resolver: ProviderCredentialResolver,
) => {
  const sandbox = createSandbox(`maturation-${memoryConfig.id}-${writerConfig.id}`, modelProvider, resolver)
  const startedCost = ledger.totalCostUsd
  const skillName = "phased-collaboration"
  let stage = "seed-v1"
  try {
    setMemoryConfig(sandbox.store, memoryConfig)
    setWriterConfig(sandbox.store, writerConfig)
    seedMaturationStartingState(sandbox, skillName)
    const skillPath = path.join(sandbox.socratesHome, "skills", skillName, "SKILL.md")
    const skillV1 = fs.readFileSync(skillPath, "utf8")
    seedEvidence(sandbox, caseFor(source, "behavioral-workflow-update").evidence, { memoryNotes: true })

    stage = "maturation-pattern-discovery"
    await sandbox.store.runGlobalMemoryAgent("manual")
    const updateProposal = selectProposal(sandbox.handle, "update", skillName)
    if (!updateProposal) throw new Error(`Memory Agent did not propose an update to ${skillName}.`)

    stage = "skill-v2-write"
    await sandbox.store.approveMemorySkillProposal(updateProposal.id)
    const skillV2 = fs.readFileSync(skillPath, "utf8")
    if (skillV1 === skillV2) throw new Error("Approved maturation produced no meaningful file change.")

    stage = "heldout-use-v2"
    const heldoutV2 = caseFor(source, "heldout-use-v2")
    const heldoutUse = await runHeldoutUse(sandbox, writerConfig, heldoutV2.evidence[0]?.user ?? "", modelProvider, expectedResponseSignals(heldoutV2))
    const passed = heldoutUse.listed && heldoutUse.described && heldoutUse.signalScore >= 5
    return {
      passed,
      stage: passed ? "complete" : stage,
      skill: { name: skillName, v1Chars: skillV1.length, v2Chars: skillV2.length, changed: true },
      proposal: summarizeProposal(updateProposal),
      heldoutUse,
      journal: evaluationJournalSnapshots(sandbox.handle),
      costUsd: ledger.totalCostUsd - startedCost,
    }
  } catch (error) {
    return {
      passed: false,
      stage,
      error: error instanceof Error ? error.message : String(error),
      proposals: skillProposals(sandbox.handle).map(summarizeProposal),
      journal: evaluationJournalSnapshots(sandbox.handle),
      costUsd: ledger.totalCostUsd - startedCost,
    }
  } finally {
    await sandbox.close()
  }
}

const seedMaturationStartingState = (sandbox: Sandbox, skillName: string): void => {
  const memory = (sandbox.store as unknown as { memory: { runSkillWriteTool: (input: SkillWriteToolInput, constraints: unknown) => SkillWriteToolOutput } }).memory
  memory.runSkillWriteTool({
    scope: "global",
    operation: "create",
    name: skillName,
    content: [
      "---",
      `name: ${skillName}`,
      "description: Use when serious project work needs explicit discussion, planning, authorization, implementation, and verification gates.",
      "---",
      "",
      "# Phased collaboration",
      "",
      "## Trigger",
      "",
      "Use this workflow when the user asks for careful project work and distinguishes discussion from implementation.",
      "",
      "## Workflow",
      "",
      "1. Inspect the relevant context and current state before suggesting changes.",
      "2. Discuss edge cases and ask questions that remove material assumptions.",
      "3. Present an explicit plan and wait for the user's implementation authorization.",
      "4. Implement only the agreed scope.",
      "5. Verify the observable result and review it with the user.",
      "",
      "## Boundaries",
      "",
      "Do not edit during discussion or planning unless the user explicitly authorizes implementation.",
      "",
    ].join("\n"),
    changeSummary: "Seed the previously proven v1 phased collaboration workflow for a targeted maturation continuation.",
    evidenceTurnIds: [],
  }, { expectedScope: "global", expectedOperation: "create", expectedName: skillName })

  const createdAt = new Date(Date.now() - 60_000).toISOString()
  const jobId = "memjob_eval_prior_create"
  sandbox.handle.sqlite.prepare(
    "INSERT INTO memory_agent_jobs (id, project_id, status, trigger, provider_id, model_id, fallback_model_ids_json, evidence_turn_ids_json, evidence_tokens_estimate, started_at, completed_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(jobId, "global-memory-agent", "completed", "evaluation_seed", "deepseek", "deepseek-v4-pro", "[]", "[]", 0, createdAt, createdAt, "{}")
  sandbox.handle.sqlite.prepare(
    "INSERT INTO memory_agent_journal (id, job_id, summary, patterns_observed_json, skills_affected_json, decisions_json, open_investigations_json, next_run_focus_json, provider_id, model_id, thinking_enabled, thinking_effort, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "memjournal_eval_prior_create",
    jobId,
    "Created the phased-collaboration skill from repeated cross-project evidence; watch future work for meaningful new gates.",
    JSON.stringify([{ name: "Phased collaboration", finding: "The user separates context gathering, discussion, planning, authorization, implementation, and verification.", evidenceTurnIds: [] }]),
    JSON.stringify([{ skillId: `global:${skillName}`, action: "proposed_create", note: "The approved proposal was written by Skill Writer." }]),
    JSON.stringify(["Future operational gates should mature the existing skill instead of creating a duplicate."]),
    "[]",
    JSON.stringify(["Watch for a repeated closure and clean-handoff gate that the current skill does not yet contain."]),
    "deepseek",
    "deepseek-v4-pro",
    1,
    "high",
    "completed",
    createdAt,
    "{}",
  )
  sandbox.handle.sqlite.prepare(
    "INSERT INTO memory_agent_actions (id, job_id, project_id, target_kind, target_path, status, requires_confirmation, patch_json, rationale, created_at, applied_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("memact_eval_prior_create", jobId, "global-memory-agent", "skill_request", path.join(sandbox.socratesHome, "skills", skillName, "SKILL.md"), "applied", 1, "{}", "Previously proven create proposal.", createdAt, createdAt, JSON.stringify({ operation: "create", scope: "global", skillName }))
  sandbox.handle.sqlite.prepare(
    "INSERT INTO skill_writer_jobs (id, scope, operation, skill_name, source_kind, source_id, status, provider_id, model_id, started_at, completed_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("skjob_eval_prior_create", "global", "create", skillName, "memory_agent", "memact_eval_prior_create", "completed", "deepseek", "deepseek-v4-flash", createdAt, createdAt, "{}")
}

const screenMemoryConfig = async (candidate: EvalConfig, source: GoldenDataset, modelProvider: ModelProvider, resolver: ProviderCredentialResolver) => {
  const sandbox = createSandbox(`memory-${candidate.id}`, modelProvider, resolver)
  const startedCost = ledger.totalCostUsd
  try {
    seedEvidence(sandbox, caseFor(source, "behavioral-workflow-create").evidence, { memoryNotes: true })
    seedEvidence(sandbox, caseFor(source, "repeated-topic-negative-control").evidence, { memoryNotes: false })
    setMemoryConfig(sandbox.store, candidate)
    const result = await sandbox.store.runGlobalMemoryAgent("manual")
    const proposals = skillProposals(sandbox.handle)
    const scored = scoreMemoryProposals(proposals)
    return {
      config: candidate,
      score: scored.score,
      passed: scored.score >= 7,
      proposalCount: proposals.length,
      proposal: scored.proposal,
      runId: result.item?.itemType === "run" ? result.item.runId : undefined,
      costUsd: ledger.totalCostUsd - startedCost,
    }
  } catch (error) {
    return { config: candidate, score: 0, passed: false, error: error instanceof Error ? error.message : String(error), costUsd: ledger.totalCostUsd - startedCost }
  } finally {
    await sandbox.close()
  }
}

const screenWriterConfig = async (candidate: EvalConfig, source: GoldenDataset, modelProvider: ModelProvider, resolver: ProviderCredentialResolver) => {
  const sandbox = createSandbox(`writer-${candidate.id}`, modelProvider, resolver)
  const startedCost = ledger.totalCostUsd
  let written: SkillWriteToolOutput | undefined
  let writtenInput: SkillWriteToolInput | undefined
  const inspected = new Set<string>()
  try {
    const seeded = seedEvidence(sandbox, caseFor(source, "behavioral-workflow-create").evidence.slice(0, 3), { memoryNotes: false })
    const evidenceTurnIds = [...seeded.values()]
    const memory = (sandbox.store as unknown as { memory: { runSkillWriteTool: (input: SkillWriteToolInput, constraints: unknown) => SkillWriteToolOutput } }).memory
    await runSkillWriterTurn({
      provider: modelProvider,
      modelSettings: modelSettings(candidate),
      scope: "global",
      operation: "create",
      name: "context-first-delivery",
      request: "Create a global behavioral workflow skill. Trigger when a user wants serious project work: inspect context first, discuss edges and ask questions, form a plan, wait for explicit implementation authorization, implement narrowly, verify the result, and review it. Preserve the distinction between discussion, planning, and implementation.",
      projectId: sandbox.projectId,
      conversationId: sandbox.conversationId,
      sessionId: "eval-writer-session",
      turnId: evidenceTurnIds[0] ?? "eval-writer-turn",
      sourceTurnIds: evidenceTurnIds,
      socratesHome: sandbox.socratesHome,
      tools: {
        traceRetrieve: async (input) => {
          const output = await sandbox.store.retrieveGlobalToolTraces(input)
          if (input.operation === "inspect" && input.turnId) inspected.add(input.turnId)
          return output
        },
        skills: async (input) => sandbox.store.runSkillsTool(sandbox.projectId, input),
        soul: async (input) => sandbox.store.runSoulTool(sandbox.projectId, input),
        userProfile: async (input) => sandbox.store.runUserProfileTool(sandbox.projectId, input),
        projectDocs: async (input) => sandbox.store.runProjectDocsTool(sandbox.projectId, sandbox.workspacePath, input),
        repoDocs: async (input) => sandbox.store.runRepoDocsTool(sandbox.projectId, sandbox.workspacePath, input),
        skillWrite: async (input) => {
          if (evidenceTurnIds.some((turnId) => !inspected.has(turnId))) throw new Error("Writer did not inspect every approved source turn.")
          writtenInput = input
          written = memory.runSkillWriteTool(input, { expectedScope: "global", expectedOperation: "create", expectedName: "context-first-delivery" })
          return written
        },
      },
    })
    const content = fs.readFileSync(path.join(sandbox.socratesHome, "skills", "context-first-delivery", "SKILL.md"), "utf8")
    const score = scoreWriter(content, writtenInput, evidenceTurnIds)
    return { config: candidate, score, passed: score >= 7, changedFiles: written?.changedFiles, contentPreview: content.slice(0, 1_500), costUsd: ledger.totalCostUsd - startedCost }
  } catch (error) {
    return { config: candidate, score: 0, passed: false, error: error instanceof Error ? error.message : String(error), costUsd: ledger.totalCostUsd - startedCost }
  } finally {
    await sandbox.close()
  }
}

const runFullLoop = async (memoryConfig: EvalConfig, writerConfig: EvalConfig, source: GoldenDataset, modelProvider: ModelProvider, resolver: ProviderCredentialResolver) => {
  const sandbox = createSandbox(`full-${memoryConfig.id}-${writerConfig.id}`, modelProvider, resolver)
  const startedCost = ledger.totalCostUsd
  let stage = "setup"
  const progress: Record<string, unknown> = {}
  try {
    setMemoryConfig(sandbox.store, memoryConfig)
    setWriterConfig(sandbox.store, writerConfig)
    seedEvidence(sandbox, caseFor(source, "behavioral-workflow-create").evidence, { memoryNotes: true })
    seedEvidence(sandbox, caseFor(source, "repeated-topic-negative-control").evidence, { memoryNotes: false })
    stage = "create-pattern-discovery"
    await sandbox.store.runGlobalMemoryAgent("manual")
    let createProposal = selectProposal(sandbox.handle, "create")
    let createMemoryRuns = 1
    if (!createProposal) {
      const retryEvidence = caseFor(source, "behavioral-workflow-create").evidence.slice(0, 2)
      const retryTurns = seedEvidence(sandbox, retryEvidence, { memoryNotes: false })
      const retryTurnId = [...retryTurns.values()][0]
      if (retryTurnId) {
        const turn = sandbox.handle.sqlite.prepare("SELECT conversation_id AS conversationId, session_id AS sessionId FROM turns WHERE id = ?").get(retryTurnId) as { conversationId: string; sessionId: string }
        sandbox.store.createMemoryNote(sandbox.projectId, {
          note: "A new completed work cycle repeated the same durable collaboration procedure: inspect context, clarify assumptions, wait for explicit implementation authorization, then verify. Classify this new evidence together with the earlier cycles.",
          importance: "high",
        }, { conversationId: turn.conversationId, sessionId: turn.sessionId, turnId: retryTurnId })
      }
      await sandbox.store.runGlobalMemoryAgent("manual")
      createMemoryRuns += 1
      createProposal = selectProposal(sandbox.handle, "create")
    }
    if (!createProposal) throw new Error("Memory Agent did not create a behavioral skill proposal.")
    progress.createProposal = summarizeProposal(createProposal)
    progress.createMemoryRuns = createMemoryRuns
    stage = "skill-v1-write"
    const approvedCreate = await sandbox.store.approveMemorySkillProposal(createProposal.id)
    const skillName = approvedCreate.skill.name
    const skillPath = approvedCreate.skill.scope === "global"
      ? path.join(sandbox.socratesHome, "skills", skillName, "SKILL.md")
      : path.join(sandbox.workspacePath, ".socrates", "skills", skillName, "SKILL.md")
    const skillV1 = fs.readFileSync(skillPath, "utf8")
    progress.skillV1 = { name: skillName, id: approvedCreate.skill.id, chars: skillV1.length }
    stage = "heldout-use-v1"
    const heldoutV1 = caseFor(source, "heldout-use-v1")
    const useV1 = await runHeldoutUse(sandbox, memoryConfig, heldoutV1.evidence[0]?.user ?? "", modelProvider, expectedResponseSignals(heldoutV1))
    progress.heldoutUseV1 = useV1

    seedEvidence(sandbox, caseFor(source, "heldout-use-v1").evidence, { memoryNotes: false })
    seedEvidence(sandbox, caseFor(source, "behavioral-workflow-update").evidence, { memoryNotes: true })
    stage = "maturation-pattern-discovery"
    await sandbox.store.runGlobalMemoryAgent("manual")
    let updateProposal = selectProposal(sandbox.handle, "update", skillName)
    let updateMemoryRuns = 1
    if (!updateProposal) {
      const retryEvidence = caseFor(source, "behavioral-workflow-update").evidence.slice(-2)
      const retryTurns = seedEvidence(sandbox, retryEvidence, { memoryNotes: false })
      const retryTurnId = [...retryTurns.values()][0]
      if (retryTurnId) {
        const turn = sandbox.handle.sqlite.prepare("SELECT conversation_id AS conversationId, session_id AS sessionId FROM turns WHERE id = ?").get(retryTurnId) as { conversationId: string; sessionId: string }
        sandbox.store.createMemoryNote(sandbox.projectId, {
          note: "New cross-project evidence materially refines the existing phased workflow: after verification, audit durable docs and memory for stale state, leave a clean handoff before a new chat or phase, and begin the next chat with discussion rather than edits. Evaluate these missing closure gates against the existing skill.",
          importance: "high",
        }, { conversationId: turn.conversationId, sessionId: turn.sessionId, turnId: retryTurnId })
      }
      await sandbox.store.runGlobalMemoryAgent("manual")
      updateMemoryRuns += 1
      updateProposal = selectProposal(sandbox.handle, "update", skillName)
    }
    if (!updateProposal) throw new Error(`Memory Agent did not propose an update to ${skillName}.`)
    progress.updateProposal = summarizeProposal(updateProposal)
    progress.updateMemoryRuns = updateMemoryRuns
    stage = "skill-v2-write"
    await sandbox.store.approveMemorySkillProposal(updateProposal.id)
    const skillV2 = fs.readFileSync(skillPath, "utf8")
    if (skillV1 === skillV2) throw new Error("Approved skill maturation produced no meaningful change.")
    stage = "heldout-use-v2"
    const heldoutV2 = caseFor(source, "heldout-use-v2")
    const useV2 = await runHeldoutUse(sandbox, memoryConfig, heldoutV2.evidence[0]?.user ?? "", modelProvider, expectedResponseSignals(heldoutV2))
    const score = [useV1.listed, useV1.described, useV1.signalScore >= 3, skillV1 !== skillV2, useV2.listed, useV2.described, useV2.signalScore >= 5].filter(Boolean).length
    return {
      pair: { memory: memoryConfig.id, writer: writerConfig.id },
      passed: score >= 6,
      score,
      skill: { name: skillName, id: approvedCreate.skill.id, v1Chars: skillV1.length, v2Chars: skillV2.length, changed: skillV1 !== skillV2 },
      proposals: { create: summarizeProposal(createProposal), update: summarizeProposal(updateProposal) },
      memoryRuns: { create: createMemoryRuns, update: updateMemoryRuns },
      heldoutUse: { v1: useV1, v2: useV2 },
      costUsd: ledger.totalCostUsd - startedCost,
    }
  } catch (error) {
    return {
      pair: { memory: memoryConfig.id, writer: writerConfig.id },
      passed: false,
      score: 0,
      failureStage: stage,
      error: error instanceof Error ? error.message : String(error),
      progress,
      journal: evaluationJournalSnapshots(sandbox.handle),
      costUsd: ledger.totalCostUsd - startedCost,
    }
  } finally {
    await sandbox.close()
  }
}

const evaluationJournalSnapshots = (handle: DatabaseHandle): Array<Record<string, unknown>> =>
  (handle.sqlite.prepare(
    "SELECT job_id AS jobId, summary, patterns_observed_json AS patternsObservedJson, skills_affected_json AS skillsAffectedJson, decisions_json AS decisionsJson, open_investigations_json AS openInvestigationsJson, next_run_focus_json AS nextRunFocusJson, created_at AS createdAt FROM memory_agent_journal ORDER BY created_at",
  ).all() as Array<Record<string, string>>).map((row) => ({
    jobId: row.jobId,
    createdAt: row.createdAt,
    summary: row.summary,
    patternsObserved: JSON.parse(row.patternsObservedJson ?? "[]"),
    skillsAffected: JSON.parse(row.skillsAffectedJson ?? "[]"),
    decisions: JSON.parse(row.decisionsJson ?? "[]"),
    openInvestigations: JSON.parse(row.openInvestigationsJson ?? "[]"),
    nextRunFocus: JSON.parse(row.nextRunFocusJson ?? "[]"),
  }))

const runHeldoutUse = async (sandbox: Sandbox, candidate: EvalConfig, prompt: string, modelProvider: ModelProvider, signalWords?: string[]) => {
  const agent = new SocratesAgent(modelProvider)
  const operations: string[] = []
  let answer = ""
  const unavailable = async (): Promise<never> => { throw new SocratesError("eval_tool_unavailable", "This tool is intentionally unavailable in the held-out read-only evaluation.", { recoverable: true }) }
  const executors: ToolExecutors = {
    read: unavailable,
    search: unavailable,
    url_fetch: unavailable,
    edit: unavailable,
    apply_patch: unavailable,
    bash: unavailable,
    current_time: async () => currentRuntimeTime(),
    trace_retrieve: async (input) => sandbox.store.retrieveMainToolTraces(sandbox.projectId, sandbox.conversationId, input as never),
    tool_docs: async (input) => sandbox.store.runToolDocsTool(sandbox.projectId, input),
    skills: async (input) => {
      operations.push(input.operation)
      return sandbox.store.runSkillsTool(sandbox.projectId, input)
    },
    project_docs: async (input) => sandbox.store.runProjectDocsTool(sandbox.projectId, sandbox.workspacePath, input),
    repo_docs: async (input) => sandbox.store.runRepoDocsTool(sandbox.projectId, sandbox.workspacePath, input),
    soul: async (input) => sandbox.store.runSoulTool(sandbox.projectId, input),
    user_profile: async (input) => sandbox.store.runUserProfileTool(sandbox.projectId, input),
    list_project_resources: unavailable,
    memory_note: unavailable,
    mcp_registry: unavailable,
  }
  for await (const event of agent.streamTurn({
    projectId: sandbox.projectId,
    conversationId: sandbox.conversationId,
    sessionId: createId("sess"),
    turnId: createId("turn"),
    providerId: "deepseek",
    modelId: candidate.modelId,
    runtimeConfig: runtimeConfig(candidate),
    messages: [{ role: "user", content: prompt }],
    systemPromptOverride: buildSocratesSystemPrompt({ userDisplayName: "Evaluation User", projectName: "Skill Learning Evaluation", projectDescription: "Isolated behavioral-learning validation." }),
    workspacePath: sandbox.workspacePath,
    toolExecutors: executors,
    requestApproval: async () => ({ decision: "rejected", reason: "Held-out evaluation is read-only." }),
    maxToolCallsPerTurn: 12,
    maxParallelToolCalls: 2,
    maxConfirmedToolErrorsPerTurn: 3,
    contextCompression: { enabled: false },
  })) {
    if (event.type === "model.answer.delta") answer += event.text
    if (event.type === "model.failed") throw event.error
  }
  const words = signalWords ?? ["context", "question", "plan", "edit", "baseline", "parameter", "isolat", "cost", "update", "verif"]
  const matchedSignals = words.filter((signal) => matchesResponseSignal(answer, signal))
  return {
    listed: operations.includes("list"),
    described: operations.includes("describe") || operations.includes("read"),
    operations,
    signalScore: matchedSignals.length,
    matchedSignals,
    answer: answer.trim().slice(0, 4_000),
  }
}

function matchesResponseSignal(answer: string, signal: string): boolean {
  if (signal === "new chat") return /\b(?:new|next|fresh)\s+(?:chat|conversation|session)\b/i.test(answer)
  if (signal === "no edits") return /\b(?:no|without)\s+(?:immediate\s+)?edits?\b|\bnot\s+(?:start\s+with\s+|blind\s+)?edits?\b/i.test(answer)
  return answer.toLowerCase().includes(signal.toLowerCase())
}

function rescoreSavedResult(resultPath: string, source: GoldenDataset): void {
  const report = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
    maturationRun?: {
      passed?: boolean
      stage?: string
      heldoutUse?: { answer?: string; listed?: boolean; described?: boolean; signalScore?: number; matchedSignals?: string[]; literalSignalScore?: number }
    }
    semanticRescore?: Record<string, unknown>
  }
  const heldoutUse = report.maturationRun?.heldoutUse
  if (!heldoutUse?.answer) throw new Error("Saved result has no maturation held-out answer to rescore.")
  const signals = expectedResponseSignals(caseFor(source, "heldout-use-v2")) ?? []
  const literalSignalScore = signals.filter((signal) => heldoutUse.answer!.toLowerCase().includes(signal.toLowerCase())).length
  const matchedSignals = signals.filter((signal) => matchesResponseSignal(heldoutUse.answer!, signal))
  heldoutUse.literalSignalScore = literalSignalScore
  heldoutUse.signalScore = matchedSignals.length
  heldoutUse.matchedSignals = matchedSignals
  const passed = heldoutUse.listed === true && heldoutUse.described === true && matchedSignals.length >= 5
  if (report.maturationRun) {
    report.maturationRun.passed = passed
    report.maturationRun.stage = passed ? "complete" : "heldout-use-v2"
  }
  report.semanticRescore = {
    rescoredAt: new Date().toISOString(),
    method: "deterministic concept aliases; no provider call",
    expectedSignals: signals,
    matchedSignals,
    literalSignalScore,
    semanticSignalScore: matchedSignals.length,
    passed,
  }
  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ resultPath, ...report.semanticRescore }, null, 2))
}

type Sandbox = ReturnType<typeof createSandbox>
const createSandbox = (label: string, modelProvider: ModelProvider, resolver: ProviderCredentialResolver) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `socrates-skill-eval-${label}-`))
  const socratesHome = path.join(root, "home")
  const workspacePath = path.join(root, "workspace")
  fs.mkdirSync(workspacePath, { recursive: true })
  const handle = openDatabase(path.join(root, "eval.sqlite"))
  runMigrations(handle)
  const store = new SocratesStore(handle, fakeEmbeddingProvider, resolver, { socratesHome, memoryProvider: modelProvider })
  store.completeOnboarding({ displayName: "Evaluation User" })
  const { project } = store.createProject({ name: "Skill Learning Evaluation", description: "Isolated golden-dataset run", creationMode: "existing_folder", workspacePath })
  const conversation = store.createConversation(project.id, { title: "Golden learning timeline" })
  const projects = new Map([["Socrates", { projectId: project.id, conversationId: conversation.id, workspacePath }]])
  return {
    root,
    socratesHome,
    workspacePath,
    handle,
    store,
    projectId: project.id,
    conversationId: conversation.id,
    projects,
    close: async () => {
      await store.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

const seedEvidence = (sandbox: Sandbox, evidence: Evidence[], options: { memoryNotes: boolean }): Map<string, string> => {
  const mapped = new Map<string, string>()
  for (const [index, item] of evidence.entries()) {
    const target = ensureEvidenceProject(sandbox, item.projectKey ?? "Socrates")
    const created = sandbox.store.createTurnFromUserMessage(target.projectId, target.conversationId, {
      clientMessageId: createId("msg"),
      content: item.user,
      runtimeConfig: runtimeConfig(config("seed", "deepseek-v4-flash", "off")),
    })
    const assistant = sandbox.store.completeAgentTurn({
      conversationId: target.conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      content: item.assistant || "Understood. I will preserve the requested workflow boundary and verification standard.",
    })
    sandbox.store.appendEvent({
      projectId: target.projectId,
      conversationId: target.conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      type: "turn.completed",
      source: "server",
      payload: { turnId: created.turnId, assistantMessageId: assistant.id, summary: "Golden evidence turn completed." },
    })
    sandbox.store.indexTurnTraceDocuments(target.projectId, target.conversationId, created.turnId)
    mapped.set(item.sourceAnchor, created.turnId)
    if (options.memoryNotes && index % 3 === 0) {
      sandbox.store.createMemoryNote(target.projectId, {
        note: `The user emphasized a potentially durable collaboration procedure: gather context, clarify edges, separate planning from implementation authorization, and verify the result. Evidence lead ${item.sourceAnchor} should be classified with similar turns from other projects.`,
        importance: "high",
      }, { conversationId: target.conversationId, sessionId: created.sessionId, turnId: created.turnId })
    }
  }
  return mapped
}

const ensureEvidenceProject = (sandbox: Sandbox, projectKey: string): { projectId: string; conversationId: string; workspacePath: string } => {
  const existing = sandbox.projects.get(projectKey)
  if (existing) return existing
  const workspacePath = path.join(sandbox.root, "workspaces", projectKey.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
  fs.mkdirSync(workspacePath, { recursive: true })
  const { project } = sandbox.store.createProject({ name: `Golden ${projectKey}`, description: `Natural evidence replay for ${projectKey}`, creationMode: "existing_folder", workspacePath })
  const conversation = sandbox.store.createConversation(project.id, { title: `${projectKey} natural evidence` })
  const created = { projectId: project.id, conversationId: conversation.id, workspacePath }
  sandbox.projects.set(projectKey, created)
  return created
}

const setMemoryConfig = (store: SocratesStore, candidate: EvalConfig): void => {
  store.updateMemoryAgentSettings({ providerId: "deepseek", authMode: "api_key", modelId: candidate.modelId, thinkingEnabled: candidate.thinkingEnabled, ...(candidate.thinkingEffort ? { thinkingEffort: candidate.thinkingEffort } : {}), enabled: true, cadenceMinutes: 10 })
}
const setWriterConfig = (store: SocratesStore, candidate: EvalConfig): void => {
  store.updateWorkerModelSettings("skill_writer", { providerId: "deepseek", authMode: "api_key", modelId: candidate.modelId, thinkingEnabled: candidate.thinkingEnabled, ...(candidate.thinkingEffort ? { thinkingEffort: candidate.thinkingEffort } : {}) })
}

const skillProposals = (handle: DatabaseHandle): ProposalRow[] => handle.sqlite.prepare("SELECT id,status,rationale,patch_json AS patchJson,metadata_json AS metadataJson FROM memory_agent_actions WHERE target_kind = 'skill_request' ORDER BY created_at").all() as ProposalRow[]
const selectProposal = (handle: DatabaseHandle, operation: "create" | "update", name?: string): ProposalRow | undefined => skillProposals(handle).find((row) => {
  const metadata = parseRecord(row.metadataJson)
  return row.status === "proposed" && metadata.operation === operation && (!name || metadata.skillName === name)
})
const scoreMemoryProposals = (proposals: ProposalRow[]) => {
  let best: { score: number; proposal?: ReturnType<typeof summarizeProposal> } = { score: 0 }
  for (const row of proposals) {
    const summary = summarizeProposal(row)
    const text = `${summary.name} ${summary.request} ${summary.rationale}`.toLowerCase()
    const sourceTurnIds = summary.sourceTurnIds
    const score = 2 + (summary.scope === "global" ? 1 : 0) + (sourceTurnIds.length >= 2 ? 2 : 0) + ((summary.rationale?.length ?? 0) >= 30 ? 1 : 0)
      + (/context|clarif|question/.test(text) && /plan/.test(text) ? 2 : 0)
      + (/authoriz|approval|explicit|wait/.test(text) && /verif|review|test/.test(text) ? 1 : 0)
      + (!/\b(?:deepseek|typescript|pdf|memory-agent)\b/.test(summary.name) ? 1 : 0)
    if (score > best.score) best = { score, proposal: summary }
  }
  return best
}
const summarizeProposal = (row: ProposalRow) => {
  const patch = parseRecord(row.patchJson)
  const metadata = parseRecord(row.metadataJson)
  return {
    actionId: row.id,
    status: row.status,
    name: String(metadata.skillName ?? ""),
    scope: String(metadata.scope ?? ""),
    operation: String(metadata.operation ?? ""),
    rationale: row.rationale ?? "",
    request: String(patch.newText ?? ""),
    sourceTurnIds: Array.isArray(patch.sourceTurnIds) ? patch.sourceTurnIds.filter((item): item is string => typeof item === "string") : [],
  }
}
const scoreWriter = (content: string, input: SkillWriteToolInput | undefined, expectedEvidence: string[]): number => {
  const lower = content.toLowerCase()
  return (content.length >= 500 ? 2 : 0)
    + (/when to use|trigger/.test(lower) ? 1 : 0)
    + (/workflow|procedure/.test(lower) ? 1 : 0)
    + (/verify|evidence|review/.test(lower) ? 1 : 0)
    + (/context/.test(lower) && /clarif|question/.test(lower) ? 1 : 0)
    + (/plan/.test(lower) && /authoriz|approval|explicit|wait/.test(lower) ? 2 : 0)
    + (input && expectedEvidence.length === input.evidenceTurnIds?.length && expectedEvidence.every((turnId) => input.evidenceTurnIds?.includes(turnId)) ? 1 : 0)
    + ((input?.changeSummary.length ?? 0) >= 30 ? 1 : 0)
}

class CostLedger {
  readonly entries: Array<{ phase: string; modelId: string; thinkingEnabled: boolean; thinkingEffort?: ThinkingEffort; usage: ModelUsage }> = []
  phase = "unassigned"
  totalCostUsd = 0
  constructor(readonly capUsd: number) {}
  reserveFor(request: ModelRequest): void {
    const reserve = request.modelId.includes("pro") ? 0.05 : 0.02
    if (this.totalCostUsd + reserve > this.capUsd) throw new Error(`Cost guard stopped before ${request.modelId}: $${this.totalCostUsd.toFixed(6)} spent with $${reserve.toFixed(2)} reserved against $${this.capUsd.toFixed(2)} cap.`)
  }
  record(request: ModelRequest, usage: ModelUsage): void {
    this.totalCostUsd += usage.costUsd ?? 0
    this.entries.push({ phase: this.phase, modelId: request.modelId, thinkingEnabled: request.runtimeConfig.thinkingEnabled, ...(request.runtimeConfig.thinkingEffort ? { thinkingEffort: request.runtimeConfig.thinkingEffort } : {}), usage })
    if (this.totalCostUsd > this.capUsd) throw new Error(`Provider cost exceeded hard cap: $${this.totalCostUsd.toFixed(6)} > $${this.capUsd.toFixed(2)}.`)
  }
  summary() {
    const grouped = new Map<string, typeof this.entries>()
    for (const entry of this.entries) grouped.set(entry.phase, [...(grouped.get(entry.phase) ?? []), entry])
    return {
      capUsd: this.capUsd,
      actualUsd: this.totalCostUsd,
      providerCalls: this.entries.length,
      inputTokens: this.entries.reduce((sum, item) => sum + (item.usage.inputTokens ?? 0), 0),
      cachedInputTokens: this.entries.reduce((sum, item) => sum + (item.usage.cachedInputTokens ?? 0), 0),
      outputTokens: this.entries.reduce((sum, item) => sum + (item.usage.outputTokens ?? 0), 0),
      byPhase: [...grouped.entries()].map(([phase, entries]) => ({ phase, costUsd: entries.reduce((sum, item) => sum + (item.usage.costUsd ?? 0), 0), calls: entries.length })),
    }
  }
}

class BudgetedProvider implements ModelProvider {
  constructor(private readonly inner: ModelProvider, private readonly cost: CostLedger) {}
  countTokens(request: ModelRequest) { return this.inner.countTokens(request) }
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.cost.reserveFor(request)
    let recorded = false
    for await (const event of this.inner.stream(request)) {
      if (event.type === "model.usage") {
        this.cost.record(request, event.usage)
        recorded = true
      } else if (event.type === "model.completed" && event.usage && !recorded) {
        this.cost.record(request, event.usage)
      }
      yield event
    }
  }
  async generateStructured<TOutput>(request: StructuredModelRequest<TOutput>): Promise<StructuredModelResult<TOutput>> {
    if (!this.inner.generateStructured) throw new Error("The official DeepSeek provider does not expose structured generation.")
    this.cost.reserveFor(request)
    const result = await this.inner.generateStructured(request)
    if (result.usage) this.cost.record(request, result.usage)
    return result
  }
}

const fakeEmbeddingProvider: EmbeddingProvider = {
  check: async () => ({ ok: true, dimensions: 4, message: "Deterministic evaluation embedding provider." }),
  embed: async () => ({ embeddings: [[0, 0, 0, 0]], dimensions: 4 }),
  embedMany: async (request) => ({ embeddings: request.values.map(() => [0, 0, 0, 0]), dimensions: 4 }),
}

function config(id: string, modelId: EvalConfig["modelId"], thinking: EvalConfig["thinking"]): EvalConfig {
  return { id, modelId, thinking, thinkingEnabled: thinking !== "off", ...(thinking === "high" ? { thinkingEffort: "high" as const } : thinking === "max" ? { thinkingEffort: "xhigh" as const } : {}) }
}
function modelSettings(candidate: EvalConfig) { return { providerId: "deepseek" as const, authMode: "api_key" as const, modelId: candidate.modelId, thinkingEnabled: candidate.thinkingEnabled, ...(candidate.thinkingEffort ? { thinkingEffort: candidate.thinkingEffort } : {}) } }
function runtimeConfig(candidate: EvalConfig): RuntimeConfig { return { ...modelSettings(candidate), approvalMode: "read_only_auto", sandboxMode: "read_only" } }
function caseFor(source: GoldenDataset, id: string): GoldenCase { const found = source.cases.find((item) => item.id === id); if (!found) throw new Error(`Missing golden case ${id}`); return found }
function expectedResponseSignals(item: GoldenCase): string[] | undefined { const value = item.expected.responseSignals; return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : undefined }
function parseRecord(value: string | null): Record<string, unknown> { try { const parsed = JSON.parse(value ?? "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} } }
function rankResult(left: { score: number; costUsd: number }, right: { score: number; costUsd: number }) { return right.score - left.score || left.costUsd - right.costUsd }
function bestValue<T extends { score: number; costUsd: number }>(items: T[]): T | undefined { return [...items].sort((a, b) => (b.score / Math.max(b.costUsd, 0.000001)) - (a.score / Math.max(a.costUsd, 0.000001)))[0] }
function uniquePairs(input: Array<{ memory?: EvalConfig; writer?: EvalConfig }>) { const seen = new Set<string>(); return input.filter((pair) => { const key = `${pair.memory?.id}+${pair.writer?.id}`; if (seen.has(key)) return false; seen.add(key); return true }) }
function validateDataset(source: GoldenDataset): void { if (source.schemaVersion !== 1) throw new Error("Unsupported golden dataset schema."); for (const id of ["behavioral-workflow-create", "repeated-topic-negative-control", "behavioral-workflow-update", "heldout-use-v1", "heldout-use-v2"]) caseFor(source, id) }
function parseArgs(args: string[]): Record<string, string> { return Object.fromEntries(args.map((arg) => { const [key, ...rest] = arg.replace(/^--/, "").split("="); return [key, rest.join("=") || "true"] })) }
function readDeepSeekKey(): string {
  const envPath = path.join(os.homedir(), ".Socrates", ".env")
  const text = fs.readFileSync(envPath, "utf8")
  const match = /^DEEPSEEK_API_KEY\s*=\s*(.+)$/m.exec(text)
  const key = match?.[1]?.trim().replace(/^['"]|['"]$/g, "")
  if (!key) throw new Error(`DEEPSEEK_API_KEY is not configured in ${envPath}`)
  return key
}
function checkpoint(value: Record<string, unknown>): void { console.log(JSON.stringify(value)) }

void main().catch((error) => {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), failed: true, error: error instanceof Error ? error.message : String(error), ...(ledger ? { cost: ledger.summary() } : {}) }, null, 2)}\n`, { mode: 0o600 })
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
