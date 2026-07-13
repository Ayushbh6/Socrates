import {
  normalizedToolCallSchema,
  toolExecutionResultSchema,
  waitToolOutputSchema,
  type MemoryRouterPostTurnResult,
  type MemoryRouterPreTurnResult,
  type MemoryReconciliationAction,
  type MemorySearchInput,
  type MemorySearchOutput,
  type ModelToolDefinition,
  type NormalizedToolCall,
  type ProviderId,
  type RuntimeConfig,
  type ToolExecutionResult,
  type ToolName,
  type WaitToolOutput,
  type WorkerModelSettings,
} from "@socrates/contracts"
import fs from "node:fs"
import path from "node:path"
import { createId, normalizeError, nowIso, SocratesError } from "@socrates/shared"
import type { ModelEvent, ModelMessage, ModelMessagePart, ModelProvider, ModelUsage, TokenCountResult } from "@socrates/providers"
import {
  prepareContextForModelCall,
  precomputeContextSnapshot,
  type ContextCompactionLifecycleEvent,
  type ContextCompressionRuntime,
} from "../context/contextCompression"
import { buildSocratesDynamicContext, buildSocratesSystemPrompt, type SocratesPromptContext } from "../prompts/socratesPrompt"
import { renderSocratesSurfaceMap } from "@socrates/contracts"
import { createDefaultToolRegistry, type ToolRegistry } from "../tools/registry"
import type { ApprovalDecision, ApprovalRequest, CredentialInputDecision, CredentialInputRequest, ToolExecutors, ToolLifecycleEvent, ToolPolicyDecision, ToolRuntimeContext } from "../tools/types"
import { MemoryRouterAgent } from "./MemoryRouterAgent"

export type SocratesAgentTurnInput = {
  projectId?: string
  conversationId?: string
  sessionId?: string
  cacheKey?: string
  turnId?: string
  providerId: ProviderId
  modelId: string
  runtimeConfig: RuntimeConfig
  memoryRouterModelSettings?: MemoryRouterModelSettings
  messages: ModelMessage[]
  promptContext?: SocratesPromptContext
  systemPromptOverride?: string
  workspacePath?: string
  toolExecutors?: ToolExecutors
  createModelCall?: (input: {
    providerId: ProviderId
    modelId: string
    runtimeConfig: RuntimeConfig
    messages: ModelMessage[]
    estimatedTokens: number
    tokenCount: TokenCountResult
    promptContext?: SocratesPromptContext
    tools: ModelToolDefinition[]
  }) => string
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>
  requestCredentialInput?: (request: CredentialInputRequest) => Promise<CredentialInputDecision>
  stableCachePreludeSnapshot?: StableCachePreludeSnapshot
  recordMemoryRouterUsage?: (input: MemoryRouterUsageRecord) => void | Promise<void>
  automaticMemorySearch?: (input: MemorySearchInput) => Promise<MemorySearchOutput>
  contextCompression?: ContextCompressionRuntime
  maxToolCallsPerTurn?: number
  maxConfirmedToolErrorsPerTurn?: number
  maxParallelToolCalls?: number
  dynamicTools?: ModelToolDefinition[] | (() => ModelToolDefinition[])
  abortSignal?: AbortSignal
  fileFreshness?: import("../tools/types").FileFreshnessTracker
}

export type StableCachePreludeSnapshot = {
  projectRules?: string
  globalRules?: string
  identitySections: Partial<Record<"core_identity" | "voice_and_presence" | "relationship_to_user", string>>
  cacheHit?: boolean
}

export type MemoryLoopPhase = "pre_turn" | "post_evidence"

export type MemoryRouterModelSettings = Pick<WorkerModelSettings, "providerId" | "authMode" | "modelId" | "thinkingEnabled" | "thinkingEffort">

export type MemoryRouterUsageRecord = {
  phase: MemoryLoopPhase
  sourceId: string
  providerId: ProviderId
  modelId: string
  usage: ModelUsage
  startedAt: string
  completedAt: string
}

export type SocratesAgentContextPrecomputeInput = {
  providerId: ProviderId
  modelId: string
  runtimeConfig: RuntimeConfig
  messages: ModelMessage[]
  promptContext?: SocratesPromptContext
  contextCompression: ContextCompressionRuntime
}

export type SocratesAgentEvent = ModelEvent | ToolLifecycleEvent | ContextCompactionLifecycleEvent | { type: "agent.suspended"; wait: WaitToolOutput }

export class SocratesAgent {
  private readonly memoryRouterAgent: MemoryRouterAgent

  constructor(
    private readonly provider: ModelProvider,
    private readonly toolRegistry: ToolRegistry = createDefaultToolRegistry(),
  ) {
    this.memoryRouterAgent = new MemoryRouterAgent(provider)
  }

  async precomputeContext(input: SocratesAgentContextPrecomputeInput): Promise<ContextCompactionLifecycleEvent[]> {
    const system = buildSocratesSystemPrompt()
    const messages = [...input.messages]
    insertDynamicPromptContext(messages, input.promptContext)
    return precomputeContextSnapshot({
      provider: this.provider,
      providerId: input.providerId,
      modelId: input.modelId,
      runtimeConfig: input.runtimeConfig,
      system,
      messages,
      compression: input.contextCompression,
    })
  }

