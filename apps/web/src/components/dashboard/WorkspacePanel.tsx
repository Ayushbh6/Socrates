"use client";

import { useState } from "react";
import { FolderOpen, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { ProjectWorkspace } from "@socrates/contracts";
import { WorkspaceConnectionDialog } from "./WorkspaceConnectionDialog";

export function WorkspacePanel({
  workspace,
  isSaving,
  onSave,
}: {
  workspace?: ProjectWorkspace;
  isSaving: boolean;
  onSave: (input: { workspacePath: string; scaffoldAction?: "use_existing" | "reset" }) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const workspacePath = workspace?.path ?? "";

  return (
    <div className="border-b border-gray-200 py-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderOpen className="size-4 text-brand-teal-dark" />
          <h3 className="font-medium text-brand-text-dark">Workspace</h3>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!workspace || isSaving}
          onClick={() => setIsOpen(true)}
          className="size-6 rounded-full text-brand-text-light hover:bg-gray-100 hover:text-brand-text-dark"
        >
          {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
        </Button>
      </div>
      <p className="break-all font-mono text-xs leading-5 text-brand-text-light">
        {workspacePath || "No workspace connected"}
      </p>

      {isOpen && (
        <WorkspaceConnectionDialog
          title="Edit workspace connection"
          description="Move this Socrates project to another local folder. Existing uploaded resources will be copied into the new workspace."
          initialPath={workspacePath}
          isSaving={isSaving}
          submitLabel="Update workspace"
          onCancel={() => setIsOpen(false)}
          onSave={async (input) => {
            await onSave(input);
            setIsOpen(false);
          }}
        />
      )}
    </div>
  );
}
