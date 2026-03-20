export type ChatRole = "user" | "assistant";

export type ChatMessageStatus = "streaming" | "complete" | "error";

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  status: ChatMessageStatus;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
  messageCount: number;
};

export type CreateConversationRequest = {
  title?: string;
};

export type SendMessageRequest = {
  content: string;
};

export type StreamMetaEvent = {
  type: "meta";
  conversationId: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
};

export type StreamDeltaEvent = {
  type: "delta";
  assistantMessageId: string;
  delta: string;
};

export type StreamDoneEvent = {
  type: "done";
  assistantMessageId: string;
};

export type StreamErrorEvent = {
  type: "error";
  assistantMessageId: string;
  message: string;
};

export type ChatStreamEvent =
  | StreamMetaEvent
  | StreamDeltaEvent
  | StreamDoneEvent
  | StreamErrorEvent;
