import {
  normalizedToolCallSchema,
  toolExecutionResultSchema,
  type ModelToolDefinition,
  type NormalizedToolCall,
  type ProviderId,
  type RuntimeConfig,
  type ToolExecutionResult,
  type ToolName,
} from "@socrates/contracts"
import fs from "node:fs"
import path from "node:path"
import { createId, normalizeError, SocratesError } from "@socrates/shared"
import type { ModelEvent, ModelMessage, ModelMessagePart, ModelProvider, ModelUsage, TokenCountResult } from "@socrates/providers"
import {
  prepareContextForModelCall,
  precomputeContextSnapshot,
  type ContextCompactionLifecycleEvent,
  type ContextCompressionRuntime,
} from "../context/contextCompression"
import { buildSocratesSystemPrompt, type SocratesPromptContext } from "../prompts/socratesPrompt"
import { createDefaultToolRegistry, type ToolRegistry } from "../tools/registry"
import type { ApprovalDecision, ApprovalRequest, ToolExecutors, ToolLifecycleEvent, ToolPolicyDecision, ToolRuntimeContext } from "../tools/types"

export type SocratesAgentTurnInput = {
  projectId?: string
  conversationId?: string
  sessionId?: string
  cacheKey?: string
  turnId?: string
  providerId: ProviderId
  modelId: string
  runtimeConfig: RuntimeConfig
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
  contextCompression?: ContextCompressionRuntime
  maxToolCallsPerTurn?: number
  maxConfirmedToolErrorsPerTurn?: number
  maxParallelToolCalls?: number
  dynamicTools?: ModelToolDefinition[] | (() => ModelToolDefinition[])
  abortSignal?: AbortSignal
  fileFreshness?: import("../tools/types").FileFreshnessTracker
}

export type SocratesAgentContextPrecomputeInput = {
  providerId: ProviderId
  modelId: string
  runtimeConfig: RuntimeConfig
  messages: ModelMessage[]
  promptContext?: SocratesPromptContext
  contextCompression: ContextCompressionRuntime
}

export type SocratesAgentEvent = ModelEvent | ToolLifecycleEvent | ContextCompactionLifecycleEvent

export class SocratesAgent {
  constructor(
    private readonly provider: ModelProvider,
    private readonly toolRegistry: ToolRegistry = createDefaultToolRegistry(),
  ) {}

  async precomputeContext(input: SocratesAgentContextPrecomputeInput): Promise<ContextCompactionLifecycleEvent[]> {
    const system = buildSocratesSystemPrompt(input.promptContext)
    return precomputeContextSnapshot({
      provider: this.provider,
      providerId: input.providerId,
      modelId: input.modelId,
      runtimeConfig: input.runtimeConfig,
      system,
      messages: input.messages,
      compression: input.contextCompression,
    })
  }

