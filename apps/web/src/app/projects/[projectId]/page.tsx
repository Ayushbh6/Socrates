"use client";

import { BackLink } from "@/components/ui/BackLink";
import { ConversationList } from "@/components/dashboard/ConversationList";
import { InstructionsPanel } from "@/components/dashboard/InstructionsPanel";
import { FilesPanel } from "@/components/dashboard/FilesPanel";
import { StartChatAction } from "@/components/dashboard/StartChatAction";
import { SemanticSearchPanel } from "@/components/dashboard/SemanticSearchPanel";
import { SkillsPanel } from "@/components/dashboard/SkillsPanel";
import { WorkspacePanel } from "@/components/dashboard/WorkspacePanel";
import { McpServersPanel } from "@/components/mcp/McpServersPanel";
import { V2ViewLink } from "@/components/v2/V2ViewLink";
import { api } from "@/lib/api";
import { truncatePreview } from "@/lib/format";
import type { CommitSkillImportResponse, GetProjectResponse, SkillImportPreview } from "@socrates/contracts";
import type { BuildSkillInput } from "@/components/dashboard/BuildSkillDialog";
import { ArrowUpRight, Waypoints } from "lucide-react";
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
  const [isBuildingSkill, setIsBuildingSkill] = useState(false);
  const [deletingSkillName, setDeletingSkillName] = useState<string | null>(null);
  const [isStartingChat, setIsStartingChat] = useState(false);
  const [isSavingConversationAction, setIsSavingConversationAction] = useState(false);
  const [isSavingWorkspace, setIsSavingWorkspace] = useState(false);

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

  const handleBuildSkill = async (input: BuildSkillInput) => {
    setIsBuildingSkill(true);
    setUploadError(null);
    try {
      const response = await api.buildProjectSkill(projectId, input);
      setData((current) =>
        current
          ? {
              ...current,
              skills: [response.skill, ...current.skills.filter((skill) => skill.name !== response.skill.name)],
            }
          : current,
      );
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not build skill.");
      throw err;
    } finally {
      setIsBuildingSkill(false);
    }
  };

  const handleDeleteSkill = async (skillName: string) => {
    setDeletingSkillName(skillName);
    setUploadError(null);
    try {
      const response = await api.deleteProjectSkill(projectId, skillName);
      setData((current) =>
        current
          ? {
              ...current,
              skills: current.skills.filter((skill) => skill.name !== response.deletedSkillName),
            }
          : current,
      );
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not delete skill.");
      throw err;
    } finally {
      setDeletingSkillName(null);
    }
  };

  const handlePreviewSkillImport = (file: File): Promise<SkillImportPreview> => api.previewProjectSkillImport(projectId, file);

  const handleCommitSkillImport = async (preview: SkillImportPreview, replace: boolean): Promise<CommitSkillImportResponse> => {
    setUploadError(null);
    try {
      const response = await api.commitProjectSkillImport(projectId, {
        previewId: preview.previewId,
        conflictStrategy: replace ? "replace" : "reject",
      });
      setData((current) => current ? { ...current, skills: [response.skill, ...current.skills.filter((skill) => skill.name !== response.skill.name)] } : current);
      return response;
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not import skill.");
      throw err;
    }
  };

  const handleToggleSkill = async (skillName: string, enabled: boolean) => {
    setUploadError(null);
    try {
      const response = await api.updateProjectSkillState(projectId, skillName, enabled);
      setData((current) => current ? { ...current, skills: current.skills.map((skill) => skill.name === skillName ? response.skill : skill) } : current);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not update skill.");
      throw err;
    }
  };

  const handleEmbeddingStatusChange = (embeddingStatus: NonNullable<GetProjectResponse["embeddingStatus"]>) => {
    setData((current) =>
      current
        ? {
            ...current,
            embeddingStatus,
          }
        : current,
    );
  };

  const handleSaveWorkspace = async (input: { workspacePath: string; scaffoldAction?: "use_existing" | "reset" }) => {
    setIsSavingWorkspace(true);
    setUploadError(null);
    try {
      const response = await api.updateProjectWorkspace(projectId, {
        workspacePath: input.workspacePath,
        creationMode: "existing_folder",
        ...(input.scaffoldAction ? { scaffoldAction: input.scaffoldAction } : {}),
      });
      setData((current) =>
        current
          ? {
              ...current,
              primaryWorkspace: response.primaryWorkspace,
              resources: response.resources,
            }
          : current,
      );
    } finally {
      setIsSavingWorkspace(false);
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

  const handleDeleteConversation = async (conversationId: string, scope: "classic_only" | "everywhere") => {
    setIsSavingConversationAction(true);
    try {
      await api.deleteConversation(projectId, conversationId, scope);
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
    <main className="flex min-h-screen justify-center overflow-y-auto bg-brand-bg px-6 py-10 md:h-screen md:overflow-hidden">
      <div className="w-full max-w-6xl md:flex md:min-h-0 md:flex-col">
        <div className="flex shrink-0 items-center justify-between gap-4">
          <BackLink href="/projects" label="All projects" />
          <V2ViewLink
            view="seamless"
            href={`/seamless/projects/${encodeURIComponent(projectId)}`}
            className="inline-flex min-h-10 items-center gap-2 rounded-full border border-[#b9ddd8] bg-[#f4fbf9] px-4 text-sm font-medium text-brand-text-dark shadow-sm transition-colors hover:border-[#74c8c1] hover:bg-[#eaf7f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-teal-dark/30 data-[v2-availability=checking]:cursor-wait data-[v2-availability=disabled]:cursor-not-allowed data-[v2-availability=disabled]:opacity-50"
          >
            <Waypoints className="size-4 text-brand-teal-dark" aria-hidden="true" />
            <span className="hidden sm:inline">Go to Flow View</span>
            <span className="sm:hidden">Flow View</span>
            <ArrowUpRight className="size-3.5 text-brand-text-light" aria-hidden="true" />
          </V2ViewLink>
        </div>
        
        <div className="mt-4 grid grid-cols-1 gap-10 md:min-h-0 md:flex-1 md:grid-cols-[minmax(0,1fr)_360px]">
          {/* Main Column - Left (2/3 width) */}
          <div className="flex min-h-0 flex-col">
            {isLoading && <p className="text-sm text-brand-text-light">Loading project...</p>}
            {error && <p className="text-sm text-red-600">{error}</p>}
            {data && (
              <div className="shrink-0">
                <h1 className="text-4xl font-serif text-brand-text-dark mb-2">{data.project.name}</h1>
                {data.project.description && (
                  <p className="line-clamp-2 max-w-2xl text-base leading-7 text-brand-text-light">
                    {truncatePreview(data.project.description, 80)}
                  </p>
                )}
              </div>
            )}
            
            <StartChatAction isStarting={isStartingChat} onStart={handleStartNewChat} />
            <ConversationList
              projectId={projectId}
              conversations={data?.conversations ?? []}
              isSavingAction={isSavingConversationAction}
              onRename={handleRenameConversation}
              onGetDeletionImpact={(conversationId) => api.getConversationDeletionImpact(projectId, conversationId)}
              onDelete={handleDeleteConversation}
            />
          </div>

          {/* Resources Column - Right (1/3 width) */}
          <div className="min-h-0 overflow-y-auto rounded-3xl border border-gray-200 bg-white px-6 pb-2 shadow-sm">
            <WorkspacePanel
              workspace={data?.primaryWorkspace}
              isSaving={isSavingWorkspace}
              onSave={handleSaveWorkspace}
            />
            <InstructionsPanel
              instructions={data?.instructions}
              projectName={data?.project.name ?? "this project"}
              isSaving={isSavingInstructions}
              onSave={handleSaveInstructions}
            />
            <SkillsPanel
              skills={data?.skills ?? []}
              projectName={data?.project.name ?? "this project"}
              isBuilding={isBuildingSkill}
              deletingSkillName={deletingSkillName}
              onBuild={handleBuildSkill}
              onDelete={handleDeleteSkill}
              onPreviewImport={handlePreviewSkillImport}
              onCommitImport={handleCommitSkillImport}
              onToggle={handleToggleSkill}
            />
            <McpServersPanel
              scope="project"
              projectId={projectId}
              title="MCP servers"
              description="Project-specific MCP tools, with global servers inherited automatically."
            />
            {data && (
              <SemanticSearchPanel
                projectId={projectId}
                status={data.embeddingStatus}
                onStatusChange={handleEmbeddingStatusChange}
              />
            )}
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