  async *streamTurn(input: SocratesAgentTurnInput): AsyncIterable<SocratesAgentEvent> {
    const system = input.systemPromptOverride ?? buildSocratesSystemPrompt()
    const messages: ModelMessage[] = [...input.messages]
    const maxToolCallsPerTurn = input.maxToolCallsPerTurn ?? 80
    const maxConfirmedToolErrorsPerTurn = input.maxConfirmedToolErrorsPerTurn ?? 10
    const maxParallelToolCalls = input.maxParallelToolCalls ?? 5
    let usedToolCalls = 0
    let confirmedToolErrors = 0
    let forceFinalNoTools = false
    const duplicateTraceRetrieveResults = new Map<string, unknown>()
    const toolInputCounts = new Map<string, number>()
    const openRouterPreferredProvidersByModel = new Map<string, string>()
    const actionLedger = new TurnActionLedger()
    const docsLedger = new TurnDocsLedger()
    const memorySaveLedger = new TurnMemorySaveLedger()
    let totalToolCountNudgeSent = false
    let baselineInputTokens: number | undefined
    let currentTurnTokenSoftNudgeSent = false
    let currentTurnTokenHardStopSent = false
    let docsPreflightSent = false
    let docsSyncCheckpointSent = false
    let pendingInteractiveTerminalName: string | undefined
    let preTurnMemoryLoopSummary: string | undefined
    let finalReconciliationSent = false
    let accumulatedAnswerText = ""
    const memoryFinalizationEnabled = canRunMemoryLoop(this.provider, input, this.toolRegistry)
    const reconciliationVerification = new ReconciliationVerificationLedger()
    let reconciliationReminderCount = 0

    const preTurnMemoryLoop = await this.runPreTurnMemoryLoop(input, messages, docsLedger)
    preTurnMemoryLoopSummary = preTurnMemoryLoop.summary
    for (const event of preTurnMemoryLoop.events) {
      yield event
    }
    if (preTurnMemoryLoop.stableCachePreludeMessage) {
      insertStableCachePrelude(messages, preTurnMemoryLoop.stableCachePreludeMessage)
    }
    insertDynamicPromptContext(messages, input.promptContext)
    if (preTurnMemoryLoop.developerMessage) {
      messages.push({ role: "developer", content: preTurnMemoryLoop.developerMessage })
    }
    if (input.toolExecutors && input.workspacePath) {
      messages.push({
        role: "developer",
        content: `<runtime_terminal_capabilities>
Current runtime fact: the bash tool is a fully interactive, conversation-scoped PTY Terminal with operation="start", inputMode="user", plus live user input, and wait can suspend until completed or failed. This current capability contract overrides contradictory project memory, notes, prior chats, or known-pitfall text. Never tell the user interactive Terminal is unavailable. For an interactive Terminal request, perform the required docs preflight and then use bash operation="start", inputMode="user", with a portable Node.js or Python stdin program.
</runtime_terminal_capabilities>`,
      })
    }
    memorySaveLedger.recordMemoryLoopRecords(preTurnMemoryLoop.records ?? [])
    const preTurnMemoryLedgerMessage = memorySaveLedger.flushDeveloperMessage()
    if (preTurnMemoryLedgerMessage) {
      messages.push({ role: "developer", content: preTurnMemoryLedgerMessage })
    }

    for (let step = 0; ; step += 1) {
      const dynamicTools = typeof input.dynamicTools === "function" ? input.dynamicTools() : input.dynamicTools
      const tools = forceFinalNoTools || !input.toolExecutors ? [] : this.toolRegistry.modelDefinitions(dynamicTools)
      if (!docsPreflightSent && input.toolExecutors && input.workspacePath && tools.length > 0) {
        messages.push({ role: "developer", content: DOCS_PREFLIGHT_CHECKPOINT })
        docsPreflightSent = true
      }
      const compactionStartedEvents = new AsyncEventQueue<ContextCompactionLifecycleEvent>()
      const preparedContextPromise = (async () => {
        try {
          return await prepareContextForModelCall({
            provider: this.provider,
            providerId: input.providerId,
            modelId: input.modelId,
            runtimeConfig: input.runtimeConfig,
            system,
            messages,
            tools,
            ...(input.contextCompression ? { compression: input.contextCompression } : {}),
            onCompactionStarted: (event) => compactionStartedEvents.push(event),
          })
        } finally {
          compactionStartedEvents.close()
        }
      })()
      void preparedContextPromise.catch(() => undefined)

      for await (const event of compactionStartedEvents) {
        yield event
      }

      const preparedContext = await preparedContextPromise
      for (const event of preparedContext.compactionEvents) {
        yield event
        if (event.type === "context.compaction.failed") {
          throw event.error
        }
      }
      if (input.abortSignal?.aborted) {
        return
      }
      baselineInputTokens ??= preparedContext.estimatedTokens
      const currentTurnTokenGrowth = Math.max(0, preparedContext.estimatedTokens - baselineInputTokens)
      if (!forceFinalNoTools && tools.length > 0 && currentTurnTokenGrowth >= 80_000 && !currentTurnTokenHardStopSent) {
        messages.push({
          role: "developer",
          content:
            "Runtime anti-spiral guard: current-turn context growth is above 80k estimated tokens. Do not call more tools. Give a concise status/final answer from the evidence already gathered, mention uncertainty, and ask the user to refine or continue if more investigation is needed.",
        })
        forceFinalNoTools = true
        currentTurnTokenHardStopSent = true
        continue
      }
      if (!forceFinalNoTools && tools.length > 0 && currentTurnTokenGrowth >= 50_000 && !currentTurnTokenSoftNudgeSent) {
        messages.push({
          role: "developer",
          content:
            "Runtime efficiency warning: current-turn context growth is above 50k estimated tokens. Stop repeating investigation. Use the action ledger and answer unless one specific missing fact is essential.",
        })
        currentTurnTokenSoftNudgeSent = true
        continue
      }
      const modelCallId = input.createModelCall?.({
        providerId: input.providerId,
        modelId: input.modelId,
        runtimeConfig: input.runtimeConfig,
        messages: preparedContext.messages,
        estimatedTokens: preparedContext.estimatedTokens,
        tokenCount: preparedContext.tokenCount,
        tools,
        ...(input.promptContext ? { promptContext: input.promptContext } : {}),
      })
      const assistantParts: ModelMessagePart[] = []
      const toolCalls: NormalizedToolCall[] = []
      const repeatedToolInputsThisStep = new Set<string>()
      const toolRunIds = new Map<string, string>()
      let stepText = ""
      // The first no-tool answer is a proposed draft. Hold its user-visible
      // deltas until the genuine task-finalization router has run.
      const suppressAnswerDeltas = docsLedger.requiresProjectMemoryReview() || (memoryFinalizationEnabled && !finalReconciliationSent && tools.length > 0)
      const preferredOpenRouterProvider =
        input.providerId === "openrouter" ? openRouterPreferredProvidersByModel.get(input.modelId) : undefined
      const toolRunIdFor = (providerToolCallId: string): string => {
        const key = `${modelCallId ?? "model"}:${step}:${providerToolCallId}`
        const existing = toolRunIds.get(key)
        if (existing) {
          return existing
        }
        const toolRunId = createId("tcall")
        toolRunIds.set(key, toolRunId)
        return toolRunId
      }

      for await (const modelEvent of this.provider.stream({
        providerId: input.providerId,
        modelId: input.modelId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
        ...(preferredOpenRouterProvider ? { providerRouting: { preferredOpenRouterProvider } } : {}),
        system,
        messages: preparedContext.messages,
        runtimeConfig: input.runtimeConfig,
        tools,
        ...(modelCallId ? { modelCallId } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      })) {
        if (input.abortSignal?.aborted) {
          return
        }

        if (modelEvent.type === "model.answer.delta") {
          stepText += modelEvent.text
          accumulatedAnswerText += modelEvent.text
          if (suppressAnswerDeltas) {
            continue
          }
        }

        if (input.providerId === "openrouter" && (modelEvent.type === "model.usage" || modelEvent.type === "model.completed")) {
          const routedProvider = modelEvent.usage?.routedProvider?.trim()
          if (routedProvider && !openRouterPreferredProvidersByModel.has(input.modelId)) {
            openRouterPreferredProvidersByModel.set(input.modelId, routedProvider)
          }
        }

        if (modelEvent.type === "model.reasoning.completed") {
          assistantParts.push({
            type: "reasoning",
            text: modelEvent.text,
            ...(modelEvent.providerMetadata ? { providerMetadata: modelEvent.providerMetadata } : {}),
          })
        }

        if (modelEvent.type === "model.tool_call.streaming") {
          const tool = this.toolRegistry.get(modelEvent.toolName as ToolName)
          if (tool) {
            const preview = extractStreamingPreview(modelEvent.toolName, modelEvent.argsText)
            yield {
              type: "tool.call.streaming",
              toolCallId: toolRunIdFor(modelEvent.toolCallId),
              providerToolCallId: modelEvent.toolCallId,
              toolName: tool.name,
              category: tool.category,
              displayName: tool.name,
              ...(preview.argsPreview ? { argsPreview: preview.argsPreview } : {}),
              ...(preview.pathPreview ? { pathPreview: preview.pathPreview } : {}),
              ...(modelCallId ? { modelCallId } : {}),
              stepIndex: step,
            }
          }
          continue
        }

        if (modelEvent.type === "model.tool_call.completed") {
          const parsed = normalizedToolCallSchema.safeParse(modelEvent.toolCall)
          if (parsed.success) {
            const inputKey = stableToolInputKey(parsed.data.toolName, parsed.data.input)
            const nextCount = (toolInputCounts.get(inputKey) ?? 0) + 1
            toolInputCounts.set(inputKey, nextCount)
            if (nextCount >= 3) {
              repeatedToolInputsThisStep.add(`${parsed.data.toolName} ${JSON.stringify(parsed.data.input)}`)
            }
            toolCalls.push({
              ...parsed.data,
              toolCallId: toolRunIdFor(parsed.data.toolCallId),
              providerToolCallId: parsed.data.toolCallId,
            })
          }
        }

        yield attachModelMetadata(modelEvent, modelCallId, step)
      }

      if (toolCalls.length === 0 && docsLedger.requiresProjectMemoryReview()) {
        if (!input.toolExecutors || tools.length === 0) {
          throw memoryReviewRequiredError()
        }
        // This is deterministic runtime bookkeeping, not a judgment call. Some
        // providers repeatedly attempt a final answer instead of following the
        // reminder, which used to turn a healthy interactive Terminal into a
        // failed turn. Execute the bounded required read through the normal tool
        // lifecycle so it remains visible, auditable, and available to the model.
        const providerToolCallId = createId("tcall")
        toolCalls.push({
          toolCallId: toolRunIdFor(providerToolCallId),
          providerToolCallId,
          toolName: "project_docs",
          input: { operation: "read", area: "memory", charLimit: 10_000 },
        })
      }

      if (toolCalls.length === 0 && pendingInteractiveTerminalName) {
        if (!input.toolExecutors || tools.length === 0) {
          throw new SocratesError("interactive_terminal_wait_required", `Interactive Terminal "${pendingInteractiveTerminalName}" is still awaiting user input.`, {
            recoverable: true,
          })
        }
        // Once the prompt is visible, the user interacts directly with the PTY.
        // Suspend deterministically until the full program finishes instead of
        // relying on every provider to remember the wait call after drafting text.
        const providerToolCallId = createId("tcall")
        toolCalls.push({
          toolCallId: toolRunIdFor(providerToolCallId),
          providerToolCallId,
          toolName: "wait",
          input: {
            terminalNames: [pendingInteractiveTerminalName],
            wakeOn: ["completed", "failed"],
            reason: "Awaiting interactive Terminal completion",
          },
        })
      }

      if (toolCalls.length === 0 && input.toolExecutors && tools.length > 0 && !finalReconciliationSent && memoryFinalizationEnabled) {
        const evidence = input.toolExecutors.turn_evidence
          ? await input.toolExecutors.turn_evidence(
              { operation: "overview", limit: 10, charLimit: 8_000 },
              {
                projectId: input.projectId ?? "",
                conversationId: input.conversationId ?? "",
                sessionId: input.sessionId ?? "",
                turnId: input.turnId ?? "",
                workspacePath: input.workspacePath ?? "",
                runtimeConfig: input.runtimeConfig,
                ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
              },
            )
          : undefined
        const finalMemoryLoop = await this.runPostEvidenceMemoryLoop(input, messages, {
          ...(preTurnMemoryLoopSummary ? { preflightSummary: preTurnMemoryLoopSummary } : {}),
          toolSummary: evidence
            ? JSON.stringify({
                scope: { taskId: evidence.taskId, rootTurnId: evidence.rootTurnId, status: evidence.status, resumedCount: evidence.resumedCount },
                overview: evidence.content,
                references: evidence.references,
                truncation: evidence.truncation,
              })
            : "No structured task evidence was available.",
          assistantDraft: stepText || accumulatedAnswerText,
        })
        finalReconciliationSent = true
        reconciliationVerification.require(finalMemoryLoop.reconciliationActions ?? [])
        for (const event of finalMemoryLoop.events) yield event
        if (finalMemoryLoop.developerMessage) {
          messages.push({ role: "developer", content: finalMemoryLoop.developerMessage })
          continue
        }
        messages.push({ role: "developer", content: "Task finalization check completed with no .socrates reconciliation needed. Give the final answer now without more tools." })
        forceFinalNoTools = true
        continue
      }

      if (toolCalls.length === 0 && finalReconciliationSent && reconciliationVerification.hasPending()) {
        if (reconciliationReminderCount >= 2) {
          throw new SocratesError("memory_reconciliation_incomplete", `Required .socrates reconciliation was not verified: ${reconciliationVerification.pendingSummary()}`, { recoverable: true })
        }
        reconciliationReminderCount += 1
        messages.push({
          role: "developer",
          content: `Final answer is blocked until the required .socrates reconciliation is completed and verified. Pending: ${reconciliationVerification.pendingSummary()}. Read the current target, apply the exact update, then read that same section again after the mutation.`,
        })
        continue
      }

      if (!input.toolExecutors || tools.length === 0 || toolCalls.length === 0) {
        return
      }

      if (!input.workspacePath) {
        throw new SocratesError("workspace_path_required", "Tool execution requires an active project workspace")
      }
      if (!input.requestApproval) {
        throw new SocratesError("approval_handler_required", "Tool execution requires an approval handler")
      }

      if (stepText) {
        assistantParts.push({ type: "text", text: stepText })
      }
      assistantParts.push(
        ...toolCalls.map((toolCall) => ({
          type: "tool-call" as const,
          toolCallId: toolCall.providerToolCallId ?? toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
          ...(toolCall.providerMetadata ? { providerMetadata: toolCall.providerMetadata } : {}),
        })),
      )

      const batch = this.executeToolCalls({
        toolCalls,
        context: {
          projectId: input.projectId ?? "",
          conversationId: input.conversationId ?? "",
          sessionId: input.sessionId ?? "",
          turnId: input.turnId ?? "",
          workspacePath: input.workspacePath,
          runtimeConfig: input.runtimeConfig,
          executors: input.toolExecutors,
          requestApproval: input.requestApproval,
          requestCredentialInput:
            input.requestCredentialInput ??
            (async (request) => ({ decision: "cancelled" as const, source: request.source })),
          modelCallId,
          stepIndex: step,
          ...(input.fileFreshness ? { fileFreshness: input.fileFreshness } : {}),
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        },
        remainingBudget: maxToolCallsPerTurn - usedToolCalls,
        maxParallelToolCalls,
        duplicateTraceRetrieveResults,
        docsLedger,
      })

      for await (const event of batch.events) {
        yield event
      }

      const execution = await batch.done
      const interactiveTerminalName = interactiveTerminalAwaitingInput(execution.results)
      if (interactiveTerminalName) {
        pendingInteractiveTerminalName = interactiveTerminalName
      }
      const waitResult = execution.results.find(
        (result): result is ToolExecutionResult & { ok: true; output: WaitToolOutput } =>
          result.ok === true && result.toolName === "wait" && waitToolOutputSchema.safeParse(result.output).success,
      )
      if (waitResult?.output.status === "waiting") {
        yield { type: "agent.suspended", wait: waitResult.output }
        return
      }
      const nextUsedToolCalls = usedToolCalls + execution.countedToolCalls
      if (nextUsedToolCalls >= 10) {
        compactPriorToolHistoryForModel(messages)
      }
      usedToolCalls += execution.countedToolCalls
      const confirmedToolErrorResults = execution.results.filter(isConfirmedToolErrorResult)
      confirmedToolErrors += confirmedToolErrorResults.length

      messages.push({ role: "assistant", content: assistantParts })
      messages.push({
        role: "tool",
        content: execution.results.map((result) => ({
          type: "tool-result",
          toolCallId: result.providerToolCallId ?? result.toolCallId,
          toolName: result.toolName,
          output: sanitizeToolExecutionResultForModel(result, result.providerToolCallId ?? result.toolCallId),
        })),
      })
      const nativeToolMessages = execution.results.flatMap((result) => nativeFollowUpMessagesForToolResult(result, input.workspacePath))
      messages.push(...nativeToolMessages)
      docsLedger.recordBatch({ toolCalls, results: execution.results })
      reconciliationVerification.recordBatch(toolCalls, execution.results)
      const ledgerUpdate = actionLedger.recordBatch({
        toolCalls,
        results: execution.results,
        estimatedTokens: preparedContext.estimatedTokens,
        currentTurnTokenGrowth,
      })
      messages.push({ role: "developer", content: ledgerUpdate.summary })
      for (const warning of ledgerUpdate.warnings) {
        messages.push({ role: "developer", content: warning })
      }
      memorySaveLedger.recordBatch({ toolCalls, results: execution.results })
      const memoryLedgerMessage = memorySaveLedger.flushDeveloperMessage()
      if (memoryLedgerMessage) {
        messages.push({ role: "developer", content: memoryLedgerMessage })
      }
      if (!docsSyncCheckpointSent) {
        const checkpoint = docsLedger.buildSyncCheckpoint()
        if (checkpoint) {
          messages.push({ role: "developer", content: checkpoint })
          docsSyncCheckpointSent = true
        }
      }
      if (repeatedToolInputsThisStep.size > 0) {
        messages.push({
          role: "user",
          content: `You have repeated the same exact tool call input at least 3 times this turn (${[...repeatedToolInputsThisStep].slice(0, 3).join("; ")}). Stop repeating identical calls. Either answer from the evidence already gathered, inspect a different target, or ask the user for more information.`,
        })
      }
      if (!totalToolCountNudgeSent && usedToolCalls >= 50) {
        messages.push({
          role: "user",
          content:
            "You have made 50 or more tool calls in this turn. Before using more tools, decide whether you already have enough evidence to answer. If not, ask the user to continue or state the specific missing evidence.",
        })
        totalToolCountNudgeSent = true
      }

      if (maxConfirmedToolErrorsPerTurn > 0 && confirmedToolErrors >= maxConfirmedToolErrorsPerTurn) {
        const recentCodes = [...new Set(confirmedToolErrorResults.map((result) => result.error?.code).filter(Boolean))]
        messages.push({
          role: "user",
          content: `There have been ${confirmedToolErrors} confirmed tool-call execution errors this turn${recentCodes.length > 0 ? ` (latest codes: ${recentCodes.join(", ")})` : ""}. Do not call more tools. Give the best final answer from the evidence already available, and mention any remaining uncertainty or the exact tool-error blocker.`,
        })
        forceFinalNoTools = true
      } else if (ledgerUpdate.forceFinalReason) {
        messages.push({
          role: "developer",
          content: `Runtime anti-spiral guard: ${ledgerUpdate.forceFinalReason} Do not call more tools. Give a concise status/final answer from the evidence already available, mention uncertainty, and ask the user to refine or continue if more investigation is needed.`,
        })
        forceFinalNoTools = true
      } else if (execution.budgetExhausted || usedToolCalls >= maxToolCallsPerTurn) {
        messages.push({
          role: "user",
          content:
            "The per-turn tool-call budget has been exhausted. Do not call more tools. Give the best final answer from the evidence already available, and mention any remaining uncertainty.",
        })
        forceFinalNoTools = true
      }
    }
  }

  private executeToolCalls(input: {
    toolCalls: NormalizedToolCall[]
    context: ToolRuntimeContext
    remainingBudget: number
    maxParallelToolCalls: number
    duplicateTraceRetrieveResults: Map<string, unknown>
    docsLedger: TurnDocsLedger
  }): { events: AsyncIterable<ToolLifecycleEvent>; done: Promise<{ results: ToolExecutionResult[]; countedToolCalls: number; budgetExhausted: boolean }> } {
    const queue = new AsyncEventQueue<ToolLifecycleEvent>()
    const done = (async () => {
      const results = new Map<string, ToolExecutionResult>()
      let countedToolCalls = 0
      let budgetExhausted = false
      const runnable: NormalizedToolCall[] = []

      for (const toolCall of input.toolCalls) {
        if (countedToolCalls >= input.remainingBudget) {
          budgetExhausted = true
          const error = new SocratesError("tool_budget_exhausted", "The per-turn tool-call budget was exhausted.")
          queue.push({
            type: "tool.call.failed",
            toolCallId: toolCall.toolCallId,
            providerToolCallId: toolCall.providerToolCallId,
            toolName: toolCall.toolName,
            error,
          })
          results.set(toolCall.toolCallId, toolErrorResult(toolCall, error))
          continue
        }
        countedToolCalls += 1
        runnable.push(toolCall)
      }

      const parallel = runnable.filter((toolCall) => this.toolRegistry.get(toolCall.toolName)?.executeLane === "parallel")
      const mutation = runnable.filter((toolCall) => this.toolRegistry.get(toolCall.toolName)?.executeLane !== "parallel")

      for (let index = 0; index < parallel.length; index += input.maxParallelToolCalls) {
        const chunk = parallel.slice(index, index + input.maxParallelToolCalls)
        const chunkResults = await Promise.all(
          chunk.map((toolCall) => this.executeOneToolCall(toolCall, input.context, queue, input.duplicateTraceRetrieveResults, input.docsLedger)),
        )
        for (const result of chunkResults) {
          results.set(result.toolCallId, result)
        }
      }

      for (const toolCall of mutation) {
        const result = await this.executeOneToolCall(toolCall, input.context, queue, input.duplicateTraceRetrieveResults, input.docsLedger)
        results.set(result.toolCallId, result)
      }

      queue.close()
      return {
        results: input.toolCalls.map((toolCall) => results.get(toolCall.toolCallId) ?? toolErrorResult(toolCall, new SocratesError("tool_not_executed", "Tool was not executed."))),
        countedToolCalls,
        budgetExhausted,
      }
    })().catch((error) => {
      queue.close()
      throw error
    })

    return { events: queue, done }
  }

  private async runPreTurnMemoryLoop(
    input: SocratesAgentTurnInput,
    messages: ModelMessage[],
    docsLedger: TurnDocsLedger,
  ): Promise<MemoryLoopRunResult> {
    if (!input.stableCachePreludeSnapshot && !canLoadStableCachePrelude(input, this.toolRegistry)) {
      return emptyMemoryLoopRunResult()
    }

    const events: ToolLifecycleEvent[] = []
    const records: MemoryLoopToolRecord[] = []
    if (!input.stableCachePreludeSnapshot) {
      for (const request of stablePreludeRecallRequests()) {
        const record = await this.executeMemoryLoopTool(input, docsLedger, request)
        events.push(...record.events)
        records.push(record)
      }
    }
    const stableCachePreludeMessage = input.stableCachePreludeSnapshot
      ? renderStableCachePreludeSnapshot(input.stableCachePreludeSnapshot)
      : renderStableCachePrelude(records)

    if (!canRunMemoryLoop(this.provider, input, this.toolRegistry)) {
      return {
        events: [],
        records,
        ...(stableCachePreludeMessage ? { stableCachePreludeMessage } : {}),
      }
    }

    try {
      const route = await this.memoryRouterAgent.routePreTurn(memoryRouterBaseInput(input, messages))
      const skipped: string[] = []

      for (const request of routedPreTurnRecallRequests(route)) {
        const record = await this.executeMemoryLoopTool(input, docsLedger, request)
        events.push(...record.events)
        records.push(record)
      }

      const summary = summarizeMemoryLoop("pre_turn", route, records, skipped)
      const dynamicRecords = records.filter((record) => !isStableCachePreludeRecord(record))
      return {
        events,
        summary,
        records,
        ...(stableCachePreludeMessage ? { stableCachePreludeMessage } : {}),
        developerMessage: renderMemoryLoopDeveloperMessage("pre_turn", route, dynamicRecords, skipped, {
          stableCachePreludeApplied: Boolean(stableCachePreludeMessage),
        }),
      }
    } catch (error) {
      const normalized = normalizeError(error)
      const warning = memoryLoopWarning("pre_turn", `${normalized.code}: ${normalized.message}`)
      return {
        ...warning,
        events: [...events, ...warning.events],
        records,
        ...(stableCachePreludeMessage ? { stableCachePreludeMessage } : {}),
      }
    }
  }

  private async runPostEvidenceMemoryLoop(
    input: SocratesAgentTurnInput,
    messages: ModelMessage[],
    context: { preflightSummary?: string; toolSummary: string; assistantDraft: string },
  ): Promise<MemoryLoopRunResult> {
    if (!canRunMemoryLoop(this.provider, input, this.toolRegistry)) {
      return emptyMemoryLoopRunResult()
    }

    try {
      const route = await this.memoryRouterAgent.routePostTurn({
        ...memoryRouterBaseInput(input, messages),
        ...(context.preflightSummary ? { preflightSummary: context.preflightSummary } : {}),
        toolSummary: context.toolSummary,
        assistantDraft: context.assistantDraft,
      })
      const summary = summarizeMemoryLoop("post_evidence", route, [], [])
      return {
        events: [],
        summary,
        records: [],
        ...(route.actions.length > 0
          ? {
              developerMessage: [
                '<socrates_memory_reconciliation phase="finalization">',
                "Before giving the final answer, reconcile these exact .socrates sections. The router only planned the work; you own every read and mutation.",
                `actions: ${JSON.stringify(route.actions)}`,
                "For each action: read the current section, apply the smallest exact patch using project_docs or repo_docs, then re-read the affected section and verify the stale claim is gone and the replacement is present. Replace/archive contradictions; do not append a competing claim. Include capability, verified_runtime, and verified_at anchors when supplied. If current evidence disproves an action, do not write it and state why in the final answer.",
                "After verification, give the user the final answer.",
                "</socrates_memory_reconciliation>",
              ].join("\n"),
            }
          : {}),
        reconciliationActions: route.actions,
      }
    } catch (error) {
      const normalized = normalizeError(error)
      const details = normalized.details === undefined ? "" : ` Details: ${clipText(previewMemoryLoopOutput(normalized.details), 4_000)}`
      return memoryLoopWarning("post_evidence", `${normalized.code}: ${normalized.message}${details}`)
    }
  }

  private async executeMemoryLoopTool(
    input: SocratesAgentTurnInput,
    docsLedger: TurnDocsLedger,
    request: { toolName: ToolName; input: unknown },
  ): Promise<MemoryLoopToolRecord> {
    if (!input.toolExecutors || !input.workspacePath || !input.requestApproval) {
      const error = new SocratesError("memory_loop_tool_context_unavailable", "Memory loop tool execution requires tools, workspacePath, and approval handler.", {
        recoverable: true,
      })
      const toolCallId = createId("tcall")
      return {
        toolName: request.toolName,
        input: request.input,
        events: [],
        result: toolErrorResult({ toolCallId, toolName: request.toolName, input: request.input }, error),
      }
    }

    const queue = new AsyncEventQueue<ToolLifecycleEvent>()
    const toolCall: NormalizedToolCall = {
      toolCallId: createId("tcall"),
      toolName: request.toolName,
      input: request.input,
    }
    const done = this.executeOneToolCall(
      toolCall,
      {
        projectId: input.projectId ?? "",
        conversationId: input.conversationId ?? "",
        sessionId: input.sessionId ?? "",
        turnId: input.turnId ?? "",
        workspacePath: input.workspacePath,
        runtimeConfig: input.runtimeConfig,
        executors: input.toolExecutors,
        requestApproval: input.requestApproval,
        ...(input.fileFreshness ? { fileFreshness: input.fileFreshness } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      },
      queue,
      new Map(),
      docsLedger,
    ).finally(() => queue.close())
    const events: ToolLifecycleEvent[] = []
    for await (const event of queue) {
      events.push(event)
    }
    const result = await done
    return { toolName: request.toolName, input: request.input, events, result }
  }

  private async executeOneToolCall(
    toolCall: NormalizedToolCall,
    context: ToolRuntimeContext,
    queue: AsyncEventQueue<ToolLifecycleEvent>,
    duplicateTraceRetrieveResults: Map<string, unknown>,
    docsLedger: TurnDocsLedger,
  ): Promise<ToolExecutionResult> {
    const startedAt = Date.now()
    const tool = this.toolRegistry.get(toolCall.toolName)
    if (!tool) {
      if (isDynamicMcpToolName(toolCall.toolName) && context.executors.mcp_dynamic) {
        return this.executeDynamicMcpToolCall(toolCall, context, queue, startedAt)
      }
      const error = new SocratesError("tool_not_found", "Tool is not registered", { details: { toolName: toolCall.toolName } })
      queue.push({
        type: "tool.call.failed",
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: toolCall.toolName,
        error,
        modelCallId: context.modelCallId,
        stepIndex: context.stepIndex,
      })
      return toolErrorResult(toolCall, error)
    }

    const parsed = tool.inputSchema.safeParse(toolCall.input)
    if (!parsed.success) {
      const error = new SocratesError("invalid_tool_input", "Tool input did not match the schema", {
        details: parsed.error.flatten(),
      })
      queue.push({
        type: "tool.call.failed",
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: toolCall.toolName,
        error,
        modelCallId: context.modelCallId,
        stepIndex: context.stepIndex,
      })
      return toolErrorResult(toolCall, error)
    }

    if (requiresActionDocsPreflight(tool.name) && !docsLedger.hasActionPreflight()) {
      const error = docsPreflightError(tool.name, docsLedger.missingActionPreflight())
      queue.push({
        type: "tool.call.failed",
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: tool.name,
        error,
        modelCallId: context.modelCallId,
        stepIndex: context.stepIndex,
      })
      return toolErrorResult(toolCall, error)
    }

    const duplicateTraceRetrieveKey = tool.name === "trace_retrieve" ? stableToolInputKey(tool.name, parsed.data) : undefined
    if (duplicateTraceRetrieveKey) {
      const duplicateOutput = duplicateTraceRetrieveResults.get(duplicateTraceRetrieveKey)
      if (duplicateOutput !== undefined) {
        const output = addDuplicateTraceRetrieveWarning(duplicateOutput)
        const parsedOutput = tool.resultSchema.parse(output)
        queue.push({
          type: "tool.call.started",
          toolCallId: toolCall.toolCallId,
          providerToolCallId: toolCall.providerToolCallId,
          toolName: tool.name,
          category: tool.category,
          displayName: tool.name,
          argsPreview: previewJson(parsed.data),
          input: parsed.data,
          requiresApproval: false,
          modelCallId: context.modelCallId,
          stepIndex: context.stepIndex,
        })
        queue.push({
          type: "tool.call.completed",
          toolCallId: toolCall.toolCallId,
          providerToolCallId: toolCall.providerToolCallId,
          toolName: tool.name,
          output: parsedOutput,
          summary: tool.summary(parsedOutput),
          resultPreview: tool.resultPreview(parsedOutput),
          ...(tool.metrics ? { metrics: tool.metrics(parsedOutput) } : {}),
          durationMs: Date.now() - startedAt,
          modelCallId: context.modelCallId,
          stepIndex: context.stepIndex,
        })
        return {
          toolCallId: toolCall.toolCallId,
          providerToolCallId: toolCall.providerToolCallId,
          toolName: tool.name,
          ok: true,
          output: parsedOutput,
        }
      }
    }

    try {
      const policy = await tool.decidePolicy(parsed.data, context)
      queue.push({
        type: "tool.call.started",
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: tool.name,
        category: tool.category,
        displayName: tool.name,
        argsPreview: previewJson(parsed.data),
        input: parsed.data,
        requiresApproval: policy.type === "approval_required",
        modelCallId: context.modelCallId,
        stepIndex: context.stepIndex,
      })

      if (policy.type === "denied") {
        throw new SocratesError(policy.code ?? "tool_denied", policy.reason, {
          ...(policy.details !== undefined ? { details: policy.details } : {}),
          ...(policy.recoverable !== undefined ? { recoverable: policy.recoverable } : {}),
        })
      }

      if (requiresDocsPreflightAfterPolicy(tool, policy) && !docsLedger.hasActionPreflight()) {
        throw docsPreflightError(tool.name, docsLedger.missingActionPreflight())
      }

      if (policy.type === "approval_required") {
        const approvalId = createId("appr")
        const request: ApprovalRequest = {
          approvalId,
          toolCallId: toolCall.toolCallId,
          providerToolCallId: toolCall.providerToolCallId,
          toolName: tool.name,
          ...policy.request,
        }
        queue.push({ type: "approval.requested", request })
        const decision = await context.requestApproval(request)
        queue.push({
          type: "approval.resolved",
          approvalId,
          toolCallId: toolCall.toolCallId,
          providerToolCallId: toolCall.providerToolCallId,
          decision: decision.decision,
        })
        if (decision.decision !== "approved") {
          throw new SocratesError("tool_approval_rejected", decision.reason ?? "The user rejected this tool call.")
        }
      }

      const output = await tool.execute(parsed.data, {
        ...context,
        toolCallId: toolCall.toolCallId,
        onOutput: (output) =>
          queue.push({
            type: "tool.call.output",
            toolCallId: toolCall.toolCallId,
            providerToolCallId: toolCall.providerToolCallId,
            modelCallId: context.modelCallId,
            stepIndex: context.stepIndex,
            ...output,
          }),
      })
      const parsedOutput = tool.resultSchema.safeParse(output)
      if (!parsedOutput.success) {
        throw new SocratesError("invalid_tool_output", "Tool output did not match the schema", {
          details: parsedOutput.error.flatten(),
        })
      }
      if (duplicateTraceRetrieveKey) {
        duplicateTraceRetrieveResults.set(duplicateTraceRetrieveKey, parsedOutput.data)
      }
      docsLedger.recordImmediatePreflight({
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: tool.name,
        ok: true,
        output: parsedOutput.data,
      }, toolCall)
      queue.push({
        type: "tool.call.completed",
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: tool.name,
        output: parsedOutput.data,
        summary: tool.summary(parsedOutput.data),
        resultPreview: tool.resultPreview(parsedOutput.data),
        ...(tool.metrics ? { metrics: tool.metrics(parsedOutput.data) } : {}),
        durationMs: Date.now() - startedAt,
        modelCallId: context.modelCallId,
        stepIndex: context.stepIndex,
      })
      return {
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: tool.name,
        ok: true,
        output: parsedOutput.data,
      }
    } catch (error) {
      const normalized = normalizeError(error)
      queue.push({
        type: "tool.call.failed",
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: tool.name,
        error: normalized,
        modelCallId: context.modelCallId,
        stepIndex: context.stepIndex,
      })
      return toolErrorResult(toolCall, normalized)
    }
  }

  private async executeDynamicMcpToolCall(
    toolCall: NormalizedToolCall,
    context: ToolRuntimeContext,
    queue: AsyncEventQueue<ToolLifecycleEvent>,
    startedAt: number,
  ): Promise<ToolExecutionResult> {
    try {
      queue.push({
        type: "tool.call.started",
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: toolCall.toolName,
        category: "mcp",
        displayName: toolCall.toolName,
        argsPreview: previewJson(toolCall.input),
        input: toolCall.input,
        requiresApproval: false,
        modelCallId: context.modelCallId,
        stepIndex: context.stepIndex,
      })
      const output = await context.executors.mcp_dynamic?.(
        { dynamicName: toolCall.toolName, input: toolCall.input },
        {
          ...context,
          toolCallId: toolCall.toolCallId,
          onOutput: (output) =>
            queue.push({
              type: "tool.call.output",
              toolCallId: toolCall.toolCallId,
              providerToolCallId: toolCall.providerToolCallId,
              modelCallId: context.modelCallId,
              stepIndex: context.stepIndex,
              ...output,
            }),
        },
      )
      queue.push({
        type: "tool.call.completed",
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: toolCall.toolName,
        output,
        summary: `${toolCall.toolName} completed.`,
        resultPreview: output === undefined ? "" : previewJson(output),
        durationMs: Date.now() - startedAt,
        modelCallId: context.modelCallId,
        stepIndex: context.stepIndex,
      })
      return { toolCallId: toolCall.toolCallId, providerToolCallId: toolCall.providerToolCallId, toolName: toolCall.toolName, ok: true, output }
    } catch (error) {
      const normalized = normalizeError(error)
      queue.push({
        type: "tool.call.failed",
        toolCallId: toolCall.toolCallId,
        providerToolCallId: toolCall.providerToolCallId,
        toolName: toolCall.toolName,
        error: normalized,
        modelCallId: context.modelCallId,
        stepIndex: context.stepIndex,
      })
      return toolErrorResult(toolCall, normalized)
    }
  }
}

type MemoryLoopRunResult = {
  events: ToolLifecycleEvent[]
  summary?: string
  records?: MemoryLoopToolRecord[]
  stableCachePreludeMessage?: string
  developerMessage?: string
  reconciliationActions?: MemoryReconciliationAction[]
}

type MemoryLoopToolRecord = {
  toolName: ToolName
  input: unknown
  events: ToolLifecycleEvent[]
  result: ToolExecutionResult
}

const emptyMemoryLoopRunResult = (): MemoryLoopRunResult => ({ events: [] })

const insertStableCachePrelude = (messages: ModelMessage[], content: string): void => {
  const firstNonSystemIndex = messages.findIndex((message) => message.role !== "system")
  messages.splice(firstNonSystemIndex === -1 ? messages.length : firstNonSystemIndex, 0, {
    role: "developer",
    content,
  })
}

const insertDynamicPromptContext = (messages: ModelMessage[], context?: SocratesPromptContext): void => {
  const content = buildSocratesDynamicContext(context)
  if (!content) return
  const stableIndex = messages.findIndex(
    (message) => message.role === "developer" && typeof message.content === "string" && message.content.includes("<socrates_stable_cache_prelude>"),
  )
  const firstNonSystemIndex = messages.findIndex((message) => message.role !== "system")
  const insertIndex = stableIndex >= 0 ? stableIndex + 1 : firstNonSystemIndex === -1 ? messages.length : firstNonSystemIndex
  messages.splice(insertIndex, 0, { role: "developer", content })
}

const canRunMemoryLoop = (provider: ModelProvider, input: SocratesAgentTurnInput, toolRegistry: ToolRegistry): boolean =>
  typeof provider.generateStructured === "function" &&
  Boolean(toolRegistry.get("memory_note")) &&
  Boolean(input.toolExecutors && input.workspacePath && input.requestApproval && input.projectId && input.conversationId && input.sessionId && input.turnId)

const canLoadStableCachePrelude = (input: SocratesAgentTurnInput, toolRegistry: ToolRegistry): boolean =>
  Boolean(
    input.toolExecutors &&
      input.workspacePath &&
      input.requestApproval &&
      input.projectId &&
      input.conversationId &&
      input.sessionId &&
      input.turnId &&
      toolRegistry.get("project_docs") &&
      toolRegistry.get("user_profile") &&
      toolRegistry.get("soul"),
  )

const memoryRouterModelSettingsFor = (input: SocratesAgentTurnInput): MemoryRouterModelSettings =>
  input.memoryRouterModelSettings ?? {
    providerId: input.providerId,
    authMode: input.runtimeConfig.authMode ?? "api_key",
    modelId: input.modelId,
    thinkingEnabled: false,
    thinkingEffort: "none",
  }

const memoryRouterBaseInput = (input: SocratesAgentTurnInput, messages: ModelMessage[]) => {
  if (!input.projectId || !input.conversationId || !input.sessionId || !input.turnId || !input.workspacePath || !input.toolExecutors) {
    throw new SocratesError("memory_router_context_unavailable", "Memory Router requires complete active-turn context.", { recoverable: true })
  }
  return {
    modelSettings: memoryRouterModelSettingsFor(input),
    projectId: input.projectId,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    workspacePath: input.workspacePath,
    ...(input.promptContext?.projectName ? { projectName: input.promptContext.projectName } : {}),
    ...(input.promptContext?.projectDescription ? { projectDescription: input.promptContext.projectDescription } : {}),
    userMessage: latestUserText(messages),
    recentMessages: messages,
    toolExecutors: input.toolExecutors,
    ...(input.automaticMemorySearch ? { automaticMemorySearch: input.automaticMemorySearch } : {}),
    ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.recordMemoryRouterUsage ? { recordUsage: input.recordMemoryRouterUsage } : {}),
  }
}

const stablePreludeRecallRequests = (): Array<{ toolName: ToolName; input: unknown }> => [
  { toolName: "project_docs", input: { operation: "read_section", area: "memory", sectionId: "always_apply_rules", charLimit: 10_000 } },
  { toolName: "user_profile", input: { operation: "read_section", sectionId: "global_always_apply_rules", charLimit: 10_000 } },
  { toolName: "soul", input: { operation: "read_section", sectionId: "core_identity", charLimit: 4_000 } },
  { toolName: "soul", input: { operation: "read_section", sectionId: "voice_and_presence", charLimit: 4_000 } },
  { toolName: "soul", input: { operation: "read_section", sectionId: "relationship_to_user", charLimit: 4_000 } },
]

const routedPreTurnRecallRequests = (route: MemoryRouterPreTurnResult): Array<{ toolName: ToolName; input: unknown }> => {
  const requests: Array<{ toolName: ToolName; input: unknown }> = []
  const seen = new Set<string>()
  const stableTargets = new Set([
    "project_memory:always_apply_rules",
    "user_profile:global_always_apply_rules",
    "identity:core_identity",
    "identity:voice_and_presence",
    "identity:relationship_to_user",
  ])
  const push = (request: { toolName: ToolName; input: unknown }) => {
    const key = `${request.toolName}:${JSON.stringify(request.input)}`
    if (!seen.has(key)) {
      seen.add(key)
      requests.push(request)
    }
  }
  for (const target of route.readTargets) {
    if (stableTargets.has(`${target.surface}:${target.sectionId}`)) {
      continue
    }
    if (target.surface === "project_notes") {
      push({ toolName: "project_docs", input: { operation: "read_section", area: "notes", sectionId: target.sectionId, charLimit: 20_000 } })
    } else if (target.surface === "project_memory") {
      push({ toolName: "project_docs", input: { operation: "read_section", area: "memory", sectionId: target.sectionId, charLimit: 20_000 } })
    } else if (target.surface === "repo_docs") {
      push({ toolName: "repo_docs", input: { operation: "read_section", path: target.fileName, sectionId: target.sectionId, charLimit: 20_000 } })
    } else if (target.surface === "user_profile") {
      push({ toolName: "user_profile", input: { operation: "read_section", sectionId: target.sectionId, charLimit: 20_000 } })
    } else if (target.surface === "identity") {
      push({ toolName: "soul", input: { operation: "read_section", sectionId: target.sectionId, charLimit: 20_000 } })
    }
  }
  return requests
}

const latestUserText = (messages: ModelMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "user") {
      continue
    }
    if (typeof message.content === "string") {
      return message.content
    }
    return message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n")
  }
  return ""
}

