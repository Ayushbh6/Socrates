"use client";

import { useState } from "react";
import type { Conversation, Project } from "@socrates/contracts";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { SidebarProjectSection } from "./SidebarProjectSection";

export type SidebarProject = {
  project: Project;
  conversations: Conversation[];
};

interface ProjectChatSidebarProps {
  projects: SidebarProject[];
  currentProjectId: string;
  currentConversationId: string;
  isCollapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onStartChat: (projectId: string) => Promise<void>;
}

export function ProjectChatSidebar({
  projects,
  currentProjectId,
  currentConversationId,
  isCollapsed,
  onCollapse,
  onExpand,
  onStartChat,
}: ProjectChatSidebarProps) {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());

  if (isCollapsed) {
    return (
      <button
        type="button"
        aria-label="Expand project sidebar"
        className="fixed left-4 top-3 z-40 hidden size-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-brand-text-light shadow-sm transition hover:border-gray-300 hover:text-brand-text-dark md:flex"
        onClick={onExpand}
      >
        <PanelLeftOpen size={18} aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside className="hidden h-screen w-80 shrink-0 border-r border-gray-200 bg-brand-bg px-4 py-5 md:flex md:flex-col">
      <div className="flex items-center justify-between gap-3 px-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-text-light">Projects</h2>
        <button
          type="button"
          aria-label="Collapse project sidebar"
          className="flex size-8 items-center justify-center rounded-lg text-brand-text-light transition hover:bg-white hover:text-brand-text-dark"
          onClick={onCollapse}
        >
          <PanelLeftClose size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-4 flex-1 space-y-2 overflow-y-auto">
        {projects.map(({ project, conversations }) => (
          <SidebarProjectSection
            key={project.id}
            project={project}
            conversations={conversations}
            currentProjectId={currentProjectId}
            currentConversationId={currentConversationId}
            isCollapsed={collapsedProjectIds.has(project.id)}
            onToggle={() => {
              setCollapsedProjectIds((current) => {
                const next = new Set(current);
                if (next.has(project.id)) {
                  next.delete(project.id);
                } else {
                  next.add(project.id);
                }
                return next;
              });
            }}
            onStartChat={() => onStartChat(project.id)}
          />
        ))}
      </div>
    </aside>
  );
}
