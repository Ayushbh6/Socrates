"use client";

import Link from "next/link";
import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import type { Conversation, Project } from "@socrates/contracts";
import { ConversationNavItem } from "./ConversationNavItem";

interface SidebarProjectSectionProps {
  project: Project;
  conversations: Conversation[];
  currentProjectId: string;
  currentConversationId: string;
  isCollapsed: boolean;
  onToggle: () => void;
  onStartChat: () => Promise<void>;
}

export function SidebarProjectSection({
  project,
  conversations,
  currentProjectId,
  currentConversationId,
  isCollapsed,
  onToggle,
  onStartChat,
}: SidebarProjectSectionProps) {
  const isCurrentProject = project.id === currentProjectId;

  return (
    <section>
      <div className={isCurrentProject ? "rounded-xl bg-white/75" : undefined}>
        <div className="flex items-center gap-1 px-2 py-1">
          <button
            type="button"
            aria-label={isCollapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
            className="flex size-7 items-center justify-center rounded-full text-brand-text-light hover:bg-white hover:text-brand-text-dark"
            onClick={onToggle}
          >
            {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
          <Link
            href={`/projects/${project.id}`}
            className="min-w-0 flex-1 truncate text-sm font-medium text-brand-text-dark hover:text-brand-teal-dark"
          >
            {project.name}
          </Link>
          <button
            type="button"
            aria-label={`Start new chat in ${project.name}`}
            className="flex size-7 items-center justify-center rounded-full text-brand-text-light hover:bg-white hover:text-brand-text-dark"
            onClick={() => void onStartChat()}
          >
            <MessageSquarePlus className="size-4" />
          </button>
        </div>
        {!isCollapsed && (
          <div className="ml-8 max-h-[28rem] space-y-1 overflow-y-auto pr-1 pb-2">
            {conversations.length === 0 ? (
              <p className="px-3 py-2 text-xs text-brand-text-light">No chats yet.</p>
            ) : (
              conversations.map((conversation) => (
                <ConversationNavItem
                  key={conversation.id}
                  projectId={project.id}
                  conversation={conversation}
                  isActive={isCurrentProject && conversation.id === currentConversationId}
                />
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}
