"use client";

import { BackLink } from "@/components/ui/BackLink";
import { ConversationList } from "@/components/dashboard/ConversationList";
import { InstructionsPanel } from "@/components/dashboard/InstructionsPanel";
import { FilesPanel } from "@/components/dashboard/FilesPanel";
import { StartChatAction } from "@/components/dashboard/StartChatAction";
import { api } from "@/lib/api";
import { truncatePreview } from "@/lib/format";
import type { GetProjectResponse } from "@socrates/contracts";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";

export default function ProjectDashboardPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const router = useRouter();
  const [data, setData] = useState<GetProjectResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploadingResource, setIsUploadingResource] = useState(false);
  const [deletingResourceId, setDeletingResourceId] = useState<string | null>(null);
  const [isSavingInstructions, setIsSavingInstructions] = useState(false);
  const [isStartingChat, setIsStartingChat] = useState(false);
  const [isSavingConversationAction, setIsSavingConversationAction] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function loadInitialProject() {
      setIsLoading(true);
      setError(null);

      try {
        const project = await api.getProject(projectId);
        if (isMounted) {
          setData(project);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Could not load project.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadInitialProject();

    return () => {
      isMounted = false;
    };
  }, [projectId]);

  const handleUploadResources = async (files: File[]) => {
    setUploadError(null);
    setIsUploadingResource(true);

    try {
      const response = await api.uploadProjectResources(projectId, files);
      setData((current) =>
        current
          ? {
              ...current,
              resources: [...response.resources, ...current.resources],
            }
          : current,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not upload files.";
      setUploadError(message);
      throw err;
    } finally {
      setIsUploadingResource(false);
    }
  };

  const handleDeleteResource = async (resourceId: string) => {
    setUploadError(null);
    setDeletingResourceId(resourceId);

    try {
      const response = await api.deleteProjectResource(projectId, resourceId);
      setData((current) =>
        current
          ? {
              ...current,
              resources: current.resources.filter((resource) => resource.id !== response.deletedResourceId),
            }
          : current,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not remove file.";
      setUploadError(message);
      throw err;
    } finally {
      setDeletingResourceId(null);
    }
  };

  const handleSaveInstructions = async (content: string) => {
    setIsSavingInstructions(true);
    try {
      const response = await api.upsertProjectInstructions(projectId, { content });
      setData((current) =>
        current
          ? {
              ...current,
              instructions: response.instructions,
            }
          : current,
      );
    } finally {
      setIsSavingInstructions(false);
    }
  };

  const handleStartNewChat = async () => {
    setError(null);
    setIsStartingChat(true);
    try {
      const response = await api.createConversation(projectId, {});
      router.push(`/projects/${projectId}/chats/${response.conversation.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a new chat.");
    } finally {
      setIsStartingChat(false);
    }
  };

  const handleRenameConversation = async (conversationId: string, title: string) => {
    setIsSavingConversationAction(true);
    try {
      const response = await api.updateConversation(projectId, conversationId, { title });
      setData((current) =>
        current
          ? {
              ...current,
              conversations: current.conversations.map((conversation) =>
                conversation.id === conversationId ? response.conversation : conversation,
              ),
            }
          : current,
      );
    } finally {
      setIsSavingConversationAction(false);
    }
  };

  const handleDeleteConversation = async (conversationId: string) => {
    setIsSavingConversationAction(true);
    try {
      await api.deleteConversation(projectId, conversationId);
      setData((current) =>
        current
          ? {
              ...current,
              conversations: current.conversations.filter((conversation) => conversation.id !== conversationId),
            }
          : current,
      );
    } finally {
      setIsSavingConversationAction(false);
    }
  };

  return (
    <main className="min-h-screen bg-brand-bg py-12 px-6 flex justify-center">
      <div className="w-full max-w-5xl">
        <BackLink href="/projects" label="All projects" />
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12 mt-4">
          {/* Main Column - Left (2/3 width) */}
          <div className="md:col-span-2">
            {isLoading && <p className="text-sm text-brand-text-light">Loading project...</p>}
            {error && <p className="text-sm text-red-600">{error}</p>}
            {data && (
              <>
                <h1 className="text-4xl font-serif text-brand-text-dark mb-2">{data.project.name}</h1>
                {data.project.description && (
                  <p className="line-clamp-2 max-w-2xl text-base leading-7 text-brand-text-light">
                    {truncatePreview(data.project.description, 80)}
                  </p>
                )}
              </>
            )}
            
            <StartChatAction isStarting={isStartingChat} onStart={handleStartNewChat} />
            <ConversationList
              projectId={projectId}
              conversations={data?.conversations ?? []}
              isSavingAction={isSavingConversationAction}
              onRename={handleRenameConversation}
              onDelete={handleDeleteConversation}
            />
          </div>

          {/* Resources Column - Right (1/3 width) */}
          <div className="md:col-span-1 border border-gray-200 bg-white rounded-3xl px-6 pb-2 shadow-sm self-start">
            <InstructionsPanel
              instructions={data?.instructions}
              projectName={data?.project.name ?? "this project"}
              isSaving={isSavingInstructions}
              onSave={handleSaveInstructions}
            />
            {uploadError && <p className="pt-4 text-sm text-red-600">{uploadError}</p>}
            <FilesPanel
              resources={data?.resources ?? []}
              isUploading={isUploadingResource}
              deletingResourceId={deletingResourceId}
              onUpload={data ? handleUploadResources : undefined}
              onDelete={data ? handleDeleteResource : undefined}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
