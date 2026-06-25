"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
}: {
  skills: GetProjectResponse["skills"];
  projectName: string;
  isBuilding: boolean;
  deletingSkillName?: string | null;
  onBuild: (input: BuildSkillInput) => Promise<void>;
  onDelete: (skillName: string) => Promise<void>;
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
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-brand-text-dark">{skill.name}</p>
                  <p className="line-clamp-2 text-xs leading-5 text-brand-text-light">{truncatePreview(skill.description, 120)}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void onDelete(skill.name)}
                  disabled={deletingSkillName === skill.name}
                  className="h-8 shrink-0 rounded-lg px-2 text-red-600 hover:bg-red-50 hover:text-red-700"
                  aria-label={`Delete ${skill.name}`}
                >
                  {deletingSkillName === skill.name ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                </Button>
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
        />
      )}
    </div>
  );
}
