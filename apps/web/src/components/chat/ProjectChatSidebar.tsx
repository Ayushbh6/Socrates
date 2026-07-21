"use client";

import { useState } from "react";
import type { Conversation, Project } from "@socrates/contracts";
import { History, PanelLeftClose, PanelLeftOpen, RotateCcw } from "lucide-react";
import Link from "next/link";
import { SidebarProjectSection } from "./SidebarProjectSection";

export type SidebarProject = {
  project: Project;
  conversations: Conversation[];
};

export type SidebarFlowOutlineItem = {
  id: string;
  label: string;
  isCurrent: boolean;
};

export type SidebarFlowOutline = {
  items: SidebarFlowOutlineItem[];
  selectedId?: string;
  hasEarlier?: boolean;
  isLoadingEarlier?: boolean;
  error?: string;
  onSelect: (id: string) => void;
  onReturnToCurrent: () => void;
  onLoadEarlier?: () => void;
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
  flowOutline?: SidebarFlowOutline;
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
  flowOutline,
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
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-2">
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

        {mode === "projects" && flowOutline ? (
          <div className="mx-2 mt-6 border-t border-gray-200/80 pt-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-brand-text-light">
                <History size={14} aria-hidden="true" />
                <span>Queries</span>
              </div>
              {flowOutline.selectedId && !flowOutline.items.find((item) => item.id === flowOutline.selectedId)?.isCurrent ? (
                <button
                  type="button"
                  onClick={flowOutline.onReturnToCurrent}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-brand-text-light transition hover:bg-white/80 hover:text-brand-text-dark"
                >
                  <RotateCcw size={12} aria-hidden="true" />
                  Current
                </button>
              ) : null}
            </div>
            <div className="relative mt-4 space-y-1 before:absolute before:bottom-2 before:left-[0.3125rem] before:top-2 before:w-px before:bg-gray-200">
              {flowOutline.items.length > 0 ? flowOutline.items.map((item) => {
                const isSelected = flowOutline.selectedId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => flowOutline.onSelect(item.id)}
                    aria-current={isSelected ? "step" : undefined}
                    className={`relative block w-full rounded-lg py-2 pl-5 pr-2 text-left text-xs leading-5 transition ${
                      isSelected
                        ? "bg-white/80 font-medium text-brand-text-dark"
                        : "text-brand-text-light hover:bg-white/55 hover:text-brand-text-dark"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`absolute left-0 top-3.5 size-2.5 rounded-full border-2 ${
                        isSelected ? "border-brand-teal-dark bg-brand-bg" : "border-gray-300 bg-brand-bg"
                      }`}
                    />
                    <span className="line-clamp-2">{item.label}</span>
                    {item.isCurrent ? <span className="mt-0.5 block text-[10px] font-normal text-brand-teal-dark">Current</span> : null}
                  </button>
                );
              }) : (
                <p className="pl-5 text-xs leading-5 text-brand-text-light">Your queries will appear here.</p>
              )}
            </div>
            {flowOutline.hasEarlier && flowOutline.onLoadEarlier ? (
              <button
                type="button"
                onClick={flowOutline.onLoadEarlier}
                disabled={flowOutline.isLoadingEarlier}
                className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-xs text-brand-text-light transition hover:bg-white/70 hover:text-brand-text-dark disabled:cursor-wait disabled:opacity-60"
              >
                {flowOutline.isLoadingEarlier ? "Loading…" : "Load earlier queries"}
              </button>
            ) : null}
            {flowOutline.error ? <p className="mt-2 text-xs text-red-600" role="alert">{flowOutline.error}</p> : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
