import type {
  ChatMessage,
  Conversation,
  ConversationSummary,
} from "@/lib/chat/types";

type ConversationStore = {
  conversations: Map<string, Conversation>;
};

const STORE_KEY = "__premchat_conversation_store__";

function truncate(text: string, length: number) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length <= length) {
    return normalized;
  }

  return `${normalized.slice(0, length - 1).trimEnd()}…`;
}

function cloneConversation<T>(value: T): T {
  return structuredClone(value);
}

function getStore(): ConversationStore {
  const globalScope = globalThis as typeof globalThis & {
    [STORE_KEY]?: ConversationStore;
  };

  if (!globalScope[STORE_KEY]) {
    globalScope[STORE_KEY] = {
      conversations: new Map<string, Conversation>(),
    };

    seedStore(globalScope[STORE_KEY]);
  }

  return globalScope[STORE_KEY];
}

function createTimestamp(offsetMinutes = 0) {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

function createMessage(
  conversationId: string,
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"] = "complete"
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    conversationId,
    role,
    content,
    createdAt: createTimestamp(),
    status,
  };
}

function seedConversation(
  id: string,
  title: string,
  exchanges: Array<{ user: string; assistant: string }>,
  updatedAtOffsetMinutes: number
): Conversation {
  const createdAt = createTimestamp(updatedAtOffsetMinutes - 20);
  const messages: ChatMessage[] = [];

  for (const exchange of exchanges) {
    messages.push(createMessage(id, "user", exchange.user));
    messages.push(createMessage(id, "assistant", exchange.assistant));
  }

  return {
    id,
    title,
    createdAt,
    updatedAt: createTimestamp(updatedAtOffsetMinutes),
    messages,
  };
}

function seedStore(store: ConversationStore) {
  const conversations = [
    seedConversation(
      crypto.randomUUID(),
      "Neural sync review",
      [
        {
          user: "Summarize the current state of my workspace rhythm.",
          assistant:
            "Your workspace rhythm is steady and low-friction. Deep-focus blocks are longer, interruptions are clustered earlier in the day, and open loops are decreasing.",
        },
      ],
      -180
    ),
    seedConversation(
      crypto.randomUUID(),
      "Workspace layout",
      [
        {
          user: "What should I reorganize in the workspace first?",
          assistant:
            "Start with the surfaces you touch most often: active project list, daily notes, and message triage. Leave long-tail cleanup for later so momentum stays intact.",
        },
      ],
      -90
    ),
  ];

  for (const conversation of conversations) {
    store.conversations.set(conversation.id, conversation);
  }
}

function getConversationOrThrow(id: string) {
  const conversation = getStore().conversations.get(id);

  if (!conversation) {
    throw new Error("Conversation not found.");
  }

  return conversation;
}

export function listConversations(): ConversationSummary[] {
  return Array.from(getStore().conversations.values())
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((conversation) => {
      const lastMessage = conversation.messages.at(-1);

      return {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        preview: lastMessage ? truncate(lastMessage.content, 72) : "New conversation",
        messageCount: conversation.messages.length,
      };
    });
}

export function getConversation(id: string) {
  const conversation = getStore().conversations.get(id);
  return conversation ? cloneConversation(conversation) : null;
}

export function createConversation(title = "New conversation") {
  const now = createTimestamp();
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };

  getStore().conversations.set(conversation.id, conversation);
  return cloneConversation(conversation);
}

export function addUserMessage(conversationId: string, content: string) {
  const conversation = getConversationOrThrow(conversationId);
  const message = createMessage(conversationId, "user", content);

  conversation.messages.push(message);
  conversation.updatedAt = message.createdAt;

  if (
    conversation.title === "New conversation" ||
    conversation.messages.filter((entry) => entry.role === "user").length === 1
  ) {
    conversation.title = truncate(content, 48);
  }

  return cloneConversation(message);
}

export function createAssistantMessage(conversationId: string) {
  const conversation = getConversationOrThrow(conversationId);
  const message = createMessage(conversationId, "assistant", "", "streaming");

  conversation.messages.push(message);
  conversation.updatedAt = message.createdAt;

  return cloneConversation(message);
}

export function appendAssistantDelta(
  conversationId: string,
  messageId: string,
  delta: string
) {
  const conversation = getConversationOrThrow(conversationId);
  const message = conversation.messages.find((entry) => entry.id === messageId);

  if (!message) {
    throw new Error("Assistant message not found.");
  }

  message.content += delta;
  conversation.updatedAt = createTimestamp();
}

export function completeAssistantMessage(
  conversationId: string,
  messageId: string
) {
  const conversation = getConversationOrThrow(conversationId);
  const message = conversation.messages.find((entry) => entry.id === messageId);

  if (!message) {
    throw new Error("Assistant message not found.");
  }

  message.status = "complete";
  conversation.updatedAt = createTimestamp();
}

export function markAssistantMessageError(
  conversationId: string,
  messageId: string,
  fallbackMessage: string
) {
  const conversation = getConversationOrThrow(conversationId);
  const message = conversation.messages.find((entry) => entry.id === messageId);

  if (!message) {
    throw new Error("Assistant message not found.");
  }

  message.content = fallbackMessage;
  message.status = "error";
  conversation.updatedAt = createTimestamp();
}

export function generateAssistantResponse(
  conversation: Conversation,
  prompt: string
) {
  const normalizedPrompt = truncate(prompt, 220);
  const conversationDepth = Math.max(
    1,
    conversation.messages.filter((message) => message.role === "user").length
  );

  return [
    `I am holding your question in the current workspace context: “${normalizedPrompt}”.`,
    `At this point in the conversation, the clearest next move is to answer directly, keep the signal high, and avoid introducing extra complexity before it is useful.`,
    `If you want, I can keep going from here with a sharper recommendation, a step-by-step plan, or a concise summary tuned to thread depth ${conversationDepth}.`,
  ].join(" ");
}

export function chunkAssistantResponse(response: string) {
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