const memoryLoopSectionContent = (output: unknown): string | undefined => {
  const record = output && typeof output === "object" && !Array.isArray(output) ? (output as Record<string, unknown>) : undefined
  const section = record?.section && typeof record.section === "object" && !Array.isArray(record.section) ? (record.section as Record<string, unknown>) : undefined
  return typeof section?.content === "string" ? section.content : typeof record?.content === "string" ? record.content : undefined
}

const cleanMemoryLoopText = (text: string): string => text.trim().replace(/^[-*]\s+/, "").trim()

const isAlwaysApplyPlaceholderText = (text: string): boolean => {
  const normalized = cleanMemoryLoopText(text).toLowerCase()
  return normalized.startsWith("add at most 10") && (normalized.includes("hard") || normalized.includes("rule"))
}

const summarizeMemoryLoop = (
  phase: MemoryLoopPhase,
  route: MemoryRouterPreTurnResult | MemoryRouterPostTurnResult,
  records: MemoryLoopToolRecord[],
  skipped: string[],
): string => {
  const routeSummary = "readTargets" in route ? `readTargets=${route.readTargets.length}` : `actions=${route.actions.length}`
  const actions = records.map((record) => `${record.toolName}:${record.result.ok ? "ok" : record.result.error?.code ?? "failed"}`)
  return [`${phase}: ${routeSummary}`, `reason: ${route.reason}`, actions.length ? `actions: ${actions.join(", ")}` : "actions: none", ...skipped].join("\n")
}

