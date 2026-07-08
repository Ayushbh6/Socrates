import type { ModelToolDefinition } from "@socrates/contracts"

export type DeepSeekChatMessage =
  | {
      role: "system" | "user"
      content: string
    }
  | {
      role: "assistant"
      content?: string | null
      reasoning_content?: string
      tool_calls?: DeepSeekToolCall[]
    }
  | {
      role: "tool"
      tool_call_id: string
      content: string
    }

export type DeepSeekTool = {
  type: "function"
  function: {
    name: ModelToolDefinition["name"]
    description: string
    parameters: unknown
  }
}

export type DeepSeekToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type DeepSeekChatRequest = {
  model: string
  messages: DeepSeekChatMessage[]
  stream: boolean
  stream_options?: {
    include_usage: boolean
  }
  thinking: {
    type: "enabled" | "disabled"
  }
  reasoning_effort?: "high" | "max"
  tools?: DeepSeekTool[]
  response_format?: {
    type: "json_object"
  }
}

export type DeepSeekUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  completion_tokens_details?: {
    reasoning_tokens?: number
  }
}

export type DeepSeekChatCompletionChunk = {
  id?: string
  object?: string
  created?: number
  model?: string
  system_fingerprint?: string
  choices?: Array<{
    index?: number
    finish_reason?: string | null
    delta?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: DeepSeekToolCallDelta[]
    }
  }>
  usage?: DeepSeekUsage | null
}

export type DeepSeekToolCallDelta = {
  index?: number
  id?: string
  type?: "function"
  function?: {
    name?: string
    arguments?: string
  }
}

export type DeepSeekChatCompletionResponse = {
  id?: string
  object?: string
  created?: number
  model?: string
  system_fingerprint?: string
  choices?: Array<{
    index?: number
    finish_reason?: string | null
    message?: {
      role?: "assistant"
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: DeepSeekToolCall[]
    }
  }>
  usage?: DeepSeekUsage
}
