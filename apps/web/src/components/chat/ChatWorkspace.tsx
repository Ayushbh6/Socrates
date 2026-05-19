"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Conversation, GetConversationResponse, Message } from "@socrates/contracts";
import { api } from "@/lib/api";
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
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadChat() {
      setIsLoading(true);
      setError(null);
      try {
        const [conversation, projectsResponse] = await Promise.all([
          api.getConversation(projectId, conversationId),
          api.listProjects(),
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

  const replaceConversationInSidebar = (conversation: Conversation) => {
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
    setIsSending(true);
    setError(null);
    try {
      const response = await api.createConversationMessage(projectId, conversationId, { content });
      setConversationData((current) =>
        current
          ? {
              conversation: response.conversation,
              messages: [...current.messages, response.message],
            }
          : {
              conversation: response.conversation,
              messages: [response.message],
            },
      );
      replaceConversationInSidebar(response.conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send message.");
      throw err;
    } finally {
      setIsSending(false);
    }
  };

  const messages: Message[] = conversationData?.messages ?? [];
  const conversationTitle = conversationData?.conversation.title ?? "New conversation";

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
        </header>
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-brand-text-light">Loading conversation...</div>
        ) : error && !conversationData ? (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-red-600">{error}</div>
        ) : messages.length === 0 ? (
          <EmptyChatState error={error} isSending={isSending} onSend={handleSend} />
        ) : (
          <>
            <ChatTranscript messages={messages} />
            <div className="border-t border-gray-100 bg-white px-6 py-4">
              <div className="mx-auto max-w-3xl">
                {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
                <ChatComposer isSending={isSending} onSend={handleSend} />
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
