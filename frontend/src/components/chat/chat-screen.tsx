"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChatDisplay } from "@/components/chat/chat-display";
import { ChatFooter } from "@/components/chat/chat-footer";
import { ChatHeader } from "@/components/chat/chat-header";
import type {
  ChatMessage,
  ChatStreamEvent,
  Conversation,
} from "@/lib/chat/types";

const PENDING_FIRST_MESSAGE_KEY = "premchat:pending-first-message:";

function createOptimisticMessage(
  conversationId: string,
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"]
): ChatMessage {
  return {
    id: `optimistic-${crypto.randomUUID()}`,
    conversationId,
    role,
    content,
    createdAt: new Date().toISOString(),
    status,
  };
}

function truncateTitle(text: string) {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length > 48 ? `${normalized.slice(0, 47).trimEnd()}…` : normalized;
}

function dispatchConversationChange() {
  window.dispatchEvent(new CustomEvent("premchat:conversations-changed"));
}

type ChatScreenProps = {
  initialConversation?: Conversation | null;
};

export function ChatScreen({ initialConversation = null }: ChatScreenProps) {
  const router = useRouter();
  const [composerValue, setComposerValue] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(
    initialConversation?.messages ?? []
  );
  const [conversationTitle, setConversationTitle] = useState(
    initialConversation?.title ?? "New conversation"
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const handledPendingRef = useRef<string | null>(null);

  const conversationId = initialConversation?.id;
  const isEmptyState = !conversationId && messages.length === 0;

  useEffect(() => {
    setMessages(initialConversation?.messages ?? []);
    setConversationTitle(initialConversation?.title ?? "New conversation");
  }, [initialConversation]);

  const headerTitle = useMemo(() => {
    if (!conversationId) {
      return "New conversation";
    }

    return conversationTitle;
  }, [conversationId, conversationTitle]);

  const sendMessage = useCallback(async (content: string) => {
    if (!conversationId || isStreaming) {
      return;
    }

    const trimmedContent = content.trim();

    if (!trimmedContent) {
      return;
    }

    setIsStreaming(true);
    setComposerValue("");

    if (conversationTitle === "New conversation") {
      setConversationTitle(truncateTitle(trimmedContent));
    }

    const optimisticUser = createOptimisticMessage(
      conversationId,
      "user",
      trimmedContent,
      "complete"
    );
    const optimisticAssistant = createOptimisticMessage(
      conversationId,
      "assistant",
      "",
      "streaming"
    );

    setMessages((current) => [...current, optimisticUser, optimisticAssistant]);

    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: trimmedContent }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Unable to send message.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantId = optimisticAssistant.id;

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const event = JSON.parse(line) as ChatStreamEvent;

          if (event.type === "meta") {
            assistantId = event.assistantMessage.id;
            setMessages((current) =>
              current.map((message) => {
                if (message.id === optimisticUser.id) {
                  return event.userMessage;
                }

                if (message.id === optimisticAssistant.id) {
                  return event.assistantMessage;
                }

                return message;
              })
            );
            continue;
          }

          if (event.type === "delta") {
            assistantId = event.assistantMessageId;
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      content: `${message.content}${event.delta}`,
                    }
                  : message
              )
            );
            continue;
          }

          if (event.type === "done") {
            setMessages((current) =>
              current.map((message) =>
                message.id === event.assistantMessageId
                  ? { ...message, status: "complete" }
                  : message
              )
            );
            continue;
          }

          if (event.type === "error") {
            setMessages((current) =>
              current.map((message) =>
                message.id === event.assistantMessageId
                  ? {
                      ...message,
                      content: event.message,
                      status: "error",
                    }
                  : message
              )
            );
          }
        }

        if (done) {
          break;
        }
      }

      dispatchConversationChange();
    } catch {
      setMessages((current) =>
        current.map((message) =>
          message.id === optimisticAssistant.id
            ? {
                ...message,
                content:
                  "I could not complete the response stream. Please try again.",
                status: "error",
              }
            : message
        )
      );
    } finally {
      setIsStreaming(false);
    }
  }, [conversationId, conversationTitle, isStreaming]);

  useEffect(() => {
    if (!conversationId) {
      return;
    }

    const key = `${PENDING_FIRST_MESSAGE_KEY}${conversationId}`;

    if (handledPendingRef.current === key) {
      return;
    }

    const pendingContent = window.sessionStorage.getItem(key);

    if (!pendingContent) {
      return;
    }

    handledPendingRef.current = key;
    window.sessionStorage.removeItem(key);
    void sendMessage(pendingContent);
  }, [conversationId, sendMessage]);

  const handleSubmit = async () => {
    const trimmedContent = composerValue.trim();

    if (!trimmedContent || isStreaming) {
      return;
    }

    if (!conversationId) {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: truncateTitle(trimmedContent) }),
      });

      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as {
        conversation: { id: string };
      };

      window.sessionStorage.setItem(
        `${PENDING_FIRST_MESSAGE_KEY}${payload.conversation.id}`,
        trimmedContent
      );
      dispatchConversationChange();
      router.push(`/chat/${payload.conversation.id}`);
      return;
    }

    await sendMessage(trimmedContent);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <ChatHeader conversationId={conversationId ?? undefined} title={headerTitle} />

      {isEmptyState ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-[max(2rem,8svh)] sm:px-6">
          <div className="flex w-full max-w-4xl flex-col items-center gap-8 sm:gap-10">
            <ChatDisplay isEmptyState isStreaming={false} messages={messages} />
            <ChatFooter
              isCentered
              disabled={false}
              isStreaming={false}
              onSubmit={() => {
                void handleSubmit();
              }}
              onValueChange={setComposerValue}
              value={composerValue}
            />
          </div>
        </div>
      ) : (
        <>
          <ChatDisplay
            isEmptyState={false}
            isStreaming={isStreaming}
            messages={messages}
          />
          <ChatFooter
            disabled={isStreaming}
            isStreaming={isStreaming}
            onSubmit={() => {
              void handleSubmit();
            }}
            onValueChange={setComposerValue}
            value={composerValue}
          />
        </>
      )}
    </div>
  );
}