const renderMemoryLoopDeveloperMessage = (
  phase: MemoryLoopPhase,
  route: MemoryRouterPreTurnResult | MemoryRouterPostTurnResult,
  records: MemoryLoopToolRecord[],
  skipped: string[],
  options: { stableCachePreludeApplied?: boolean } = {},
): string =>
  [
    `<socrates_memory_loop phase="${phase}">`,
    "Structured memory route was executed by the runtime before the next user-visible answer.",
    `route: ${JSON.stringify(route)}`,
    options.stableCachePreludeApplied
      ? "stable_cache_prelude: global/project always-apply rule reads were placed before conversation history for provider prompt-cache locality."
      : undefined,
    skipped.length ? `skipped: ${skipped.join("; ")}` : undefined,
    records.length > 0 ? "tool_results:" : "tool_results: none",
    ...records.map((record, index) =>
      [
        `- ${index + 1}. ${record.toolName} ${record.result.ok ? "ok" : `failed:${record.result.error?.code ?? "unknown"}`}`,
        `  input: ${clipText(JSON.stringify(record.input), 800)}`,
        `  output: ${clipText(previewMemoryLoopOutput(record.result.output), 4_000)}`,
      ].join("\n"),
    ),
    "Use these results as current context. Mention saved memory/docs actions in the answer when relevant; do not repeat the same save unless new information materially changes it.",
    "</socrates_memory_loop>",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n")

const renderStableCachePrelude = (records: MemoryLoopToolRecord[]): string | undefined => {
  let projectRules: string | undefined
  let globalRules: string | undefined
  const identitySections = new Map<string, string>()

  for (const record of records) {
    if (!record.result.ok || !isStableCachePreludeRecord(record)) {
      continue
    }
    const content = normalizeAlwaysApplyRules(memoryLoopSectionContent(record.result.output))
    if (isProjectAlwaysApplyRecord(record)) {
      projectRules = content
    } else if (isGlobalAlwaysApplyRecord(record)) {
      globalRules = content
    } else if (isStableIdentityRecord(record)) {
      const sectionId = objectRecord(record.input)?.sectionId
      if (typeof sectionId === "string") identitySections.set(sectionId, content)
    }
  }

  if (projectRules === undefined && globalRules === undefined && identitySections.size === 0) {
    return undefined
  }

  return renderStableCachePreludeParts({ projectRules, globalRules, identitySections })
}

const renderStableCachePreludeParts = ({
  projectRules,
  globalRules,
  identitySections,
}: {
  projectRules: string | undefined
  globalRules: string | undefined
  identitySections: Map<string, string>
}): string =>
  [
    "<socrates_stable_cache_prelude>",
    "Stable always-apply rules loaded by the runtime before conversation/user text. Treat them as standing instructions for this turn; do not quote these tags to the user.",
    "<identity_core>",
    ...["core_identity", "voice_and_presence", "relationship_to_user"].map(
      (sectionId) => `<${sectionId}>\n${identitySections.get(sectionId) ?? "- No identity content loaded."}\n</${sectionId}>`,
    ),
    "</identity_core>",
    "<global_always_apply_rules>",
    globalRules ?? "- No global always-apply rules loaded.",
    "</global_always_apply_rules>",
    "<project_always_apply_rules>",
    projectRules ?? "- No project always-apply rules loaded.",
    "</project_always_apply_rules>",
    renderSocratesSurfaceMap(),
    "</socrates_stable_cache_prelude>",
  ].join("\n")

const renderStableCachePreludeSnapshot = (snapshot: StableCachePreludeSnapshot): string =>
  renderStableCachePreludeParts({
    projectRules: normalizeAlwaysApplyRules(snapshot.projectRules),
    globalRules: normalizeAlwaysApplyRules(snapshot.globalRules),
    identitySections: new Map(
      Object.entries(snapshot.identitySections).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  })

const isStableCachePreludeRecord = (record: MemoryLoopToolRecord): boolean =>
  isProjectAlwaysApplyRecord(record) || isGlobalAlwaysApplyRecord(record) || isStableIdentityRecord(record)

const isStableIdentityRecord = (record: MemoryLoopToolRecord): boolean => {
  if (record.toolName !== "soul") return false
  const input = objectRecord(record.input)
  return input?.operation === "read_section" && ["core_identity", "voice_and_presence", "relationship_to_user"].includes(String(input.sectionId))
}

const isProjectAlwaysApplyRecord = (record: MemoryLoopToolRecord): boolean => {
  if (record.toolName !== "project_docs") {
    return false
  }
  const input = objectRecord(record.input)
  return (
    input?.area === "memory" &&
    input.sectionId === "always_apply_rules" &&
    (input.operation === "read_section" || input.operation === "patch_section")
  )
}

const isGlobalAlwaysApplyRecord = (record: MemoryLoopToolRecord): boolean => {
  if (record.toolName !== "user_profile") {
    return false
  }
  const input = objectRecord(record.input)
  return input?.operation === "read_section" && input.sectionId === "global_always_apply_rules"
}

const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const normalizeAlwaysApplyRules = (content: string | undefined): string => {
  const rules =
    content
      ?.split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .filter((line) => !isAlwaysApplyPlaceholderText(line)) ?? []
  return rules.length > 0 ? rules.join("\n") : "- No always-apply rules recorded."
}

const memoryLoopWarning = (phase: MemoryLoopPhase, warning: string): MemoryLoopRunResult => ({
  events: [],
  summary: `${phase}: memory loop warning: ${warning}`,
  developerMessage: `<socrates_memory_loop phase="${phase}" status="warning">\n${warning}\nContinue normally, but do not claim memory was saved by the structured loop.\n</socrates_memory_loop>`,
})

const previewMemoryLoopOutput = (output: unknown): string => {
  if (output === undefined) {
    return ""
  }
  if (typeof output === "string") {
    return output
  }
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

const clipText = (text: string | undefined, limit: number): string => {
  const value = text ?? ""
  return value.length > limit ? `${value.slice(0, limit)}...` : value
}

const nativeFollowUpMessagesForToolResult = (result: ToolExecutionResult, workspacePath: string | undefined): ModelMessage[] => {
  if (!workspacePath || !result.ok || result.toolName !== "read") {
    return []
  }
  const output = result.output
  if (!isReadImageOutput(output) || output.image.nativeVisionSupported !== true || !output.mimeType) {
    return []
  }
  const imageBytes = readWorkspaceImageForModel(workspacePath, output.path)
  if (!imageBytes) {
    return []
  }
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Native image content returned by read for ${output.path}. Use this image together with the read tool metadata.`,
        },
        { type: "image", mediaType: output.mimeType, data: imageBytes, fileName: path.basename(output.path) },
      ],
    },
  ]
}

const isReadImageOutput = (value: unknown): value is {
  path: string
  kind: "image"
  mimeType?: string
  image: { nativeVisionSupported: boolean }
} =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "image" &&
  typeof (value as { path?: unknown }).path === "string" &&
  typeof (value as { image?: { nativeVisionSupported?: unknown } }).image?.nativeVisionSupported === "boolean"

const readWorkspaceImageForModel = (workspacePath: string, relativePath: string): string | undefined => {
  const workspaceRoot = path.resolve(workspacePath)
  const absolutePath = path.resolve(workspaceRoot, relativePath)
  const relative = path.relative(workspaceRoot, absolutePath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined
  }
  try {
    return fs.readFileSync(absolutePath).toString("base64")
  } catch {
    return undefined
  }
}

const attachModelMetadata = (event: ModelEvent, modelCallId: string | undefined, stepIndex: number): ModelEvent => ({
  ...event,
  ...(modelCallId ? { modelCallId } : {}),
  stepIndex,
}) as ModelEvent

const isDynamicMcpToolName = (toolName: string): boolean => /^mcp__[a-z0-9_-]+__[a-zA-Z0-9_-]+$/.test(toolName)

const isConfirmedToolErrorResult = (result: ToolExecutionResult): boolean =>
  result.ok === false && typeof result.error?.code === "string" && result.error.code.length > 0 && typeof result.error.message === "string" && result.error.message.length > 0

const compactPriorToolHistoryForModel = (messages: ModelMessage[]): void => {
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      continue
    }
    for (const part of message.content) {
      if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "tool-result") {
        continue
      }
      const record = part as { output?: unknown; toolName?: unknown }
      record.output = compactModelVisibleToolOutput(record.output, typeof record.toolName === "string" ? record.toolName : undefined)
    }
  }
}

const compactModelVisibleToolOutput = (output: unknown, toolName: string | undefined): unknown => {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output
  }
  const record = output as Record<string, unknown>
  if (record.contextCompacted === true) {
    return output
  }
  if (record.ok === false) {
    const error = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? (record.error as Record<string, unknown>) : undefined
    return {
      toolName,
      ok: false,
      contextCompacted: true,
      message: `Earlier failed ${toolName ?? "tool"} result omitted for context cleanliness after 10+ tool calls.`,
      ...(typeof error?.code === "string" ? { code: error.code } : {}),
      ...(typeof error?.message === "string" ? { errorMessage: error.message } : {}),
    }
  }
  const serialized = safeJsonPreview(output, 4_001)
  if (serialized.length <= 4_000) {
    return output
  }
  return {
    toolName,
    ok: record.ok === true,
    contextCompacted: true,
    message:
      "Earlier large tool result compacted after 10+ tool calls. Re-read the file, rerun a targeted search, or use trace_retrieve audit/inspect if exact older evidence is needed.",
    preview: safeJsonPreview(output, 2_000),
  }
}

const safeJsonPreview = (value: unknown, limit: number): string => {
  let text: string
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

const DOCS_PREFLIGHT_CHECKPOINT = `<runtime_socrates_docs_preflight>
This turn has workspace tools. Read-only/chat work does not require project docs. Before any bash, edit, or apply_patch call, first call project_docs with area="notes" and call repo_docs in this same turn using read, search, read_index, or read_section. After any successful bash, edit, or apply_patch call, read/search project_docs area="memory" before final answer; update memory only if there is durable project value. The active state ledger lives in project notes and must be fetched with project_docs, not assumed from the prompt. Use tool_docs before unfamiliar, failed, complex, or edge-case tool use.
Before an ordered multi-step, verification/review, or closure/handoff workflow, call skills list before project_docs/repo_docs/domain tools and describe the best match; generic tool knowledge does not replace learned user gates.
</runtime_socrates_docs_preflight>`

const TOOL_DOCS_FAILURE_NUDGE = "Refer to tool_docs for tool usage before retrying this tool or choosing another tool."
const MUTATION_SCHEMA_RECOVERY_HINT =
  'Runtime tool-schema recovery: the previous edit/apply_patch input was invalid. For a new file, call edit with exactly { "path": "relative/path.md", "content": "..." }. For a full rewrite of an existing file, use exactly { "path": "relative/path.md", "content": "...", "overwrite": true }. For a targeted replacement, use exactly { "path": "relative/path.md", "oldString": "...", "newString": "..." }. Do not mix content with oldString/newString, and do not set overwrite unless it is true.'
const FAILED_MUTATION_FORCE_FINAL_THRESHOLD = 4
const DOCS_PREFLIGHT_MESSAGE =
  'Before bash, edit, or apply_patch, call project_docs with area="notes" and call repo_docs in this turn using read, search, read_index, or read_section. Then retry the action.'
const MEMORY_REVIEW_REQUIRED_MESSAGE =
  'After successful bash, edit, or apply_patch, read/search project_docs area="memory" before final answer. Update memory only if there is durable project value.'
const MEMORY_REVIEW_REQUIRED_CHECKPOINT = `<runtime_memory_review_required>
${MEMORY_REVIEW_REQUIRED_MESSAGE}
</runtime_memory_review_required>`

const toolErrorResult = (toolCall: NormalizedToolCall, error: SocratesError): ToolExecutionResult =>
  toolExecutionResultSchema.parse({
    toolCallId: toolCall.toolCallId,
    providerToolCallId: toolCall.providerToolCallId,
    toolName: toolCall.toolName,
    ok: false,
    error: {
      code: error.code,
      message: `${error.message}\n\n${TOOL_DOCS_FAILURE_NUDGE}`,
      details: error.details,
    },
  })

const docsPreflightError = (toolName: ToolName, missing: string[]): SocratesError =>
  new SocratesError("docs_preflight_required", DOCS_PREFLIGHT_MESSAGE, {
    recoverable: true,
    details: { toolName, missing },
  })

const memoryReviewRequiredError = (): SocratesError =>
  new SocratesError("memory_review_required", MEMORY_REVIEW_REQUIRED_MESSAGE, {
    recoverable: true,
  })

const interactiveTerminalAwaitingInput = (results: ToolExecutionResult[]): string | undefined => {
  for (const result of results) {
    if (!result.ok || result.toolName !== "bash" || !result.output || typeof result.output !== "object") {
      continue
    }
    const terminal = "terminal" in result.output ? result.output.terminal : undefined
    if (!terminal || typeof terminal !== "object") {
      continue
    }
    const name = "name" in terminal ? terminal.name : undefined
    const awaitingInput = "awaitingInput" in terminal ? terminal.awaitingInput : undefined
    if (awaitingInput === true && typeof name === "string" && name.trim()) {
      return name.trim()
    }
  }
  return undefined
}

const actionToolNames = new Set<ToolName>(["bash", "edit", "apply_patch"])

const requiresActionDocsPreflight = (toolName: ToolName): boolean => actionToolNames.has(toolName)

const requiresDocsPreflightAfterPolicy = (
  tool: { name: ToolName; executeLane: "parallel" | "mutation" },
  policy: ToolPolicyDecision,
): boolean =>
  policy.type === "approval_required" &&
  tool.executeLane === "mutation" &&
  tool.name !== "repo_docs" &&
  tool.name !== "project_docs" &&
  requiresActionDocsPreflight(tool.name)

type LedgerRecordBatchInput = {
  toolCalls: NormalizedToolCall[]
  results: ToolExecutionResult[]
  estimatedTokens: number
  currentTurnTokenGrowth: number
}

type DocsLedgerBatchInput = {
  toolCalls: NormalizedToolCall[]
  results: ToolExecutionResult[]
}

type MemorySaveLedgerBatchInput = {
  toolCalls: NormalizedToolCall[]
  results: ToolExecutionResult[]
}

class ReconciliationVerificationLedger {
  private readonly targets = new Map<string, { label: string; mutated: boolean; verified: boolean }>()

  require(actions: MemoryReconciliationAction[]): void {
    for (const action of actions) {
      const key = this.keyForAction(action)
      this.targets.set(key, { label: `${action.fileName}/${action.sectionId}`, mutated: false, verified: false })
    }
  }

  recordBatch(toolCalls: NormalizedToolCall[], results: ToolExecutionResult[]): void {
    const resultsById = new Map<string, ToolExecutionResult>()
    for (const result of results) {
      resultsById.set(result.toolCallId, result)
      if (result.providerToolCallId) resultsById.set(result.providerToolCallId, result)
    }
    for (const call of toolCalls) {
      const result = resultsById.get(call.toolCallId) ?? (call.providerToolCallId ? resultsById.get(call.providerToolCallId) : undefined)
      if (!result?.ok) continue
      const key = this.keyForCall(call)
      if (!key) continue
      const target = this.targets.get(key)
      if (!target) continue
      const operation = toolOperation(call)
      if (operation === "edit" || operation === "patch_section") {
        target.mutated = true
        target.verified = false
      } else if (target.mutated && isDocsReadOperation(operation)) {
        target.verified = true
      }
    }
  }

  hasPending(): boolean {
    return [...this.targets.values()].some((target) => !target.mutated || !target.verified)
  }

  pendingSummary(): string {
    return [...this.targets.values()]
      .filter((target) => !target.mutated || !target.verified)
      .map((target) => `${target.label} (${target.mutated ? "needs post-write read" : "needs mutation and post-write read"})`)
      .join(", ")
  }

  private keyForAction(action: MemoryReconciliationAction): string {
    const owner = action.surface === "repo_docs" ? `repo:${action.fileName}` : `project:${action.surface === "project_notes" ? "notes" : "memory"}`
    return `${owner}:${action.sectionId}`
  }

  private keyForCall(call: NormalizedToolCall): string | undefined {
    if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)) return undefined
    const input = call.input as Record<string, unknown>
    const sectionId = typeof input.sectionId === "string" ? input.sectionId : undefined
    if (!sectionId) return undefined
    if (call.toolName === "project_docs") {
      const area = input.area === "notes" ? "notes" : input.area === "memory" ? "memory" : undefined
      return area ? `project:${area}:${sectionId}` : undefined
    }
    if (call.toolName === "repo_docs" && typeof input.path === "string") return `repo:${input.path}:${sectionId}`
    return undefined
  }
}

class TurnDocsLedger {
  private totalToolCalls = 0
  private evidenceToolCalls = 0
  private failedToolCalls = 0
  private projectDocsRead = false
  private projectMemoryRead = false
  private projectNotesRead = false
  private projectDocsEdited = false
  private projectMemoryEdited = false
  private projectNotesEdited = false
  private repoDocsRead = false
  private repoDocsEdited = false
  private toolDocsRead = false
  private emptyProjectDocsRead = false
  private mutationSucceeded = false
  private bashSucceeded = false
  private readonly changedFiles = new Set<string>()
  private readonly commands: string[] = []

  hasActionPreflight(): boolean {
    return this.projectNotesRead && this.repoDocsRead
  }

  missingActionPreflight(): string[] {
    return [
      this.projectNotesRead ? undefined : "project_docs notes read/search",
      this.repoDocsRead ? undefined : "repo_docs read/search",
    ].filter((item): item is string => typeof item === "string")
  }

  requiresProjectMemoryReview(): boolean {
    return (this.mutationSucceeded || this.bashSucceeded) && !this.projectMemoryRead
  }

  recordImmediatePreflight(result: ToolExecutionResult, toolCall: NormalizedToolCall | undefined): void {
    if (!result.ok) {
      return
    }
    const operation = toolOperation(toolCall)
    if (result.toolName === "repo_docs" && isDocsReadOperation(operation)) {
      this.repoDocsRead = true
    }
    if (result.toolName === "project_docs" && isDocsReadOperation(operation)) {
      const area = toolArea(toolCall)
      if (area === "notes") {
        this.projectNotesRead = true
      }
      if (area === "memory") {
        this.projectMemoryRead = true
      }
    }
  }

  recordBatch(input: DocsLedgerBatchInput): void {
    const callsById = new Map<string, NormalizedToolCall>()
    for (const toolCall of input.toolCalls) {
      callsById.set(toolCall.toolCallId, toolCall)
      if (toolCall.providerToolCallId) {
        callsById.set(toolCall.providerToolCallId, toolCall)
      }
      this.totalToolCalls += 1
      if (toolCall.toolName === "read" || toolCall.toolName === "search" || toolCall.toolName === "trace_retrieve") {
        this.evidenceToolCalls += 1
      }
    }

    for (const result of input.results) {
      const toolCall = callsById.get(result.toolCallId) ?? (result.providerToolCallId ? callsById.get(result.providerToolCallId) : undefined)
      this.recordResult(result, toolCall)
    }
  }

  buildSyncCheckpoint(): string | undefined {
    if (this.projectMemoryRead && this.projectMemoryEdited) {
      return undefined
    }
    const actionWork = this.mutationSucceeded || this.bashSucceeded
    const broadInvestigation = this.evidenceToolCalls >= 5 || this.totalToolCalls >= 8 || this.failedToolCalls >= 2
    if (!actionWork && !broadInvestigation) {
      return undefined
    }

    const facts = [
      this.changedFiles.size > 0 ? `files changed: ${clipList([...this.changedFiles], 4, 160)}` : undefined,
      this.commands.length > 0 ? `commands: ${clipList(this.commands, 3, 180)}` : undefined,
      this.evidenceToolCalls > 0 ? `evidence tools: ${this.evidenceToolCalls}` : undefined,
      this.failedToolCalls > 0 ? `failed tools: ${this.failedToolCalls}` : undefined,
      this.emptyProjectDocsRead ? "project docs looked empty" : undefined,
      `docs read: notes=${this.projectNotesRead ? "yes" : "no"}, memory=${this.projectMemoryRead ? "yes" : "no"}, repo=${this.repoDocsRead ? "yes" : "no"}, tool=${this.toolDocsRead ? "yes" : "no"}`,
      `project_docs edits: memory=${this.projectMemoryEdited ? "yes" : "no"}, notes=${this.projectNotesEdited ? "yes" : "no"}`,
    ].filter((item): item is string => typeof item === "string")

    return `<runtime_docs_sync_checkpoint>
Before final answer, close the Socrates docs loop. This turn used workspace tools (${facts.join("; ")}). If bash/edit/apply_patch succeeded, read/search project_docs area="memory" before final answer. After reading memory, update it only if there is a durable outcome, decision, blocker, changed files/docs, or handoff fact. If active todos, checked files, next commands, partial progress, or restart context matter, update project_docs notes. If repo behavior, contracts, navigation, provider/tool behavior, or durable pitfalls changed, update repo_docs. If tools failed and tool_docs was not checked, call tool_docs before retrying or explaining.
</runtime_docs_sync_checkpoint>`
  }

  private recordResult(result: ToolExecutionResult, toolCall: NormalizedToolCall | undefined): void {
    if (!result.ok) {
      this.failedToolCalls += 1
      return
    }
    if (result.toolName === "project_docs") {
      if (toolOperation(toolCall) === "edit") {
        this.projectDocsEdited = true
        const area = toolArea(toolCall)
        if (area === "memory") {
          this.projectMemoryEdited = true
        }
        if (area === "notes") {
          this.projectNotesEdited = true
        }
      } else {
        this.projectDocsRead = true
        const area = toolArea(toolCall)
        if (area === "memory") {
          this.projectMemoryRead = true
        }
        if (area === "notes") {
          this.projectNotesRead = true
        }
        this.emptyProjectDocsRead ||= outputContentIsEmpty(result.output)
      }
      return
    }
    if (result.toolName === "repo_docs") {
      if (toolOperation(toolCall) === "edit") {
        this.repoDocsEdited = true
      } else {
        this.repoDocsRead = true
      }
      return
    }
    if (result.toolName === "tool_docs") {
      this.toolDocsRead = true
      return
    }
    if (result.toolName === "bash") {
      this.bashSucceeded = true
      const command = commandFor(toolCall, result.output)
      if (command) {
        this.commands.push(command)
        if (this.commands.length > 6) {
          this.commands.splice(0, this.commands.length - 6)
        }
      }
      return
    }
    if (result.toolName === "edit" || result.toolName === "apply_patch") {
      const output = result.output && typeof result.output === "object" && !Array.isArray(result.output) ? result.output as Record<string, unknown> : {}
      if (output.dryRun === true) {
        return
      }
      const changedFiles = Array.isArray(output.changedFiles) ? output.changedFiles : []
      if (changedFiles.length > 0) {
        this.mutationSucceeded = true
      }
      for (const file of changedFiles) {
        const filePath = file && typeof file === "object" && "path" in file ? (file as { path?: unknown }).path : undefined
        if (typeof filePath === "string" && filePath.trim()) {
          this.changedFiles.add(normalizePathKey(filePath))
        }
      }
    }
  }
}

class TurnMemorySaveLedger {
  private readonly entries: string[] = []
  private readonly seen = new Set<string>()
  private renderedEntryCount = 0

  recordBatch(input: MemorySaveLedgerBatchInput): void {
    const callsById = new Map<string, NormalizedToolCall>()
    for (const toolCall of input.toolCalls) {
      callsById.set(toolCall.toolCallId, toolCall)
      if (toolCall.providerToolCallId) {
        callsById.set(toolCall.providerToolCallId, toolCall)
      }
    }
    for (const result of input.results) {
      const toolCall = callsById.get(result.toolCallId) ?? (result.providerToolCallId ? callsById.get(result.providerToolCallId) : undefined)
      this.recordResult(result, toolCall?.input)
    }
  }

  recordMemoryLoopRecords(records: MemoryLoopToolRecord[]): void {
    for (const record of records) {
      this.recordResult(record.result, record.input)
    }
  }

  flushDeveloperMessage(): string | undefined {
    if (this.entries.length === this.renderedEntryCount) {
      return undefined
    }
    this.renderedEntryCount = this.entries.length
    return [
      "<socrates_memory_save_ledger>",
      "Memory notes already submitted in this user turn:",
      ...this.entries.map((entry) => `- ${entry}`),
      "Rules: prefer no further memory_note calls unless a new candidate is materially different. The backend hard-caps distinct created notes at two per user turn, and normalized repeats return already_recorded.",
      "</socrates_memory_save_ledger>",
    ].join("\n")
  }

  private recordResult(result: ToolExecutionResult, input: unknown): void {
    if (result.toolName !== "memory_note") {
      return
    }
    const key = `${result.toolCallId}:${result.ok ? "ok" : "failed"}`
    if (this.seen.has(key)) {
      return
    }
    this.seen.add(key)
    if (!result.ok) {
      this.pushEntry(`failed ${result.error?.code ?? "error"}${result.error?.message ? `: ${clipInline(result.error.message, 180)}` : ""}${memoryNoteInputPreview(input)}`)
      return
    }
    const output = result.output && typeof result.output === "object" && !Array.isArray(result.output) ? result.output as Record<string, unknown> : {}
    const noteNumber = typeof output.noteNumber === "number" ? output.noteNumber : undefined
    const status = typeof output.status === "string" ? output.status : "open"
    const saveResult = output.result === "already_recorded" ? "already_recorded" : "created"
    this.pushEntry(`${noteNumber ? `#${noteNumber}` : "note"} ${saveResult} status=${status}${memoryNoteInputPreview(input)}`)
  }

  private pushEntry(entry: string): void {
    this.entries.push(entry)
    if (this.entries.length > 6) {
      this.entries.splice(0, this.entries.length - 6)
    }
  }
}

const toolOperation = (toolCall: NormalizedToolCall | undefined): string | undefined => {
  const input = toolCall?.input && typeof toolCall.input === "object" && !Array.isArray(toolCall.input) ? toolCall.input as Record<string, unknown> : undefined
  return typeof input?.operation === "string" ? input.operation : undefined
}

const isDocsReadOperation = (operation: string | undefined): boolean =>
  operation === undefined || operation === "read" || operation === "search" || operation === "read_index" || operation === "read_section"

const toolArea = (toolCall: NormalizedToolCall | undefined): string | undefined => {
  const input = toolCall?.input && typeof toolCall.input === "object" && !Array.isArray(toolCall.input) ? toolCall.input as Record<string, unknown> : undefined
  return typeof input?.area === "string" ? input.area : undefined
}

const outputContentIsEmpty = (output: unknown): boolean => {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false
  }
  const content = (output as Record<string, unknown>).content
  return typeof content === "string" && content.trim().length === 0
}

const commandFor = (toolCall: NormalizedToolCall | undefined, output: unknown): string | undefined => {
  const input = toolCall?.input && typeof toolCall.input === "object" && !Array.isArray(toolCall.input) ? toolCall.input as Record<string, unknown> : undefined
  if (typeof input?.command === "string" && input.command.trim()) {
    return clipInline(input.command, 120)
  }
  const record = output && typeof output === "object" && !Array.isArray(output) ? output as Record<string, unknown> : undefined
  return typeof record?.command === "string" && record.command.trim() ? clipInline(record.command, 120) : undefined
}

const memoryNoteInputPreview = (input: unknown): string => {
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
  return typeof record?.note === "string" && record.note.trim() ? `: ${clipInline(record.note, 180)}` : ""
}

const clipList = (values: string[], limit: number, charLimit: number): string => {
  const clipped = values.slice(0, limit).map((value) => clipInline(value, Math.max(12, Math.floor(charLimit / Math.max(1, limit)))))
  const suffix = values.length > limit ? `, +${values.length - limit} more` : ""
  return `${clipped.join(", ")}${suffix}`
}

const clipInline = (value: string, limit: number): string => {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 3))}...` : compact
}

class TurnActionLedger {
  private readonly exactInputCounts = new Map<string, number>()
  private readonly targetCounts = new Map<string, number>()
  private readonly failedMutationCounts = new Map<string, number>()
  private readonly warnedTargets = new Set<string>()
  private readonly entries: string[] = []
  private forceFinalReason: string | undefined

  recordBatch(input: LedgerRecordBatchInput): { summary: string; warnings: string[]; forceFinalReason?: string } {
    const callsById = new Map<string, NormalizedToolCall>()
    for (const toolCall of input.toolCalls) {
      callsById.set(toolCall.toolCallId, toolCall)
      if (toolCall.providerToolCallId) {
        callsById.set(toolCall.providerToolCallId, toolCall)
      }
      const exactKey = stableToolInputKey(toolCall.toolName, toolCall.input)
      const exactCount = (this.exactInputCounts.get(exactKey) ?? 0) + 1
      this.exactInputCounts.set(exactKey, exactCount)
      if (exactCount >= 4) {
        this.forceFinalReason ??= `same exact ${toolCall.toolName} input was requested ${exactCount} times in this turn.`
      }
      const targetKey = normalizedToolTargetKey(toolCall)
      if (targetKey) {
        const targetCount = (this.targetCounts.get(targetKey) ?? 0) + 1
        this.targetCounts.set(targetKey, targetCount)
        if (targetCount >= 4) {
          this.forceFinalReason ??= `same normalized tool target was repeated ${targetCount} times (${targetKey}).`
        }
      }
    }

    const warnings: string[] = []
    for (const result of input.results) {
      const toolCall = callsById.get(result.toolCallId) ?? (result.providerToolCallId ? callsById.get(result.providerToolCallId) : undefined)
      this.pushEntry(`${result.ok ? "ok" : "failed"} ${result.toolName}${toolCall ? ` ${toolCallTargetPreview(toolCall)}` : ""}`)
      const targetKey = toolCall ? normalizedToolTargetKey(toolCall) : undefined
      const targetCount = targetKey ? (this.targetCounts.get(targetKey) ?? 0) : 0
      if (targetKey && targetCount >= 2 && !this.warnedTargets.has(targetKey)) {
        this.warnedTargets.add(targetKey)
        warnings.push(`Runtime action ledger: ${targetKey} has already been inspected or attempted ${targetCount} times this turn. Use the evidence already gathered, inspect a different target, or answer with the remaining uncertainty.`)
      }
      if (!result.ok && toolCall && (toolCall.toolName === "edit" || toolCall.toolName === "apply_patch")) {
        const failedKey = `${toolCall.toolName}:${mutationTargetFor(toolCall)}:${result.error?.code ?? "error"}`
        const failedCount = (this.failedMutationCounts.get(failedKey) ?? 0) + 1
        this.failedMutationCounts.set(failedKey, failedCount)
        if (result.error?.code === "invalid_tool_input" && failedCount < FAILED_MUTATION_FORCE_FINAL_THRESHOLD) {
          warnings.push(MUTATION_SCHEMA_RECOVERY_HINT)
        } else if (failedCount >= FAILED_MUTATION_FORCE_FINAL_THRESHOLD) {
          this.forceFinalReason ??= `${toolCall.toolName} failed ${failedCount} times for ${mutationTargetFor(toolCall)} with ${result.error?.code ?? "an error"}.`
        }
      }
    }

    return {
      summary: this.summary(input),
      warnings,
      ...(this.forceFinalReason ? { forceFinalReason: this.forceFinalReason } : {}),
    }
  }

  private pushEntry(entry: string): void {
    this.entries.push(entry)
    if (this.entries.length > 12) {
      this.entries.splice(0, this.entries.length - 12)
    }
  }

  private summary(input: LedgerRecordBatchInput): string {
    return [
      "Runtime action ledger for this turn:",
      `- Current request estimate: ${input.estimatedTokens} tokens; current-turn growth: ${input.currentTurnTokenGrowth} tokens.`,
      `- Recent actions: ${this.entries.length > 0 ? this.entries.join("; ") : "none"}.`,
      "- Do not repeat the same target unless the previous result was insufficient for a specific reason. Prefer answering from gathered evidence once enough is known.",
    ].join("\n")
  }
}

const sanitizeToolExecutionResultForModel = (result: ToolExecutionResult, modelToolCallId: string): ToolExecutionResult => {
  if (result.ok) {
    return toolExecutionResultSchema.parse({
      toolCallId: modelToolCallId,
      toolName: result.toolName,
      ok: true,
      output: sanitizeModelVisibleValue(result.output, { preserveTraceRetrieveIds: result.toolName === "trace_retrieve" }),
    })
  }
  return toolExecutionResultSchema.parse({
    toolCallId: modelToolCallId,
    toolName: result.toolName,
    ok: false,
    error: result.error
      ? {
          code: result.error.code,
          message: result.error.message,
          ...(result.error.details === undefined ? {} : { details: sanitizeModelVisibleValue(result.error.details) }),
        }
      : undefined,
  })
}

const sanitizeModelVisibleValue = (value: unknown, options: { preserveTraceRetrieveIds?: boolean } = {}): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeModelVisibleValue(item, options))
  }
  if (!value || typeof value !== "object") {
    return value
  }
  const record = value as Record<string, unknown>
  const sanitized: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (isRuntimeOwnedModelKey(key, options)) {
      continue
    }
    if (key === "source" && child && typeof child === "object" && "id" in child) {
      continue
    }
    sanitized[key] = sanitizeModelVisibleValue(child, options)
  }
  return sanitized
}

