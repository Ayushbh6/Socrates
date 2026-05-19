"use client";

import Link from "next/link";
import type { Conversation } from "@socrates/contracts";

interface ConversationNavItemProps {
  projectId: string;
  conversation: Conversation;
  isActive: boolean;
}

export function ConversationNavItem({ projectId, conversation, isActive }: ConversationNavItemProps) {
  return (
    <Link
      href={`/projects/${projectId}/chats/${conversation.id}`}
      className={
        isActive
          ? "block truncate rounded-lg bg-white px-3 py-2 text-sm font-medium text-brand-text-dark shadow-sm"
          : "block truncate rounded-lg px-3 py-2 text-sm text-brand-text-light transition-colors hover:bg-white/70 hover:text-brand-text-dark"
      }
    >
      {conversation.title ?? "Untitled conversation"}
    </Link>
  );
}
