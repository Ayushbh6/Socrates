import "server-only";

import type {
  ChatMessage,
  ChatMessageStatus,
  Conversation,
  ConversationSummary,
  CreateConversationRequest,
  ModelOption,
  SendMessageRequest,
  UpdateConversationRequest,
} from "@/lib/chat/types";

const BACKEND_BASE_URL =
  process.env.PREMCHAT_BACKEND_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:8000";

type BackendReasoning = {
  text?: string | null;
  details?: unknown[] | null;
};

type BackendMessage = {
  id: string;
  conversationId: string;
  role: ChatMessage["role"];
  contentText: string | null;
  createdAt: string;
  status: string;
  provider?: string | null;
  model?: string | null;
  reasoning?: BackendReasoning | null;
};

type BackendConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  thinkingEnabled: boolean;
  preview: string;
  messageCount: number;
  messages?: BackendMessage[];
};

type BackendModel = {
  id: string;
  provider: string;
  displayName: string;
  supportsThinking: boolean;
  supportsImages: boolean;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
};

type SendChatTurnResult = {
  conversation: Conversation;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
};

export class BackendRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BackendRequestError";
    this.status = status;
  }
}

function toChatStatus(status: string): ChatMessageStatus {
  if (status === "failed" || status === "cancelled") {
    return "error";
  }
  if (status === "streaming" || status === "pending") {
    return "streaming";
  }
  return "complete";
}

function mapMessage(message: BackendMessage): ChatMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.contentText ?? "",
    createdAt: message.createdAt,
    status: toChatStatus(message.status),
    provider: message.provider ?? null,
    model: message.model ?? null,
    reasoning: message.reasoning ?? null,
  };
}

function mapConversation(conversation: BackendConversation): Conversation {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    provider: conversation.provider,
    model: conversation.model,
    thinkingEnabled: conversation.thinkingEnabled,
    messages: (conversation.messages ?? []).map(mapMessage),
  };
}

function mapConversationSummary(conversation: BackendConversation): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    preview: conversation.preview,
    messageCount: conversation.messageCount,
    provider: conversation.provider,
    model: conversation.model,
    thinkingEnabled: conversation.thinkingEnabled,
  };
}

async function backendFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `Backend request failed with ${response.status}`;

    try {
      const payload = (await response.json()) as {
        detail?: string;
        error?: string;
        message?: string;
      };
      message = payload.detail || payload.error || payload.message || message;
    } catch {
      const text = await response.text();
      message = text || message;
    }

    throw new BackendRequestError(message, response.status);
  }

  return (await response.json()) as T;
}

export async function fetchConversationSummaries(): Promise<ConversationSummary[]> {
  const payload = await backendFetch<{ conversations: BackendConversation[] }>(
    "/api/v1/conversations"
  );
  return payload.conversations.map(mapConversationSummary);
}

export async function fetchConversationById(id: string): Promise<Conversation | null> {
  try {
    const payload = await backendFetch<{ conversation: BackendConversation }>(
      `/api/v1/conversations/${id}`
    );
    return mapConversation(payload.conversation);
  } catch {
    return null;
  }
}

export async function createConversationRecord(
  input: CreateConversationRequest
): Promise<Conversation> {
  const payload = await backendFetch<{ conversation: BackendConversation }>(
    "/api/v1/conversations",
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  return mapConversation(payload.conversation);
}

export async function updateConversationRecord(
  id: string,
  input: UpdateConversationRequest
): Promise<Conversation> {
  const payload = await backendFetch<{ conversation: BackendConversation }>(
    `/api/v1/conversations/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    }
  );
  return mapConversation(payload.conversation);
}

export async function sendConversationMessage(
  conversationId: string,
  input: SendMessageRequest
): Promise<SendChatTurnResult> {
  const payload = await backendFetch<{
    conversation: BackendConversation;
    userMessage: BackendMessage;
    assistantMessage: BackendMessage;
  }>(`/api/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
  });

  return {
    conversation: mapConversation(payload.conversation),
    userMessage: mapMessage(payload.userMessage),
    assistantMessage: mapMessage(payload.assistantMessage),
  };
}

export async function fetchModels(): Promise<ModelOption[]> {
  const payload = await backendFetch<{ models: BackendModel[] }>("/api/v1/models");
  return payload.models;
}

export function chunkResponseText(response: string) {
  const chunks: string[] = [];
  const tokens = response.split(/(\s+)/).filter(Boolean);
  let current = "";

  for (const token of tokens) {
    if ((current + token).length > 24 && current) {
      chunks.push(current);
      current = token;
    } else {
      current += token;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}
