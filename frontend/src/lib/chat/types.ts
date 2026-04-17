export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessageStatus = "streaming" | "complete" | "error";

export type ReasoningPayload = {
  text?: string | null;
  details?: unknown[] | null;
  status?: "streaming" | "complete";
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  status: ChatMessageStatus;
  provider?: string | null;
  model?: string | null;
  reasoning?: ReasoningPayload | null;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  thinkingEnabled: boolean;
  messages: ChatMessage[];
};

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
  messageCount: number;
  provider: string;
  model: string;
  thinkingEnabled: boolean;
};

export type UpdateConversationRequest = {
  title?: string;
  status?: "active" | "archived" | "deleted";
  provider?: string;
  model?: string;
  thinkingEnabled?: boolean;
};

export type CreateConversationRequest = {
  title?: string;
  provider?: string;
  model?: string;
  thinkingEnabled?: boolean;
};

export type SendMessageRequest = {
  content: string;
  provider?: string;
  model?: string;
  thinkingEnabled?: boolean;
};

export type ModelOption = {
  id: string;
  provider: string;
  displayName: string;
  supportsThinking: boolean;
  supportsImages: boolean;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
};

export type StreamMetaEvent = {
  type: "meta";
  conversationId: string;
  conversationTitle: string;
  provider: string;
  model: string;
  thinkingEnabled: boolean;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
};

export type StreamDeltaEvent = {
  type: "delta";
  assistantMessageId: string;
  delta: string;
};

export type StreamReasoningEvent = {
  type: "reasoning";
  assistantMessageId: string;
  reasoning: ReasoningPayload;
};

export type StreamDoneEvent = {
  type: "done";
  assistantMessageId: string;
  persistedAssistantMessageId?: string;
};

export type StreamErrorEvent = {
  type: "error";
  assistantMessageId: string;
  message: string;
};

export type ChatStreamEvent =
  | StreamMetaEvent
  | StreamDeltaEvent
  | StreamReasoningEvent
  | StreamDoneEvent
  | StreamErrorEvent;
