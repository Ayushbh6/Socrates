"use client";

import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { GetProjectResponse } from "@socrates/contracts";
import { truncatePreview } from "@/lib/format";
import { InstructionsDialog } from "./InstructionsDialog";

export function InstructionsPanel({
  instructions,
  projectName,
  isSaving,
  onSave,
}: {
  instructions?: GetProjectResponse["instructions"];
  projectName: string;
  isSaving: boolean;
  onSave: (content: string) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const hasInstructions = Boolean(instructions?.content);

  return (
    <div className="border-b border-gray-200 py-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium text-brand-text-dark">Instructions</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setIsOpen(true)}
          className="size-6 text-brand-text-light hover:text-brand-text-dark hover:bg-gray-100 rounded-full"
        >
          {hasInstructions ? <Pencil className="size-4" /> : <Plus className="size-4" />}
        </Button>
      </div>
      <p className="line-clamp-2 text-sm leading-6 text-brand-text-light">
        {hasInstructions
          ? truncatePreview(instructions?.content ?? "", 100)
          : "Add instructions to tailor Socrates's responses"}
      </p>
      {isOpen && (
        <InstructionsDialog
          initialContent={instructions?.content ?? ""}
          projectName={projectName}
          isSaving={isSaving}
          onCancel={() => setIsOpen(false)}
          onSave={async (content) => {
            await onSave(content);
            setIsOpen(false);
          }}
        />
      )}
    </div>
  );
}