const isRuntimeOwnedModelKey = (key: string, options: { preserveTraceRetrieveIds?: boolean } = {}): boolean => {
  if (options.preserveTraceRetrieveIds && (key === "conversationId" || key === "turnId" || key === "messageId" || key === "toolId")) {
    return false
  }
  return (
    key === "id" ||
    key === "ids" ||
    key === "handle" ||
    key === "sourceId" ||
    key === "sourceIds" ||
    key === "inspectArgs" ||
    key === "projectId" ||
    key === "conversationId" ||
    key === "conversationIds" ||
    key === "sessionId" ||
    key === "turnId" ||
    key === "messageId" ||
    key === "toolCallId" ||
    key === "terminalId" ||
    key === "processId" ||
    key === "outputSequence" ||
    key === "nextOutputSequence" ||
    key === "systemPid" ||
    key === "serverId" ||
    key === "configId" ||
    key === "providerId" ||
    key === "modelCallId" ||
    key.endsWith("Id") ||
    key.endsWith("Ids")
  )
}

const addDuplicateTraceRetrieveWarning = (output: unknown): unknown => {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output
  }
  const cloned = JSON.parse(JSON.stringify(output)) as Record<string, unknown>
  const warnings = Array.isArray(cloned.warnings) ? cloned.warnings.filter((item): item is string => typeof item === "string") : []
  cloned.warnings = [
    ...warnings,
    "Identical trace_retrieve input already ran earlier in this turn; this cached result was returned. Inspect a resultNumber or change the query, filters, or scope instead of repeating the same search.",
  ]
  return cloned
}

