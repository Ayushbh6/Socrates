"use client";

import { Button } from "@/components/ui/Button";
import { ApiClientError, api } from "@/lib/api";
import { WorkspaceConnectionDialog } from "@/components/dashboard/WorkspaceConnectionDialog";
import { FolderOpen } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

const folderNameFromPath = (workspacePath: string) =>
  workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "";

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [folderName, setFolderName] = useState("");
  const [scaffoldAction, setScaffoldAction] = useState<"use_existing" | "reset" | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isWorkspaceDialogOpen, setIsWorkspaceDialogOpen] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedName = name.trim();
    const trimmedWorkspacePath = workspacePath.trim();
    if (!trimmedName) {
      setError("Name your project before continuing.");
      return;
    }
    if (!trimmedWorkspacePath) {
      setError("Connect a workspace folder before creating the project.");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const data = await api.createProject({
        name: trimmedName,
        description: description.trim() || undefined,
        creationMode: "existing_folder",
        workspacePath: trimmedWorkspacePath,
        ...(scaffoldAction ? { scaffoldAction } : {}),
      });
      router.push(`/projects/${data.project.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError && err.error.code === "workspace_scaffold_action_required") {
        setIsWorkspaceDialogOpen(true);
        setError("Confirm how Socrates should handle the existing .socrates folder.");
        return;
      }
      setError(err instanceof Error ? err.message : "Could not create project.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-brand-bg flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <h1 className="text-4xl font-serif text-brand-text-dark mb-10 text-center">Create a personal project</h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            <label className="text-base text-brand-text-dark">What are you working on?</label>
            <input
              type="text"
              placeholder="Name your project"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="px-4 py-4 bg-white border border-gray-200 rounded-xl outline-none focus:border-brand-teal-dark shadow-sm transition-colors text-base"
            />
          </div>

          <div className="flex flex-col gap-3">
            <label className="text-base text-brand-text-dark">What are you trying to achieve?</label>
            <textarea
              placeholder="Describe your project, goals, subject, etc..."
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="px-4 py-4 bg-white border border-gray-200 rounded-xl outline-none focus:border-brand-teal-dark shadow-sm transition-colors text-base resize-none h-40"
            />
          </div>

          <div className="flex flex-col gap-3">
            <label className="text-base text-brand-text-dark">Workspace folder</label>
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-brand-text-dark">
                    {folderName || "No folder connected"}
                  </p>
                  <p className="mt-1 truncate text-xs text-brand-text-light">
                    {workspacePath || "Socrates will create .socrates/resources inside this folder."}
                  </p>
                  {scaffoldAction && (
                    <p className="mt-1 text-xs text-brand-text-light">
                      Existing .socrates choice: {scaffoldAction === "use_existing" ? "use existing" : "delete and create fresh"}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsWorkspaceDialogOpen(true)}
                  className="h-10 shrink-0 rounded-xl"
                >
                  <FolderOpen className="mr-2 size-4" />
                  {workspacePath ? "Edit folder" : "Connect folder"}
                </Button>
              </div>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-3 mt-4">
            <Button asChild variant="ghost" className="rounded-xl px-6 h-12 text-base text-brand-text-dark hover:bg-gray-100">
              <Link href="/projects">
                Cancel
              </Link>
            </Button>
            <Button type="submit" disabled={isSubmitting || !name.trim() || !workspacePath.trim()} className="rounded-xl px-6 h-12 text-base">
              {isSubmitting ? "Creating" : "Create project"}
            </Button>
          </div>
        </form>
        {isWorkspaceDialogOpen && (
          <WorkspaceConnectionDialog
            title="Connect workspace"
            description="Choose the local folder Socrates should use for this project."
            initialPath={workspacePath}
            isSaving={false}
            submitLabel="Use this folder"
            onCancel={() => setIsWorkspaceDialogOpen(false)}
            onSave={async ({ workspacePath: selectedPath, scaffoldAction: selectedAction }) => {
              setWorkspacePath(selectedPath);
              setFolderName(folderNameFromPath(selectedPath));
              setScaffoldAction(selectedAction);
              setIsWorkspaceDialogOpen(false);
            }}
          />
        )}
      </div>
    </main>
  );
}
