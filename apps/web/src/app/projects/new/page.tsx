"use client";

import { Button } from "@/components/ui/Button";
import { ApiClientError, api } from "@/lib/api";
import { FolderOpen, Loader2 } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPickingFolder, setIsPickingFolder] = useState(false);

  const handlePickFolder = async () => {
    setError(null);
    setIsPickingFolder(true);

    try {
      const picked = await api.pickWorkspaceFolder({ mode: "existing_folder" });
      setWorkspacePath(picked.path);
      setFolderName(picked.folderName);
    } catch (err) {
      if (err instanceof ApiClientError && err.error.code === "folder_picker_cancelled") {
        return;
      }
      setError(err instanceof Error ? err.message : "Could not open the folder picker.");
    } finally {
      setIsPickingFolder(false);
    }
  };

  const handleManualPathChange = (value: string) => {
    setWorkspacePath(value);
    setFolderName(folderNameFromPath(value));
  };

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
      });
      router.push(`/projects/${data.project.id}`);
      router.refresh();
    } catch (err) {
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
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handlePickFolder}
                  disabled={isPickingFolder}
                  className="h-10 shrink-0 rounded-xl"
                >
                  {isPickingFolder ? <Loader2 className="mr-2 size-4 animate-spin" /> : <FolderOpen className="mr-2 size-4" />}
                  {isPickingFolder ? "Opening" : "Connect folder"}
                </Button>
              </div>
              <textarea
                rows={workspacePath ? 2 : 1}
                aria-label="Workspace folder path"
                placeholder="Or paste an absolute folder path"
                value={workspacePath}
                onChange={(event) => handleManualPathChange(event.target.value)}
                className="mt-4 w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm leading-relaxed outline-none transition-colors focus:border-brand-teal-dark"
              />
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
      </div>
    </main>
  );
}