const normalizedToolTargetKey = (toolCall: NormalizedToolCall): string | undefined => {
  const input = toolCall.input && typeof toolCall.input === "object" && !Array.isArray(toolCall.input) ? toolCall.input as Record<string, unknown> : {}
  if (toolCall.toolName === "read") {
    return typeof input.path === "string" ? `read:${normalizePathKey(input.path)}` : undefined
  }
  if (toolCall.toolName === "search") {
    const mode = typeof input.mode === "string" ? input.mode : "unknown"
    const query = typeof input.query === "string" ? normalizeTextKey(input.query) : ""
    const searchPath = typeof input.path === "string" ? normalizePathKey(input.path) : ""
    return `search:${mode}:${searchPath}:${query}`
  }
  if (toolCall.toolName === "bash") {
    const operation = typeof input.operation === "string" ? input.operation : "run"
    const command = typeof input.command === "string" ? normalizeTextKey(input.command).slice(0, 200) : ""
    const cwd = typeof input.cwd === "string" ? normalizePathKey(input.cwd) : ""
    return command ? `bash:${operation}:${cwd}:${command}` : undefined
  }
  if (toolCall.toolName === "edit") {
    return typeof input.path === "string" ? `edit:${normalizePathKey(input.path)}` : undefined
  }
  if (toolCall.toolName === "apply_patch") {
    const patchText = typeof input.patchText === "string" ? input.patchText : typeof input.patch === "string" ? input.patch : ""
    const patchPath = firstPatchPath(patchText)
    return patchPath ? `apply_patch:${normalizePathKey(patchPath)}` : `apply_patch:${normalizeTextKey(patchText).slice(0, 200)}`
  }
  return undefined
}

