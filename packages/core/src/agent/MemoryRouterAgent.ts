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
import { nowIso } from "@socrates/shared"
import { chunkMarkdown } from "../retrieval"
import {
  buildPostTurnMemoryRouterUserContent,
  buildPreTurnMemoryRouterUserContent,
  POST_TURN_MEMORY_ROUTER_SYSTEM_PROMPT,
  PRE_TURN_MEMORY_ROUTER_SYSTEM_PROMPT,
} from "../prompts/memoryRoutingPrompt"
import { createMemoryFinalizationToolRegistry, createMemoryRouterToolRegistry } from "../tools/registry"
import type { ToolExecutors } from "../tools/types"
import { StructuredToolAgentRunner } from "./StructuredToolAgentRunner"

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
  toolExecutors: ToolExecutors
  automaticMemorySearch?: (input: MemorySearchInput) => Promise<MemorySearchOutput>
  cacheKey?: string
  abortSignal?: AbortSignal
  recordUsage?: (input: { phase: "pre_turn" | "post_evidence"; sourceId: string; providerId: RuntimeConfig["providerId"]; modelId: string; usage: ModelUsage; startedAt: string; completedAt: string }) => void | Promise<void>
}

export type MemoryRouterPreTurnInput = MemoryRouterAgentBaseInput
export type MemoryRouterPostTurnInput = MemoryRouterAgentBaseInput & {
  preflightSummary?: string
  toolSummary: string
  assistantDraft: string
}

export class MemoryRouterAgent {
  private readonly runner = new StructuredToolAgentRunner()

  constructor(private readonly provider: ModelProvider) {}

  async routePreTurn(input: MemoryRouterPreTurnInput): Promise<MemoryRouterPreTurnResult> {
    const prefetch = await automaticPrefetch(input.userMessage, input.automaticMemorySearch)
    const startedAt = nowIso()
    const result = await this.runner.run({
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
    await recordUsages(input, "pre_turn", result.usages, startedAt)
    return result.output
  }

  async routePostTurn(input: MemoryRouterPostTurnInput): Promise<MemoryRouterPostTurnResult> {
    const startedAt = nowIso()
    const result = await this.runner.run({
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
    await recordUsages(input, "post_evidence", result.usages, startedAt)
    return result.output
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

const recordUsages = async (
  input: MemoryRouterAgentBaseInput,
  phase: "pre_turn" | "post_evidence",
  usages: ModelUsage[],
  startedAt: string,
): Promise<void> => {
  if (!input.recordUsage) return
  for (const [index, usage] of usages.entries()) {
    await input.recordUsage({
      phase,
      sourceId: `${input.turnId}:memory_router:${phase}:${index + 1}`,
      providerId: input.modelSettings.providerId,
      modelId: input.modelSettings.modelId,
      usage,
      startedAt,
      completedAt: nowIso(),
    })
  }
}
