"use client";

import { BackLink } from "@/components/ui/BackLink";
import { DashboardComposer } from "@/components/dashboard/DashboardComposer";
import { ConversationList } from "@/components/dashboard/ConversationList";
import { InstructionsPanel } from "@/components/dashboard/InstructionsPanel";
import { FilesPanel } from "@/components/dashboard/FilesPanel";
import { api } from "@/lib/api";
import type { GetProjectResponse } from "@socrates/contracts";
import { use, useCallback, useEffect, useState } from "react";

export default function ProjectDashboardPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const [data, setData] = useState<GetProjectResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploadingResource, setIsUploadingResource] = useState(false);

  const loadProject = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const project = await api.getProject(projectId);
      setData(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load project.");
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

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

  const handleUploadResource = async (file: File) => {
    setUploadError(null);
    setIsUploadingResource(true);

    try {
      await api.uploadProjectResource(projectId, file);
      await loadProject();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not upload file.");
    } finally {
      setIsUploadingResource(false);
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
                  <p className="text-brand-text-light text-base">{data.project.description}</p>
                )}
              </>
            )}
            
            <DashboardComposer />
            <ConversationList projectId={projectId} conversations={data?.conversations ?? []} />
          </div>

          {/* Resources Column - Right (1/3 width) */}
          <div className="md:col-span-1 border border-gray-200 bg-white rounded-3xl px-6 pb-2 shadow-sm self-start">
            <InstructionsPanel instructions={data?.instructions} />
            {uploadError && <p className="pt-4 text-sm text-red-600">{uploadError}</p>}
            <FilesPanel
              resources={data?.resources ?? []}
              isUploading={isUploadingResource}
              onUpload={data ? handleUploadResource : undefined}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
