import {
  normalizedToolCallSchema,
  toolExecutionResultSchema,
  type ModelToolDefinition,
  type NormalizedToolCall,
  type ProviderId,
  type RuntimeConfig,
  type ToolExecutionResult,
} from "@socrates/contracts"
import { createId, normalizeError, SocratesError } from "@socrates/shared"
import type { ModelEvent, ModelMessage, ModelMessagePart, ModelProvider, ModelUsage } from "@socrates/providers"
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
    promptContext?: SocratesPromptContext
    tools: ModelToolDefinition[]
  }) => string
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>
  contextCompression?: ContextCompressionRuntime
  maxToolCallsPerTurn?: number
  maxParallelToolCalls?: number
  abortSignal?: AbortSignal
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
    const maxParallelToolCalls = input.maxParallelToolCalls ?? 5
    let usedToolCalls = 0
    let forceFinalNoTools = false

    for (let step = 0; ; step += 1) {
      const tools = forceFinalNoTools || !input.toolExecutors ? [] : this.toolRegistry.modelDefinitions()
      const preparedContext = await prepareContextForModelCall({
        provider: this.provider,
        providerId: input.providerId,
        modelId: input.modelId,
        runtimeConfig: input.runtimeConfig,
        system,
        messages,
        ...(input.contextCompression ? { compression: input.contextCompression } : {}),
      })
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
        tools,
        ...(input.promptContext ? { promptContext: input.promptContext } : {}),
      })
      const assistantParts: ModelMessagePart[] = []
      const toolCalls: NormalizedToolCall[] = []
      let stepText = ""

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

        if (modelEvent.type === "model.tool_call.completed") {
          const parsed = normalizedToolCallSchema.safeParse(modelEvent.toolCall)
          if (parsed.success) {
            toolCalls.push(parsed.data)
          }
        }

        yield attachModelCallId(modelEvent, modelCallId)
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
          toolCallId: toolCall.toolCallId,
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
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        },
        remainingBudget: maxToolCallsPerTurn - usedToolCalls,
        maxParallelToolCalls,
      })

      for await (const event of batch.events) {
        yield event
      }

      const execution = await batch.done
      usedToolCalls += execution.countedToolCalls

      messages.push({ role: "assistant", content: assistantParts })
      messages.push({
        role: "tool",
        content: execution.results.map((result) => ({
          type: "tool-result",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          output: result,
        })),
      })

      if (execution.budgetExhausted || usedToolCalls >= maxToolCallsPerTurn) {
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
          queue.push({ type: "tool.call.failed", toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, error })
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
        const chunkResults = await Promise.all(chunk.map((toolCall) => this.executeOneToolCall(toolCall, input.context, queue)))
        for (const result of chunkResults) {
          results.set(result.toolCallId, result)
        }
      }

      for (const toolCall of mutation) {
        const result = await this.executeOneToolCall(toolCall, input.context, queue)
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
  ): Promise<ToolExecutionResult> {
    const startedAt = Date.now()
    const tool = this.toolRegistry.get(toolCall.toolName)
    if (!tool) {
      const error = new SocratesError("tool_not_found", "Tool is not registered", { details: { toolName: toolCall.toolName } })
      queue.push({ type: "tool.call.failed", toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, error })
      return toolErrorResult(toolCall, error)
    }

    const parsed = tool.inputSchema.safeParse(toolCall.input)
    if (!parsed.success) {
      const error = new SocratesError("invalid_tool_input", "Tool input did not match the schema", {
        details: parsed.error.flatten(),
      })
      queue.push({ type: "tool.call.failed", toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, error })
      return toolErrorResult(toolCall, error)
    }

    const policy = tool.decidePolicy(parsed.data, context)
    queue.push({
      type: "tool.call.started",
      toolCallId: toolCall.toolCallId,
      toolName: tool.name,
      category: tool.category,
      displayName: tool.name,
      argsPreview: previewJson(parsed.data),
      input: parsed.data,
      requiresApproval: policy.type === "approval_required",
    })

    try {
      if (policy.type === "denied") {
        throw new SocratesError("tool_denied", policy.reason)
      }

      if (policy.type === "approval_required") {
        const approvalId = createId("appr")
        const request: ApprovalRequest = {
          approvalId,
          toolCallId: toolCall.toolCallId,
          toolName: tool.name,
          ...policy.request,
        }
        queue.push({ type: "approval.requested", request })
        const decision = await context.requestApproval(request)
        queue.push({ type: "approval.resolved", approvalId, toolCallId: toolCall.toolCallId, decision: decision.decision })
        if (decision.decision !== "approved") {
          throw new SocratesError("tool_approval_rejected", decision.reason ?? "The user rejected this tool call.")
        }
      }

      const output = await tool.execute(parsed.data, {
        ...context,
        toolCallId: toolCall.toolCallId,
        onOutput: (output) => queue.push({ type: "tool.call.output", toolCallId: toolCall.toolCallId, ...output }),
      })
      const parsedOutput = tool.resultSchema.safeParse(output)
      if (!parsedOutput.success) {
        throw new SocratesError("invalid_tool_output", "Tool output did not match the schema", {
          details: parsedOutput.error.flatten(),
        })
      }
      queue.push({
        type: "tool.call.completed",
        toolCallId: toolCall.toolCallId,
        toolName: tool.name,
        output: parsedOutput.data,
        summary: tool.summary(parsedOutput.data),
        resultPreview: tool.resultPreview(parsedOutput.data),
        ...(tool.metrics ? { metrics: tool.metrics(parsedOutput.data) } : {}),
        durationMs: Date.now() - startedAt,
      })
      return {
        toolCallId: toolCall.toolCallId,
        toolName: tool.name,
        ok: true,
        output: parsedOutput.data,
      }
    } catch (error) {
      const normalized = normalizeError(error)
      queue.push({ type: "tool.call.failed", toolCallId: toolCall.toolCallId, toolName: tool.name, error: normalized })
      return toolErrorResult(toolCall, normalized)
    }
  }
}

const attachModelCallId = (event: ModelEvent, modelCallId: string | undefined): ModelEvent => {
  if (!modelCallId || event.type === "model.started") {
    return event
  }
  return { ...event, modelCallId } as ModelEvent
}

const toolErrorResult = (toolCall: NormalizedToolCall, error: SocratesError): ToolExecutionResult =>
  toolExecutionResultSchema.parse({
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  })

const previewJson = (value: unknown): string => {
  const text = JSON.stringify(value)
  if (!text) {
    return ""
  }
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
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
