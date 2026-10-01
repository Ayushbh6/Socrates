"use client";

import { useState } from "react";
import type { Conversation, Project } from "@socrates/contracts";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { SidebarProjectSection } from "./SidebarProjectSection";

export type SidebarProject = {
  project: Project;
  conversations: Conversation[];
};

interface ProjectChatSidebarProps {
  projects: SidebarProject[];
  currentProjectId: string;
  currentConversationId?: string;
  isCollapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  mode?: "conversations" | "projects";
  projectHref?: (projectId: string) => string;
  onStartChat?: (projectId: string) => Promise<void>;
  overlay?: boolean;
}

export function ProjectChatSidebar({
  projects,
  currentProjectId,
  currentConversationId,
  isCollapsed,
  onCollapse,
  onExpand,
  mode = "conversations",
  projectHref,
  onStartChat,
  overlay = false,
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
    <aside
      className={
        overlay
          ? "fixed inset-y-0 left-0 z-50 hidden h-screen w-80 border-r border-gray-200 bg-brand-bg px-4 py-5 shadow-[1.5rem_0_4rem_rgba(45,55,72,0.12)] md:flex md:flex-col"
          : "hidden h-screen w-80 shrink-0 border-r border-gray-200 bg-brand-bg px-4 py-5 md:flex md:flex-col"
      }
      data-layout={overlay ? "overlay" : "inline"}
    >
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
        {mode === "projects"
          ? projects.map(({ project }) => {
              const isCurrent = project.id === currentProjectId;
              return (
                <Link
                  key={project.id}
                  href={projectHref?.(project.id) ?? `/projects/${project.id}`}
                  aria-current={isCurrent ? "page" : undefined}
                  className={
                    isCurrent
                      ? "block truncate rounded-xl bg-white/75 px-4 py-3 text-sm font-medium text-brand-text-dark"
                      : "block truncate rounded-xl px-4 py-3 text-sm font-medium text-brand-text-dark transition-colors hover:bg-white/70 hover:text-brand-teal-dark"
                  }
                >
                  {project.name}
                </Link>
              );
            })
          : projects.map(({ project, conversations }) => (
              <SidebarProjectSection
                key={project.id}
                project={project}
                conversations={conversations}
                currentProjectId={currentProjectId}
                currentConversationId={currentConversationId ?? ""}
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
                onStartChat={() => onStartChat?.(project.id) ?? Promise.resolve()}
              />
            ))}
      </div>
    </aside>
  );
}