  async *streamTurn(input: SocratesAgentTurnInput): AsyncIterable<SocratesAgentEvent> {
    const system = input.systemPromptOverride ?? buildSocratesSystemPrompt(input.promptContext)
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
    let totalToolCountNudgeSent = false
    let baselineInputTokens: number | undefined
    let currentTurnTokenSoftNudgeSent = false
    let currentTurnTokenHardStopSent = false
    let docsPreflightSent = false
    let docsSyncCheckpointSent = false

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

    if (requiresRepoDocsPreflightBeforePolicy(tool.name) && !docsLedger.hasRepoDocsPreflight()) {
      const error = repoDocsPreflightError(tool.name)
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

      if (requiresRepoDocsPreflightAfterPolicy(tool, policy) && !docsLedger.hasRepoDocsPreflight()) {
        throw repoDocsPreflightError(tool.name)
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
This turn has workspace tools. For nontrivial work, use the Socrates docs loop: 1) before meaningful implementation or repo investigation, read relevant repo_docs and fix stale/missing doctrine before implementing; 2) use project_docs memory after meaningful work for durable outcomes, decisions, constraints, blockers, and handoff facts; 3) use project_docs notes actively for todos, checked files, next commands, partial progress, and restart points. Use tool_docs before unfamiliar, failed, or edge-case tool use. Skip only genuinely tiny one-shot answers.
</runtime_socrates_docs_preflight>`

const TOOL_DOCS_FAILURE_NUDGE = "Refer to tool_docs for tool usage before retrying this tool or choosing another tool."
const MUTATION_SCHEMA_RECOVERY_HINT =
  'Runtime tool-schema recovery: the previous edit/apply_patch input was invalid. For a new file, call edit with exactly { "path": "relative/path.md", "content": "..." }. For a full rewrite of an existing file, use exactly { "path": "relative/path.md", "content": "...", "overwrite": true }. For a targeted replacement, use exactly { "path": "relative/path.md", "oldString": "...", "newString": "..." }. Do not mix content with oldString/newString, and do not set overwrite unless it is true.'
const FAILED_MUTATION_FORCE_FINAL_THRESHOLD = 4
const REPO_DOCS_PREFLIGHT_MESSAGE =
  "Before approval-required mutation or edit/apply_patch, call repo_docs with operation read or search in this turn. Read the relevant repo rules, navigation, contracts, or core idea; update stale repo docs if needed; then retry the mutation."

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

const repoDocsPreflightError = (toolName: ToolName): SocratesError =>
  new SocratesError("repo_docs_preflight_required", REPO_DOCS_PREFLIGHT_MESSAGE, {
    recoverable: true,
    details: { toolName },
  })

const requiresRepoDocsPreflightBeforePolicy = (toolName: ToolName): boolean => toolName === "edit" || toolName === "apply_patch"

const requiresRepoDocsPreflightAfterPolicy = (
  tool: { name: ToolName; executeLane: "parallel" | "mutation" },
  policy: ToolPolicyDecision,
): boolean =>
  policy.type === "approval_required" &&
  tool.executeLane === "mutation" &&
  tool.name !== "repo_docs" &&
  tool.name !== "project_docs"

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

class TurnDocsLedger {
  private totalToolCalls = 0
  private evidenceToolCalls = 0
  private failedToolCalls = 0
  private projectDocsRead = false
  private projectDocsEdited = false
  private projectMemoryEdited = false
  private projectNotesEdited = false
  private repoDocsRead = false
  private repoDocsEdited = false
  private repoDocsPreflightComplete = false
  private toolDocsRead = false
  private emptyProjectDocsRead = false
  private mutationSucceeded = false
  private bashSucceeded = false
  private readonly changedFiles = new Set<string>()
  private readonly commands: string[] = []

  hasRepoDocsPreflight(): boolean {
    return this.repoDocsPreflightComplete || this.repoDocsRead || this.repoDocsEdited
  }

  recordImmediatePreflight(result: ToolExecutionResult, toolCall: NormalizedToolCall | undefined): void {
    if (!result.ok || result.toolName !== "repo_docs") {
      return
    }
    const operation = toolOperation(toolCall)
    if (operation === undefined || operation === "read" || operation === "search" || operation === "edit") {
      this.repoDocsPreflightComplete = true
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
    if (this.projectMemoryEdited) {
      return undefined
    }
    const meaningfulWork =
      this.mutationSucceeded ||
      this.bashSucceeded ||
      this.evidenceToolCalls >= 5 ||
      this.totalToolCalls >= 8 ||
      this.failedToolCalls >= 2
    if (!meaningfulWork) {
      return undefined
    }

    const facts = [
      this.changedFiles.size > 0 ? `files changed: ${clipList([...this.changedFiles], 4, 160)}` : undefined,
      this.commands.length > 0 ? `commands: ${clipList(this.commands, 3, 180)}` : undefined,
      this.evidenceToolCalls > 0 ? `evidence tools: ${this.evidenceToolCalls}` : undefined,
      this.failedToolCalls > 0 ? `failed tools: ${this.failedToolCalls}` : undefined,
      this.emptyProjectDocsRead ? "project docs looked empty" : undefined,
      `docs read: project=${this.projectDocsRead ? "yes" : "no"}, repo=${this.repoDocsRead ? "yes" : "no"}, tool=${this.toolDocsRead ? "yes" : "no"}`,
      `project_docs edits: memory=${this.projectMemoryEdited ? "yes" : "no"}, notes=${this.projectNotesEdited ? "yes" : "no"}`,
    ].filter((item): item is string => typeof item === "string")

    return `<runtime_docs_sync_checkpoint>
Before final answer, close the Socrates docs loop. This turn did meaningful workspace work (${facts.join("; ")}). You have not updated project_docs memory. Call project_docs memory now with the durable outcome, decision, blocker, changed files/docs, or handoff fact. Notes do not satisfy memory; notes are live scratch state, memory is the cross-conversation record. If active todos, checked files, next commands, partial progress, or restart context matter, also call project_docs notes. If repo behavior, contracts, navigation, provider/tool behavior, or durable pitfalls changed, call repo_docs too. If tools failed and tool_docs was not checked, call tool_docs before retrying or explaining. Skip project_docs memory only when no durable fact exists after meaningful work.
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

const toolOperation = (toolCall: NormalizedToolCall | undefined): string | undefined => {
  const input = toolCall?.input && typeof toolCall.input === "object" && !Array.isArray(toolCall.input) ? toolCall.input as Record<string, unknown> : undefined
  return typeof input?.operation === "string" ? input.operation : undefined
}

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
  if (options.preserveTraceRetrieveIds && (key === "conversationId" || key === "messageId" || key === "toolId")) {
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
