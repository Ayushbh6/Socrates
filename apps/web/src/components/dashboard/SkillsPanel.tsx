"use client";

import { Loader2, Plus, Power, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CommitSkillImportResponse, SkillImportPreview } from "@socrates/contracts";
import { Button } from "@/components/ui/Button";
import type { GetProjectResponse } from "@socrates/contracts";
import { truncatePreview } from "@/lib/format";
import { BuildSkillDialog, type BuildSkillInput } from "./BuildSkillDialog";

export function SkillsPanel({
  skills,
  projectName,
  isBuilding,
  deletingSkillName,
  onBuild,
  onDelete,
  onPreviewImport,
  onCommitImport,
  onToggle,
}: {
  skills: GetProjectResponse["skills"];
  projectName: string;
  isBuilding: boolean;
  deletingSkillName?: string | null;
  onBuild: (input: BuildSkillInput) => Promise<void>;
  onDelete: (skillName: string) => Promise<void>;
  onPreviewImport: (file: File) => Promise<SkillImportPreview>;
  onCommitImport: (preview: SkillImportPreview, replace: boolean) => Promise<CommitSkillImportResponse>;
  onToggle: (skillName: string, enabled: boolean) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-b border-gray-200 py-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="font-medium text-brand-text-dark">Skills</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsOpen(true)}
          className="h-8 rounded-lg px-2 text-brand-text-light hover:bg-gray-100 hover:text-brand-text-dark"
        >
          <Plus className="mr-1 size-4" />
          Skills +
        </Button>
      </div>
      {skills.length > 0 ? (
        <div className="space-y-3">
          {skills.map((skill) => (
            <div key={`${skill.scope}:${skill.name}`} className="rounded-lg border border-gray-100 bg-brand-bg px-3 py-2">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className={skill.enabled === false ? "min-w-0 opacity-50" : "min-w-0"}>
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-brand-text-dark">{skill.name}</p>
                    {skill.source && <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium uppercase text-brand-text-light">{skill.source}</span>}
                  </div>
                  <p className="line-clamp-2 text-xs leading-5 text-brand-text-light">{truncatePreview(skill.description, 120)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1"><Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void onToggle(skill.name, skill.enabled === false)}
                  className={skill.enabled === false ? "h-8 rounded-lg px-2 text-gray-400 hover:bg-gray-100" : "h-8 rounded-lg px-2 text-brand-teal-dark hover:bg-teal-50"}
                  aria-label={`${skill.enabled === false ? "Enable" : "Disable"} ${skill.name}`}
                >
                  <Power className="size-4" />
                </Button><Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void onDelete(skill.name)}
                  disabled={deletingSkillName === skill.name}
                  className="h-8 shrink-0 rounded-lg px-2 text-red-600 hover:bg-red-50 hover:text-red-700"
                  aria-label={`Delete ${skill.name}`}
                >
                  {deletingSkillName === skill.name ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                </Button></div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm leading-6 text-brand-text-light">Build project skills for reusable Socrates workflows.</p>
      )}
      {isOpen && (
        <BuildSkillDialog
          projectName={projectName}
          isBuilding={isBuilding}
          onCancel={() => setIsOpen(false)}
          onBuild={async (input) => {
            await onBuild(input);
            setIsOpen(false);
          }}
          onPreviewImport={onPreviewImport}
          onCommitImport={async (preview, replace) => {
            const response = await onCommitImport(preview, replace);
            setIsOpen(false);
            return response;
          }}
        />
      )}
    </div>
  );
}
