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
import type { ApprovalDecision, ApprovalRequest, ToolExecutors, ToolLifecycleEvent, ToolRuntimeContext } from "../tools/types"

export type SocratesAgentTurnInput = {
  projectId?: string
  conversationId?: string
  sessionId?: string
  turnId?: string
  providerId: ProviderId
  modelId: string
  runtimeConfig: RuntimeConfig
  messages: ModelMessage[]
  promptContext?: SocratesPromptContext
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
    const system = buildSocratesSystemPrompt(input.promptContext)
    const messages: ModelMessage[] = [...input.messages]
    const maxToolCallsPerTurn = input.maxToolCallsPerTurn ?? 80
    const maxConfirmedToolErrorsPerTurn = input.maxConfirmedToolErrorsPerTurn ?? 10
    const maxParallelToolCalls = input.maxParallelToolCalls ?? 5
    let usedToolCalls = 0
    let confirmedToolErrors = 0
    let forceFinalNoTools = false
    const duplicateTraceRetrieveResults = new Map<string, unknown>()

    for (let step = 0; ; step += 1) {
      const dynamicTools = typeof input.dynamicTools === "function" ? input.dynamicTools() : input.dynamicTools
      const tools = forceFinalNoTools || !input.toolExecutors ? [] : this.toolRegistry.modelDefinitions(dynamicTools)
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
      const toolRunIds = new Map<string, string>()
      let stepText = ""
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
      })

      for await (const event of batch.events) {
        yield event
      }

      const execution = await batch.done
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

      if (maxConfirmedToolErrorsPerTurn > 0 && confirmedToolErrors >= maxConfirmedToolErrorsPerTurn) {
        const recentCodes = [...new Set(confirmedToolErrorResults.map((result) => result.error?.code).filter(Boolean))]
        messages.push({
          role: "user",
          content: `There have been ${confirmedToolErrors} confirmed tool-call execution errors this turn${recentCodes.length > 0 ? ` (latest codes: ${recentCodes.join(", ")})` : ""}. Do not call more tools. Give the best final answer from the evidence already available, and mention any remaining uncertainty or the exact tool-error blocker.`,
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
          chunk.map((toolCall) => this.executeOneToolCall(toolCall, input.context, queue, input.duplicateTraceRetrieveResults)),
        )
        for (const result of chunkResults) {
          results.set(result.toolCallId, result)
        }
      }

      for (const toolCall of mutation) {
        const result = await this.executeOneToolCall(toolCall, input.context, queue, input.duplicateTraceRetrieveResults)
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

const toolErrorResult = (toolCall: NormalizedToolCall, error: SocratesError): ToolExecutionResult =>
  toolExecutionResultSchema.parse({
    toolCallId: toolCall.toolCallId,
    providerToolCallId: toolCall.providerToolCallId,
    toolName: toolCall.toolName,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  })

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
