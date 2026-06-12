"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { GetProjectResponse } from "@socrates/contracts";
import { truncatePreview } from "@/lib/format";
import { BuildSkillDialog } from "./BuildSkillDialog";

export function SkillsPanel({
  skills,
  projectName,
  isBuilding,
  onBuild,
}: {
  skills: GetProjectResponse["skills"];
  projectName: string;
  isBuilding: boolean;
  onBuild: (request: string) => Promise<void>;
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
          {skills.slice(0, 4).map((skill) => (
            <div key={`${skill.scope}:${skill.name}`} className="rounded-lg border border-gray-100 bg-brand-bg px-3 py-2">
              <p className="text-sm font-medium text-brand-text-dark">{skill.name}</p>
              <p className="line-clamp-2 text-xs leading-5 text-brand-text-light">{truncatePreview(skill.description, 120)}</p>
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
          onBuild={async (request) => {
            await onBuild(request);
            setIsOpen(false);
          }}
        />
      )}
    </div>
  );
}
