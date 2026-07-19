import {
  memoryRouterPostTurnResultSchema,
  memoryRouterPreTurnResultSchema,
  type MemoryRouterPostTurnResult,
  type MemoryRouterPreTurnResult,
  type MemorySearchInput,
  type MemorySearchOutput,
  type MemorySearchResult,
  type RuntimeConfig,
  type WorkerModelSettings,
} from "@socrates/contracts"
import type { ModelMessage, ModelProvider, ModelUsage } from "@socrates/providers"
import { normalizeError, nowIso } from "@socrates/shared"
import { chunkMarkdown } from "../retrieval"
import {
  buildPostTurnMemoryRouterUserContent,
  buildPreTurnMemoryRouterUserContent,
  POST_TURN_MEMORY_ROUTER_SYSTEM_PROMPT,
  PRE_TURN_MEMORY_ROUTER_SYSTEM_PROMPT,
} from "../prompts/memoryRoutingPrompt"
import { createMemoryFinalizationToolRegistry, createMemoryRouterToolRegistry } from "../tools/registry"
import type { ToolExecutors } from "../tools/types"
import { StructuredToolAgentRunner, type StructuredToolAgentRunInput } from "./StructuredToolAgentRunner"

const MAX_ROUTER_TOOL_CALLS = 3
const MAX_PREFETCH_SEGMENTS = 12
const MAX_MEMORY_RESULTS = 8

export type MemoryRouterAgentModelSettings = Pick<
  WorkerModelSettings,
  "providerId" | "authMode" | "modelId" | "thinkingEnabled" | "thinkingEffort"
>

type MemoryRouterAgentBaseInput = {
  modelSettings: MemoryRouterAgentModelSettings
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  workspacePath: string
  projectName?: string
  projectDescription?: string
  userMessage: string
  recentMessages: ModelMessage[]
  goalCandidates?: readonly GoalCandidateCard[]
  currentGoalCandidate?: number
  toolExecutors: ToolExecutors
  automaticMemorySearch?: (input: MemorySearchInput) => Promise<MemorySearchOutput>
  cacheKey?: string
  abortSignal?: AbortSignal
  recordRun?: (input: MemoryRouterRunRecord) => void | Promise<void>
}

export type MemoryRouterRunRecord = {
  phase: "pre_turn" | "post_evidence"
  status: "completed" | "failed"
  providerId: RuntimeConfig["providerId"]
  modelId: string
  usages: ModelUsage[]
  startedAt: string
  completedAt: string
  error?: { code: string; message: string; details?: unknown; recoverable: boolean }
}

export type GoalCandidateCard = Readonly<{
  goalId: string
  candidate: number
  status: string
  title: string
  note: string
}>

export type ActiveGoalCard = Readonly<{
  goalId: string
  title: string
  state: string
  note: string
}>

export type MemoryRouterPreTurnInput = MemoryRouterAgentBaseInput
export type MemoryRouterPostTurnInput = MemoryRouterAgentBaseInput & {
  preflightSummary?: string
  toolSummary: string
  assistantDraft: string
  activeGoal?: ActiveGoalCard
}

export class MemoryRouterAgent {
  private readonly runner = new StructuredToolAgentRunner()

  constructor(private readonly provider: ModelProvider) {}

