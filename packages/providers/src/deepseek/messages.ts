import type { ModelToolDefinition, ProviderMetadata, ThinkingEffort } from "@socrates/contracts"
import { schemaToJsonSchema } from "../jsonSchema"
import { toolParametersJsonSchema } from "../toolJsonSchemas"
import type { ModelMessage, ModelMessageContent, ModelMessagePart, ModelRequest } from "../types"
import type { DeepSeekChatMessage, DeepSeekChatRequest, DeepSeekTool } from "./types"

type DeepSeekRequestInput = Pick<ModelRequest, "modelId" | "system" | "messages" | "runtimeConfig"> &
  Partial<Pick<ModelRequest, "tools">>

export const createDeepSeekChatRequest = (
  request: DeepSeekRequestInput,
  options: { stream: boolean; jsonObject?: boolean; schema?: unknown } = { stream: true },
): DeepSeekChatRequest => {
  const system = options.schema ? structuredSystemPrompt(request.system, options.schema) : request.system
  const thinkingEnabled = Boolean(request.runtimeConfig.thinkingEnabled)
  return {
    model: request.modelId,
    messages: toDeepSeekMessages({ system, messages: request.messages }),
    stream: options.stream,
    ...(options.stream ? { stream_options: { include_usage: true } } : {}),
    thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
    ...(thinkingEnabled ? { reasoning_effort: toDeepSeekReasoningEffort(request.runtimeConfig.thinkingEffort) } : {}),
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(toDeepSeekTool) } : {}),
    ...(options.jsonObject ? { response_format: { type: "json_object" as const } } : {}),
  }
}

export const toDeepSeekMessages = (request: Pick<ModelRequest, "system" | "messages">): DeepSeekChatMessage[] => {
  const messages: DeepSeekChatMessage[] = request.system.trim() ? [{ role: "system", content: request.system }] : []
  for (const message of normalizeInlineDeveloperMessages(request.messages)) {
    messages.push(...toDeepSeekMessage(message))
  }
  return messages
}

const toDeepSeekMessage = (message: ModelMessage): DeepSeekChatMessage[] => {
  if (message.role === "developer") {
    return [{ role: "user", content: developerContextText(message.content) }]
  }
  if (message.role === "tool") {
    return toolMessagesFromContent(message.content)
  }
  if (typeof message.content === "string") {
    return [
      {
        role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
        content: message.content,
      },
    ]
  }
  if (message.role === "assistant") {
    const content = assistantText(message.content)
    const reasoningContent = reasoningText(message.content)
    const toolCalls = message.content.filter((part) => part.type === "tool-call").map((part) => ({
      id: part.toolCallId,
      type: "function" as const,
      function: {
        name: part.toolName,
        arguments: stringifyToolArguments(part.input),
      },
    }))
    return [
      {
        role: "assistant",
        content,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ]
  }
  return [
    {
      role: message.role === "system" ? "system" : "user",
      content: userText(message.content, message.role),
    },
  ]
}

const normalizeInlineDeveloperMessages = (messages: ModelRequest["messages"]): ModelRequest["messages"] => {
  const normalized: ModelRequest["messages"] = []
  for (const message of messages) {
    if (message.role !== "developer") {
      normalized.push(message)
      continue
    }
    const developerText = developerContextText(message.content)
    const previous = normalized[normalized.length - 1]
    if (previous?.role === "user") {
      normalized[normalized.length - 1] = {
        ...previous,
        content: appendText(previous.content, developerText),
      }
      continue
    }
    normalized.push({ role: "user", content: developerText })
  }
  return normalized
}

const appendText = (content: ModelMessageContent, text: string): ModelMessageContent =>
  typeof content === "string" ? `${content}\n\n${text}` : [...content, { type: "text", text }]

const userText = (parts: ModelMessagePart[], role: ModelMessage["role"]): string =>
  parts
    .map((part) => {
      if (part.type === "text") {
        return part.text
      }
      if (part.type === "image") {
        return `[image omitted: ${part.fileName ?? part.mediaType}]`
      }
      if (part.type === "tool-result") {
        return toolResultText(part)
      }
      if (part.type === "reasoning" && role !== "assistant") {
        return part.text
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")

const assistantText = (parts: ModelMessagePart[]): string =>
  parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")

const reasoningText = (parts: ModelMessagePart[]): string =>
  parts
    .filter((part) => part.type === "reasoning")
    .map((part) => providerReasoningContent(part.providerMetadata) ?? part.text)
    .filter(Boolean)
    .join("\n")

const providerReasoningContent = (metadata: ProviderMetadata | undefined): string | undefined => {
  const deepseek = metadata?.deepseek
  if (deepseek && typeof deepseek === "object" && "reasoningContent" in deepseek) {
    const value = (deepseek as Record<string, unknown>).reasoningContent
    return typeof value === "string" ? value : undefined
  }
  return undefined
}

const toolMessagesFromContent = (content: ModelMessageContent): DeepSeekChatMessage[] => {
  if (typeof content === "string") {
    return [{ role: "user", content: `<tool_result>\n${content}\n</tool_result>` }]
  }
  const toolMessages = content
    .filter((part) => part.type === "tool-result")
    .map((part) => ({
      role: "tool" as const,
      tool_call_id: part.toolCallId,
      content: outputText(part.output),
    }))
  return toolMessages.length > 0 ? toolMessages : [{ role: "user", content: userText(content, "tool") }]
}

const toolResultText = (part: Extract<ModelMessagePart, { type: "tool-result" }>): string =>
  JSON.stringify({ toolName: part.toolName, toolCallId: part.toolCallId, output: part.output ?? null })

const developerContextText = (content: ModelMessageContent): string =>
  [
    "<runtime_socrates_developer_context>",
    "The following is Socrates runtime guidance, not user-authored content.",
    typeof content === "string" ? content : userText(content, "developer"),
    "</runtime_socrates_developer_context>",
  ].join("\n")

const toDeepSeekTool = (definition: ModelToolDefinition): DeepSeekTool => ({
  type: "function",
  function: {
    name: definition.name,
    description: definition.description,
    parameters: toolParametersJsonSchema(definition),
  },
})

const toDeepSeekReasoningEffort = (effort: ThinkingEffort | undefined): "high" | "max" => (effort === "xhigh" ? "max" : "high")

const structuredSystemPrompt = (system: string, schema: unknown): string =>
  [
    system,
    "",
    "Return only a valid JSON object matching this JSON Schema. Do not wrap it in markdown.",
    JSON.stringify(schemaToJsonSchema(schema)),
  ].join("\n")

const stringifyToolArguments = (input: unknown): string => {
  if (typeof input === "string") {
    return input
  }
  return outputText(input)
}

const outputText = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify(String(value))
  }
}