const toolCallTargetPreview = (toolCall: NormalizedToolCall): string => {
  const key = normalizedToolTargetKey(toolCall)
  return key ? `[${key}]` : previewJson(toolCall.input)
}

const mutationTargetFor = (toolCall: NormalizedToolCall): string => {
  const input = toolCall.input && typeof toolCall.input === "object" && !Array.isArray(toolCall.input) ? toolCall.input as Record<string, unknown> : {}
  if (typeof input.path === "string") {
    return normalizePathKey(input.path)
  }
  const patchText = typeof input.patchText === "string" ? input.patchText : typeof input.patch === "string" ? input.patch : ""
  return firstPatchPath(patchText) ?? "unknown target"
}

const firstPatchPath = (patchText: string): string | undefined => {
  const match = /^(?:\*\*\* (?:Update|Delete) File:|\*\*\* Add File:|\*\*\* Move to:)\s+(.+)$/m.exec(patchText)
  return match?.[1]?.trim()
}

const normalizePathKey = (value: string): string => value.trim().replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\.\//, "")

const normalizeTextKey = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase()

const stableToolInputKey = (toolName: string, input: unknown): string => `${toolName}:${stableJsonStringify(input)}`

const stableJsonStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJsonStringify(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

const previewJson = (value: unknown): string => {
  const text = JSON.stringify(value)
  if (!text) {
    return ""
  }
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

// Pulls a human-friendly hint out of partially streamed tool-call argument text so
// the UI can show "Editing <file>" / "Running <command>" before the call is fully parsed.
const extractStreamingPreview = (
  toolName: string,
  argsText: string,
): { pathPreview?: string; argsPreview?: string } => {
  const readField = (field: string): string | undefined => {
    const match = argsText.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`))
    if (!match) {
      return undefined
    }
    try {
      return JSON.parse(`"${match[1]}"`) as string
    } catch {
      return match[1]
    }
  }

  if (toolName === "bash") {
    const command = readField("command")
    return command ? { argsPreview: command } : {}
  }

  const path = readField("path")
  if (path) {
    return { pathPreview: path, argsPreview: path }
  }
  return {}
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }
    this.values.push(value)
  }

  close(): void {
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined as T })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value) {
          return Promise.resolve({ done: false, value })
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined as T })
        }
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      },
    }
  }
}