  async routePreTurn(input: MemoryRouterPreTurnInput): Promise<MemoryRouterPreTurnResult> {
    const prefetch = await automaticPrefetch(input.userMessage, input.automaticMemorySearch)
    const startedAt = nowIso()
    return this.runRecorded(input, "pre_turn", startedAt, {
      provider: this.provider,
      providerId: input.modelSettings.providerId,
      modelId: input.modelSettings.modelId,
      runtimeConfig: routerRuntimeConfig(input.modelSettings),
      system: PRE_TURN_MEMORY_ROUTER_SYSTEM_PROMPT,
      userContent: buildPreTurnMemoryRouterUserContent({
        ...(input.projectName ? { projectName: input.projectName } : {}),
        ...(input.projectDescription ? { projectDescription: input.projectDescription } : {}),
        userMessage: input.userMessage,
        recentMessages: input.recentMessages,
        automaticCandidates: prefetch.results,
        ...(input.goalCandidates ? { goalCandidates: input.goalCandidates } : {}),
        ...(input.currentGoalCandidate ? { currentGoalCandidate: input.currentGoalCandidate } : {}),
        ...(prefetch.warning ? { automaticCoverageWarning: prefetch.warning } : {}),
      }),
      schema: memoryRouterPreTurnResultSchema,
      toolRegistry: createMemoryRouterToolRegistry(),
      toolExecutors: input.toolExecutors,
      maxToolCalls: MAX_ROUTER_TOOL_CALLS,
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      workspacePath: input.workspacePath,
      ...(input.cacheKey ? { cacheKey: `${input.cacheKey}:memory-router:pre-turn` } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    })
  }

  async routePostTurn(input: MemoryRouterPostTurnInput): Promise<MemoryRouterPostTurnResult> {
    const startedAt = nowIso()
    return this.runRecorded(input, "post_evidence", startedAt, {
      provider: this.provider,
      providerId: input.modelSettings.providerId,
      modelId: input.modelSettings.modelId,
      runtimeConfig: routerRuntimeConfig(input.modelSettings),
      system: POST_TURN_MEMORY_ROUTER_SYSTEM_PROMPT,
      userContent: buildPostTurnMemoryRouterUserContent({
        ...(input.projectName ? { projectName: input.projectName } : {}),
        ...(input.projectDescription ? { projectDescription: input.projectDescription } : {}),
        userMessage: input.userMessage,
        recentMessages: input.recentMessages,
        ...(input.preflightSummary ? { preflightSummary: input.preflightSummary } : {}),
        toolSummary: input.toolSummary,
        assistantDraft: input.assistantDraft,
        ...(input.activeGoal ? { activeGoal: input.activeGoal } : {}),
      }),
      schema: memoryRouterPostTurnResultSchema,
      toolRegistry: createMemoryFinalizationToolRegistry(),
      toolExecutors: input.toolExecutors,
      maxToolCalls: MAX_ROUTER_TOOL_CALLS,
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      workspacePath: input.workspacePath,
      ...(input.cacheKey ? { cacheKey: `${input.cacheKey}:memory-router:post-evidence` } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    })
  }

  private async runRecorded<TOutput>(
    input: MemoryRouterAgentBaseInput,
    phase: MemoryRouterRunRecord["phase"],
    startedAt: string,
    runInput: StructuredToolAgentRunInput<TOutput>,
  ): Promise<TOutput> {
    const observedUsages: ModelUsage[] = []
    try {
      const result = await this.runner.run<TOutput>({
        ...runInput,
        onUsage: (usage) => {
          observedUsages.push(usage)
        },
      })
      await input.recordRun?.({
        phase,
        status: "completed",
        providerId: input.modelSettings.providerId,
        modelId: input.modelSettings.modelId,
        usages: result.usages,
        startedAt,
        completedAt: nowIso(),
      })
      return result.output
    } catch (error) {
      const normalized = normalizeError(error)
      await input.recordRun?.({
        phase,
        status: "failed",
        providerId: input.modelSettings.providerId,
        modelId: input.modelSettings.modelId,
        usages: observedUsages,
        startedAt,
        completedAt: nowIso(),
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details === undefined ? {} : { details: normalized.details }),
          recoverable: normalized.recoverable,
        },
      })
      throw error
    }
  }
}

const automaticPrefetch = async (
  userMessage: string,
  search: MemoryRouterAgentBaseInput["automaticMemorySearch"],
): Promise<{ results: MemorySearchResult[]; warning?: string }> => {
  if (!search || !userMessage.trim()) return { results: [] }
  const chunks = chunkMarkdown(userMessage)
  const selectedChunks = chunks.slice(0, MAX_PREFETCH_SEGMENTS)
  const outputs = await Promise.allSettled(
    selectedChunks.map((chunk) =>
      search({ query: chunk.content.slice(0, 1_000), mode: "combined", scope: "all", limit: MAX_MEMORY_RESULTS }),
    ),
  )
  const merged = new Map<string, MemorySearchResult>()
  for (const output of outputs) {
    if (output.status !== "fulfilled") continue
    for (const result of output.value.results) {
      const key = `${result.surface}:${result.fileName}:${result.sectionId}`
      if (!merged.has(key)) merged.set(key, result)
      if (merged.size >= MAX_MEMORY_RESULTS) break
    }
    if (merged.size >= MAX_MEMORY_RESULTS) break
  }
  const results = [...merged.values()].map((result, index) => ({ ...result, resultNumber: index + 1 }))
  const failures = outputs.filter((output) => output.status === "rejected").length
  const warnings = [
    chunks.length > MAX_PREFETCH_SEGMENTS ? `The prompt produced ${chunks.length} segments; automatic recall covered the first ${MAX_PREFETCH_SEGMENTS}. Use memory_search for uncovered concepts.` : "",
    failures > 0 ? `${failures} automatic retrieval segment(s) failed; use targeted memory_search if context is missing.` : "",
  ].filter(Boolean)
  return { results, ...(warnings.length ? { warning: warnings.join(" ") } : {}) }
}

const routerRuntimeConfig = (settings: MemoryRouterAgentModelSettings): RuntimeConfig => ({
  providerId: settings.providerId,
  authMode: settings.authMode ?? "api_key",
  modelId: settings.modelId,
  thinkingEnabled: settings.thinkingEnabled,
  ...(settings.thinkingEffort ? { thinkingEffort: settings.thinkingEffort } : {}),
  approvalMode: "read_only_auto",
  sandboxMode: "read_only",
})
