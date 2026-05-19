"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientCommand, Conversation, GetConversationResponse, Message, ModelOption, ModelThinkingOption, ServerEvent } from "@socrates/contracts";
import { api } from "@/lib/api";
import { useSocratesSocket } from "@/hooks/useSocratesSocket";
import { ChatComposer } from "./ChatComposer";
import { ChatTranscript } from "./ChatTranscript";
import { EmptyChatState } from "./EmptyChatState";
import { ProjectChatSidebar, type SidebarProject } from "./ProjectChatSidebar";

interface ChatWorkspaceProps {
  projectId: string;
  conversationId: string;
}

export function ChatWorkspace({ projectId, conversationId }: ChatWorkspaceProps) {
  const router = useRouter();
  const [conversationData, setConversationData] = useState<GetConversationResponse | null>(null);
  const [sidebarProjects, setSidebarProjects] = useState<SidebarProject[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const [selectedThinkingOption, setSelectedThinkingOption] = useState<ModelThinkingOption | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [liveThinking, setLiveThinking] = useState("");
  const [liveAnswer, setLiveAnswer] = useState("");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const replaceConversationInSidebar = useCallback((conversation: Conversation) => {
    setSidebarProjects((current) =>
      current.map((item) =>
        item.project.id === conversation.projectId
          ? {
              ...item,
              conversations: item.conversations.map((existing) =>
                existing.id === conversation.id ? conversation : existing,
              ),
            }
          : item,
      ),
    );
  }, []);

  const refreshConversation = useCallback(async () => {
    const conversation = await api.getConversation(projectId, conversationId);
    setConversationData(conversation);
    replaceConversationInSidebar(conversation.conversation);
  }, [projectId, conversationId, replaceConversationInSidebar]);

  const handleSocketEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === "connection.ready") {
        setError(null);
        return;
      }
      if (event.conversationId && event.conversationId !== conversationId) {
        return;
      }

      if (event.type === "turn.started") {
        setActiveTurnId(event.payload.turnId);
        setIsSending(true);
        setConversationData((current) => {
          const messages = current?.messages ?? [];
          const withoutDuplicate = messages.filter((message) => message.id !== event.payload.userMessage.id);
          return current
            ? { ...current, messages: [...withoutDuplicate, event.payload.userMessage] }
            : {
                conversation: {
                  id: conversationId,
                  projectId,
                  title: "New conversation",
                  status: "active",
                  updatedAt: event.timestamp,
                },
                messages: [event.payload.userMessage],
                tokenUsage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
              };
        });
        return;
      }

      if (event.type === "agent.thinking.delta") {
        setLiveThinking((current) => `${current}${event.payload.text}`);
        return;
      }

      if (event.type === "agent.answer.delta") {
        setLiveAnswer((current) => `${current}${event.payload.text}`);
        return;
      }

      if (event.type === "message.completed") {
        setConversationData((current) => {
          if (!current) {
            return current;
          }
          const withoutDuplicate = current.messages.filter((message) => message.id !== event.payload.message.id);
          return { ...current, messages: [...withoutDuplicate, event.payload.message] };
        });
        setLiveAnswer("");
        setLiveThinking("");
        return;
      }

      if (event.type === "turn.completed") {
        setIsSending(false);
        setActiveTurnId(null);
        setLiveAnswer("");
        setLiveThinking("");
        void refreshConversation();
        return;
      }

      if (event.type === "turn.cancelled") {
        setIsSending(false);
        setActiveTurnId(null);
        setLiveAnswer("");
        setLiveThinking("");
        return;
      }

      if (event.type === "turn.failed" || event.type === "error.created") {
        setIsSending(false);
        setActiveTurnId(null);
        setError(event.type === "turn.failed" ? event.payload.error.message : event.payload.error.message);
      }
    },
    [conversationId, projectId, refreshConversation],
  );

  const { isConnected, sendCommand } = useSocratesSocket({
    onEvent: handleSocketEvent,
    onError: setError,
  });

  useEffect(() => {
    let isMounted = true;

    async function loadChat() {
      setIsLoading(true);
      setError(null);
      try {
        const [conversation, projectsResponse, modelsResponse] = await Promise.all([
          api.getConversation(projectId, conversationId),
          api.listProjects(),
          api.listModels(),
        ]);
        const projectConversations = await Promise.all(
          projectsResponse.projects.map(async ({ project }) => ({
            project,
            conversations: (await api.listProjectConversations(project.id)).conversations,
          })),
        );

        if (isMounted) {
          setConversationData(conversation);
          setSidebarProjects(projectConversations);
          setModels(modelsResponse.models);
          const defaultModel =
            modelsResponse.models.find(
              (model) =>
                model.providerId === modelsResponse.defaultModel.providerId &&
                model.modelId === modelsResponse.defaultModel.modelId,
            ) ?? modelsResponse.models[0] ?? null;
          setSelectedModel(defaultModel);
          setSelectedThinkingOption(
            defaultModel?.thinkingOptions.find((option) => option.id === modelsResponse.defaultModel.thinkingOptionId) ??
              defaultModel?.thinkingOptions.find((option) => option.id === defaultModel.defaultThinkingOptionId) ??
              defaultModel?.thinkingOptions[0] ??
              null,
          );
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Could not load conversation.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadChat();

    return () => {
      isMounted = false;
    };
  }, [projectId, conversationId]);

  const handleModelChange = (model: ModelOption) => {
    setSelectedModel(model);
    setSelectedThinkingOption(
      model.thinkingOptions.find((option) => option.id === model.defaultThinkingOptionId) ?? model.thinkingOptions[0] ?? null,
    );
  };

  const handleThinkingChange = (option: ModelThinkingOption) => {
    setSelectedThinkingOption(option);
  };

  const handleStartChat = async (targetProjectId: string) => {
    const response = await api.createConversation(targetProjectId, {});
    setSidebarProjects((current) =>
      current.map((item) =>
        item.project.id === targetProjectId
          ? {
              ...item,
              conversations: [response.conversation, ...item.conversations],
            }
          : item,
      ),
    );
    router.push(`/projects/${targetProjectId}/chats/${response.conversation.id}`);
  };

  const handleSend = async (content: string) => {
    if (!selectedModel || !selectedThinkingOption) {
      setError("Choose a model before sending.");
      return;
    }

    setIsSending(true);
    setError(null);
    setLiveAnswer("");
    setLiveThinking("");
    const clientMessageId = `msg_${crypto.randomUUID()}`;
    try {
      const optimisticMessage: Message = {
        id: clientMessageId,
        conversationId,
        sessionId: "pending",
        role: "user",
        content,
        status: "completed",
        createdAt: new Date().toISOString(),
      };
      setConversationData((current) =>
        current
          ? {
              ...current,
              messages: [...current.messages, optimisticMessage],
            }
          : {
              conversation: {
                id: conversationId,
                projectId,
                title: "New conversation",
                status: "active",
                updatedAt: new Date().toISOString(),
              },
              messages: [optimisticMessage],
              tokenUsage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
            },
      );

      const command: ClientCommand = {
        id: `cmd_${crypto.randomUUID()}`,
        type: "chat.message.send",
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        projectId,
        conversationId,
        actor: { type: "user" },
        payload: {
          clientMessageId,
          content,
          runtimeConfig: {
            providerId: selectedModel.providerId,
            modelId: selectedModel.modelId,
            thinkingEnabled: selectedThinkingOption.enabled,
            ...(selectedThinkingOption.effort ? { thinkingEffort: selectedThinkingOption.effort } : {}),
            approvalMode: "manual",
            sandboxMode: "read_only",
          },
        },
      };
      sendCommand(command);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send message.");
      setIsSending(false);
      throw err;
    }
  };

  const handleStop = () => {
    if (!activeTurnId) {
      return;
    }

    const command: ClientCommand = {
      id: `cmd_${crypto.randomUUID()}`,
      type: "chat.turn.cancel",
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      projectId,
      conversationId,
      actor: { type: "user" },
      payload: {
        turnId: activeTurnId,
        reason: "User stopped the response.",
      },
    };
    sendCommand(command);
  };

  const messages: Message[] = conversationData?.messages ?? [];
  const conversationTitle = conversationData?.conversation.title ?? "New conversation";
  const tokenTotal = conversationData?.tokenUsage.totalTokens ?? 0;
  const tokenLabel = useMemo(() => `${tokenTotal.toLocaleString()} ${tokenTotal === 1 ? "token" : "tokens"}`, [tokenTotal]);

  return (
    <main className="flex h-screen bg-brand-bg">
      <ProjectChatSidebar
        projects={sidebarProjects}
        currentProjectId={projectId}
        currentConversationId={conversationId}
        isCollapsed={isSidebarCollapsed}
        onCollapse={() => setIsSidebarCollapsed(true)}
        onExpand={() => setIsSidebarCollapsed(false)}
        onStartChat={handleStartChat}
      />
      <section className="flex min-w-0 flex-1 flex-col bg-white">
        <header
          className={`flex h-14 shrink-0 items-center border-b border-gray-200 ${
            isSidebarCollapsed ? "pl-16 pr-6" : "px-6"
          }`}
        >
          <h1 className="truncate text-sm font-medium text-brand-text-dark">{conversationTitle}</h1>
          <span className="ml-4 shrink-0 font-mono text-xs text-brand-text-light">{tokenLabel}</span>
        </header>
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-brand-text-light">Loading conversation...</div>
        ) : error && !conversationData ? (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-red-600">{error}</div>
        ) : messages.length === 0 ? (
          <EmptyChatState
            error={error}
            isSending={isSending}
            isConnected={isConnected}
            models={models}
            selectedModel={selectedModel}
            selectedThinkingOption={selectedThinkingOption}
            onModelChange={handleModelChange}
            onThinkingChange={handleThinkingChange}
            onSend={handleSend}
            onStop={handleStop}
          />
        ) : (
          <>
            <ChatTranscript messages={messages} liveThinking={liveThinking} liveAnswer={liveAnswer} isStreaming={isSending} />
            <div className="border-t border-gray-100 bg-white px-6 py-4">
              <div className="mx-auto max-w-3xl">
                {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
                <ChatComposer
                  isSending={isSending}
                  isConnected={isConnected}
                  models={models}
                  selectedModel={selectedModel}
                  selectedThinkingOption={selectedThinkingOption}
                  onModelChange={handleModelChange}
                  onThinkingChange={handleThinkingChange}
                  onSend={handleSend}
                  onStop={handleStop}
                />
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
