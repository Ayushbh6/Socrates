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
  ModelOption,
} from "@/lib/chat/types";

const PENDING_FIRST_MESSAGE_KEY = "premchat:pending-first-message:";
const DEFAULT_MODEL = "gpt-5.2";
const DEFAULT_TITLE = "New conversation";

type PendingFirstMessagePayload = {
  content: string;
  model: string;
  thinkingEnabled: boolean;
};

type PendingOptimisticTurn = {
  assistant: ChatMessage;
  user: ChatMessage;
};

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

function dispatchConversationMutated(conversation: {
  id: string;
  title: string;
  provider: string;
  model: string;
  thinkingEnabled: boolean;
}) {
  window.dispatchEvent(
    new CustomEvent("premchat:conversation-mutated", {
      detail: conversation,
    })
  );
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
    initialConversation?.title ?? DEFAULT_TITLE
  );
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState(
    initialConversation?.model ?? DEFAULT_MODEL
  );
  const [thinkingEnabled, setThinkingEnabled] = useState(
    initialConversation?.thinkingEnabled ?? false
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const handledPendingRef = useRef<string | null>(null);
  const hydratedConversationIdRef = useRef<string | null>(
    initialConversation?.id ?? null
  );

  const conversationId = initialConversation?.id;
  const isEmptyState = !conversationId && messages.length === 0;

  useEffect(() => {
    const nextConversationId = initialConversation?.id ?? null;
    if (hydratedConversationIdRef.current === nextConversationId) {
      return;
    }

    hydratedConversationIdRef.current = nextConversationId;
    handledPendingRef.current = null;
    setMessages(initialConversation?.messages ?? []);
    setConversationTitle(initialConversation?.title ?? DEFAULT_TITLE);
    setSelectedModel(initialConversation?.model ?? DEFAULT_MODEL);
    setThinkingEnabled(initialConversation?.thinkingEnabled ?? false);
  }, [initialConversation]);

  useEffect(() => {
    const loadModels = async () => {
      const response = await fetch("/api/models", { cache: "no-store" });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as { models: ModelOption[] };
      setAvailableModels(payload.models);
    };

    void loadModels();
  }, []);

  const createOptimisticTurn = useCallback(
    (targetConversationId: string, content: string): PendingOptimisticTurn => ({
      assistant: createOptimisticMessage(
        targetConversationId,
        "assistant",
        "",
        "streaming"
      ),
      user: createOptimisticMessage(targetConversationId, "user", content, "complete"),
    }),
    []
  );

  const headerTitle = useMemo(() => {
    if (!conversationId) {
      return DEFAULT_TITLE;
    }

    return conversationTitle;
  }, [conversationId, conversationTitle]);

  const sendMessage = useCallback(
    async (
      content: string,
      options?: {
        optimisticTurn?: PendingOptimisticTurn;
        overrideModel?: string;
        overrideThinkingEnabled?: boolean;
      }
    ) => {
      if (!conversationId || isStreaming) {
        return;
      }

      const trimmedContent = content.trim();

      if (!trimmedContent) {
        return;
      }

      const effectiveModel = options?.overrideModel ?? selectedModel;
      const effectiveThinkingEnabled =
        options?.overrideThinkingEnabled ?? thinkingEnabled;
      const optimisticTurn =
        options?.optimisticTurn ?? createOptimisticTurn(conversationId, trimmedContent);
      const { assistant: optimisticAssistant, user: optimisticUser } = optimisticTurn;

      setIsStreaming(true);
      setComposerValue("");

      if (conversationTitle === DEFAULT_TITLE) {
        setConversationTitle(truncateTitle(trimmedContent));
      }

      setMessages((current) => {
        const withoutOptimistic = current.filter(
          (message) =>
            message.id !== optimisticUser.id && message.id !== optimisticAssistant.id
        );
        return [...withoutOptimistic, optimisticUser, optimisticAssistant];
      });

      try {
        const response = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: trimmedContent,
            model: effectiveModel,
            thinkingEnabled: effectiveThinkingEnabled,
          }),
        });

        if (!response.ok || !response.body) {
          let errorMessage = "Unable to send message.";
          try {
            const payload = (await response.json()) as {
              detail?: string;
              error?: string;
            };
            errorMessage = payload.detail || payload.error || errorMessage;
          } catch {
            errorMessage = `Unable to send message (${response.status}).`;
          }
          throw new Error(errorMessage);
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
              setConversationTitle(event.conversationTitle);
              setSelectedModel(event.model);
              setThinkingEnabled(event.thinkingEnabled);
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
              dispatchConversationMutated({
                id: event.conversationId,
                title: event.conversationTitle,
                provider: event.provider,
                model: event.model,
                thinkingEnabled: event.thinkingEnabled,
              });
              continue;
            }

            if (event.type === "reasoning") {
              assistantId = event.assistantMessageId;
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantId
                    ? {
                        ...message,
                        reasoning: event.reasoning,
                      }
                    : message
                )
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
      } catch (error) {
        const fallbackMessage =
          error instanceof Error
            ? error.message
            : "I could not complete the response stream. Please try again.";
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticAssistant.id
              ? {
                  ...message,
                  content: fallbackMessage,
                  status: "error",
                }
              : message
          )
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [
      conversationId,
      conversationTitle,
      createOptimisticTurn,
      isStreaming,
      selectedModel,
      thinkingEnabled,
    ]
  );

  useEffect(() => {
    if (!conversationId) {
      return;
    }

    const handleConversationMutated = (
      event: Event & {
        detail?: {
          id: string;
          title: string;
          provider: string;
          model: string;
          thinkingEnabled: boolean;
        };
      }
    ) => {
      if (!event.detail || event.detail.id !== conversationId) {
        return;
      }

      setConversationTitle(event.detail.title);
      setSelectedModel(event.detail.model);
      setThinkingEnabled(event.detail.thinkingEnabled);
    };

    window.addEventListener(
      "premchat:conversation-mutated",
      handleConversationMutated as EventListener
    );

    return () => {
      window.removeEventListener(
        "premchat:conversation-mutated",
        handleConversationMutated as EventListener
      );
    };
  }, [conversationId]);

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

    let pendingPayload: PendingFirstMessagePayload = {
      content: pendingContent,
      model: selectedModel,
      thinkingEnabled,
    };

    try {
      pendingPayload = JSON.parse(pendingContent) as PendingFirstMessagePayload;
    } catch {
      pendingPayload = {
        content: pendingContent,
        model: selectedModel,
        thinkingEnabled,
      };
    }

    const optimisticTurn = createOptimisticTurn(
      conversationId,
      pendingPayload.content
    );

    setMessages((current) =>
      current.length === 0 ? [optimisticTurn.user, optimisticTurn.assistant] : current
    );
    setConversationTitle(truncateTitle(pendingPayload.content));
    setSelectedModel(pendingPayload.model);
    setThinkingEnabled(pendingPayload.thinkingEnabled);

    void sendMessage(pendingPayload.content, {
      optimisticTurn,
      overrideModel: pendingPayload.model,
      overrideThinkingEnabled: pendingPayload.thinkingEnabled,
    });
  }, [
    conversationId,
    createOptimisticTurn,
    selectedModel,
    sendMessage,
    thinkingEnabled,
  ]);

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
        body: JSON.stringify({
          title: truncateTitle(trimmedContent),
          model: selectedModel,
          thinkingEnabled,
        }),
      });

      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as {
        conversation: { id: string };
      };

      window.sessionStorage.setItem(
        `${PENDING_FIRST_MESSAGE_KEY}${payload.conversation.id}`,
        JSON.stringify({
          content: trimmedContent,
          model: selectedModel,
          thinkingEnabled,
        } satisfies PendingFirstMessagePayload)
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
              models={availableModels}
              onModelChange={setSelectedModel}
              onThinkingEnabledChange={setThinkingEnabled}
              onSubmit={() => {
                void handleSubmit();
              }}
              onValueChange={setComposerValue}
              selectedModel={selectedModel}
              thinkingEnabled={thinkingEnabled}
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
            models={availableModels}
            onModelChange={setSelectedModel}
            onThinkingEnabledChange={setThinkingEnabled}
            onSubmit={() => {
              void handleSubmit();
            }}
            onValueChange={setComposerValue}
            selectedModel={selectedModel}
            thinkingEnabled={thinkingEnabled}
            value={composerValue}
          />
        </>
      )}
    </div>
  );
}
