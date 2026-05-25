"use client";

import { FormEvent, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { ApiClientError, api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { InspectWorkspaceResponse } from "@socrates/contracts";

type WorkspaceSubmitInput = {
  workspacePath: string;
  scaffoldAction?: "use_existing" | "reset";
};

const folderNameFromPath = (workspacePath: string) =>
  workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "";

export function WorkspaceConnectionDialog({
  title,
  description,
  initialPath = "",
  isSaving,
  submitLabel,
  onCancel,
  onSave,
}: {
  title: string;
  description: string;
  initialPath?: string;
  isSaving: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSave: (input: WorkspaceSubmitInput) => Promise<void>;
}) {
  const [workspacePath, setWorkspacePath] = useState(initialPath);
  const [folderName, setFolderName] = useState(folderNameFromPath(initialPath));
  const [inspection, setInspection] = useState<InspectWorkspaceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isInspecting, setIsInspecting] = useState(false);
  const trimmedPath = workspacePath.trim();

  const handlePickFolder = async () => {
    setError(null);
    setInspection(null);
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

  const handlePathChange = (value: string) => {
    setWorkspacePath(value);
    setFolderName(folderNameFromPath(value));
    setInspection(null);
  };

  const saveWithAction = async (scaffoldAction?: "use_existing" | "reset") => {
    setError(null);
    try {
      await onSave({ workspacePath: trimmedPath, ...(scaffoldAction ? { scaffoldAction } : {}) });
    } catch (err) {
      if (err instanceof ApiClientError && err.error.code === "workspace_scaffold_action_required") {
        const details = err.error.details as InspectWorkspaceResponse | undefined;
        if (details) {
          setInspection(details);
        }
        setError(null);
        return;
      }
      setError(err instanceof Error ? err.message : "Could not save workspace.");
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedPath) {
      setError("Connect a workspace folder before continuing.");
      return;
    }

    setError(null);
    setIsInspecting(true);
    try {
      const inspected = await api.inspectWorkspace({ workspacePath: trimmedPath });
      setInspection(inspected);
      if (inspected.hasSocratesDir) {
        return;
      }
      await saveWithAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not inspect workspace.");
    } finally {
      setIsInspecting(false);
    }
  };

  const isBusy = isSaving || isPickingFolder || isInspecting;

  return (
    <Modal
      title={title}
      description={description}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isBusy}>
            Cancel
          </Button>
          {inspection?.hasSocratesDir ? (
            <>
              <Button type="button" variant="outline" disabled={isBusy} onClick={() => void saveWithAction("use_existing")}>
                Use existing
              </Button>
              <Button type="button" variant="destructive" disabled={isBusy} onClick={() => void saveWithAction("reset")}>
                Delete and create fresh
              </Button>
            </>
          ) : (
            <Button type="submit" form="workspace-connection-form" disabled={isBusy || !trimmedPath}>
              {(isSaving || isInspecting) && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isInspecting ? "Checking" : submitLabel}
            </Button>
          )}
        </>
      }
    >
      <form id="workspace-connection-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-brand-bg p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-brand-text-dark">{folderName || "No folder connected"}</p>
              <p className="mt-1 truncate text-xs text-brand-text-light">
                {trimmedPath || "Pick a folder or paste an absolute path."}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handlePickFolder}
              disabled={isBusy}
              className="h-10 shrink-0 rounded-xl"
            >
              {isPickingFolder ? <Loader2 className="mr-2 size-4 animate-spin" /> : <FolderOpen className="mr-2 size-4" />}
              {isPickingFolder ? "Opening" : "Choose folder"}
            </Button>
          </div>
          <textarea
            rows={trimmedPath ? 2 : 1}
            aria-label="Workspace folder path"
            placeholder="Or paste an absolute folder path"
            value={workspacePath}
            onChange={(event) => handlePathChange(event.target.value)}
            className="mt-4 w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-sm leading-relaxed outline-none transition-colors focus:border-brand-teal-dark"
          />
        </div>

        {inspection?.hasSocratesDir && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            <p className="font-medium">A `.socrates` folder already exists here.</p>
            <p className="mt-1">
              Use existing keeps current Socrates files and appends future resources. Delete and create fresh removes only this
              folder&apos;s `.socrates` directory, then recreates `.socrates/resources`.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </Modal>
  );
}
