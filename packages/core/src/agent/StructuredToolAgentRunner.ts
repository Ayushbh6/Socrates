import type { RuntimeConfig } from "@socrates/contracts"
import type { ModelEvent, ModelMessage, ModelMessagePart, ModelProvider, ModelUsage } from "@socrates/providers"
import { createId, SocratesError } from "@socrates/shared"
import { prepareContextForModelCall, type ContextCompressionRuntime } from "../context/contextCompression"
import type { ToolExecutors } from "../tools/types"
import { ToolRegistry } from "../tools/registry"

export type StructuredToolAgentRunInput<TOutput> = {
  provider: ModelProvider
  providerId: RuntimeConfig["providerId"]
  modelId: string
  runtimeConfig: RuntimeConfig
  system: string
  userContent: string
  schema: StructuredOutputSchema<TOutput>
  toolRegistry: ToolRegistry
  toolExecutors: ToolExecutors
  maxToolCalls: number
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  workspacePath: string
  cacheKey?: string
  abortSignal?: AbortSignal
  contextCompression?: ContextCompressionRuntime
  onModelEvent?: (event: ModelEvent) => void
  onToolResult?: (result: { toolCallId: string; toolName: string; input: unknown; output: unknown }) => void
}

type StructuredOutputSchema<TOutput> = {
  safeParse(value: unknown):
    | { success: true; data: TOutput }
    | { success: false; error: { flatten(): unknown } }
}

export type StructuredToolAgentRunResult<TOutput> = {
  output: TOutput
  toolCalls: number
  usages: ModelUsage[]
}

export class StructuredToolAgentRunner {
  async run<TOutput>(input: StructuredToolAgentRunInput<TOutput>): Promise<StructuredToolAgentRunResult<TOutput>> {
    if (!input.provider.generateStructured) {
      throw new SocratesError("structured_generation_unavailable", "This agent requires provider structured generation.", { recoverable: true })
    }
    let messages: ModelMessage[] = [{ role: "user", content: input.userContent }]
    const usages: ModelUsage[] = []
    let usedToolCalls = 0

    while (usedToolCalls < input.maxToolCalls) {
      const assistantParts: ModelMessagePart[] = []
      const toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown; providerMetadata?: Record<string, Record<string, unknown>> }> = []
      let answerText = ""
      const tools = input.toolRegistry.modelDefinitions()
      const prepared = await prepareContextForModelCall({
        provider: input.provider,
        providerId: input.providerId,
        modelId: input.modelId,
        runtimeConfig: input.runtimeConfig,
        system: input.system,
        messages,
        tools,
        ...(input.contextCompression ? { compression: input.contextCompression } : {}),
      })
      messages = prepared.messages
      for await (const event of input.provider.stream({
        providerId: input.providerId,
        modelId: input.modelId,
        system: input.system,
        messages,
        runtimeConfig: input.runtimeConfig,
        tools,
        modelCallId: createId("mcall"),
        ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      })) {
        input.onModelEvent?.(event)
        if (event.type === "model.answer.delta") answerText += event.text
        if (event.type === "model.tool_call.completed") {
          toolCalls.push({
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            input: event.toolCall.input ?? {},
            ...(event.toolCall.providerMetadata ? { providerMetadata: event.toolCall.providerMetadata } : {}),
          })
        }
        if (event.type === "model.usage") usages.push(event.usage)
        if (event.type === "model.failed") throw event.error
      }
      if (toolCalls.length === 0) break
      if (answerText.trim()) assistantParts.push({ type: "text", text: answerText })
      const allowed = toolCalls.slice(0, input.maxToolCalls - usedToolCalls)
      assistantParts.push(
        ...allowed.map((toolCall) => ({
          type: "tool-call" as const,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
          ...(toolCall.providerMetadata ? { providerMetadata: toolCall.providerMetadata } : {}),
        })),
      )
      const results = []
      for (const toolCall of allowed) {
        const result = await executeTool(input, toolCall)
        results.push(result)
        input.onToolResult?.({ ...result, input: toolCall.input })
        usedToolCalls += 1
      }
      messages.push({ role: "assistant", content: assistantParts })
      messages.push({
        role: "tool",
        content: results.map((result) => ({ type: "tool-result", toolCallId: result.toolCallId, toolName: result.toolName, output: result.output })),
      })
    }

    messages.push({ role: "developer", content: "Finish now. Return only the strict structured result requested by the system contract. Do not call tools." })
    const finalPrepared = await prepareContextForModelCall({
      provider: input.provider,
      providerId: input.providerId,
      modelId: input.modelId,
      runtimeConfig: input.runtimeConfig,
      system: input.system,
      messages,
      ...(input.contextCompression ? { compression: input.contextCompression } : {}),
    })
    const generated = await input.provider.generateStructured<TOutput>({
      providerId: input.providerId,
      modelId: input.modelId,
      system: input.system,
      messages: finalPrepared.messages,
      runtimeConfig: input.runtimeConfig,
      schema: input.schema,
      modelCallId: createId("mcall"),
      ...(input.cacheKey ? { cacheKey: `${input.cacheKey}:structured-final` } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    })
    if (generated.usage) usages.push(generated.usage)
    const parsed = input.schema.safeParse(generated.output)
    if (!parsed.success) {
      throw new SocratesError("structured_agent_output_invalid", "Structured agent output did not match its schema.", {
        details: { validation: JSON.stringify(parsed.error.flatten()) },
        recoverable: true,
      })
    }
    return { output: parsed.data, toolCalls: usedToolCalls, usages }
  }
}

const executeTool = async <TOutput>(
  input: StructuredToolAgentRunInput<TOutput>,
  toolCall: { toolCallId: string; toolName: string; input: unknown },
): Promise<{ toolCallId: string; toolName: string; output: unknown }> => {
  const tool = input.toolRegistry.get(toolCall.toolName)
  if (!tool) {
    return { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, output: { error: { code: "tool_not_found", message: "Tool is not registered." } } }
  }
  const parsed = tool.inputSchema.safeParse(toolCall.input)
  if (!parsed.success) {
    return { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, output: { error: { code: "invalid_tool_input", message: "Correct the tool input and retry.", details: parsed.error.flatten() } } }
  }
  try {
    const output = await tool.execute(parsed.data, {
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      workspacePath: input.workspacePath,
      runtimeConfig: input.runtimeConfig,
      executors: input.toolExecutors,
      requestApproval: async () => ({ decision: "rejected", reason: "This backend agent may only use its explicitly scoped automatic tools." }),
      onOutput: () => undefined,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    })
    const validated = tool.resultSchema.safeParse(output)
    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      output: validated.success ? validated.data : { error: { code: "invalid_tool_output", message: "Tool output failed validation." } },
    }
  } catch (error) {
    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      output: { error: { code: "tool_failed", message: error instanceof Error ? error.message : String(error), recoverable: true } },
    }
  }
}
