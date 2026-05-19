"use client";

import Link from "next/link";
import { useState } from "react";
import type { Conversation } from "@socrates/contracts";
import { ConversationActionsMenu } from "@/components/chat/ConversationActionsMenu";
import { DeleteConversationDialog } from "@/components/chat/DeleteConversationDialog";
import { RenameConversationDialog } from "@/components/chat/RenameConversationDialog";
import { formatUpdatedAt } from "@/lib/dates";

interface ConversationListProps {
  projectId: string;
  conversations: Conversation[];
  isSavingAction: boolean;
  onRename: (conversationId: string, title: string) => Promise<void>;
  onDelete: (conversationId: string) => Promise<void>;
}

export function ConversationList({
  projectId,
  conversations,
  isSavingAction,
  onRename,
  onDelete,
}: ConversationListProps) {
  const [conversationToRename, setConversationToRename] = useState<Conversation | null>(null);
  const [conversationToDelete, setConversationToDelete] = useState<Conversation | null>(null);

  return (
    <div className="mt-8">
      {conversations.length === 0 && (
        <div className="border-t border-gray-100 py-6 text-sm text-brand-text-light">
          No conversations yet.
        </div>
      )}
      {conversations.map((conversation) => (
        <div
          key={conversation.id}
          className="flex items-center gap-4 border-t border-gray-100 py-4 hover:bg-gray-50/50 rounded-lg -mx-4 px-4 transition-colors"
        >
          <Link href={`/projects/${projectId}/chats/${conversation.id}`} className="min-w-0 flex-1">
            <h4 className="truncate font-medium text-brand-text-dark">{conversation.title ?? "Untitled conversation"}</h4>
            <p className="text-sm text-brand-text-light mt-1">Updated {formatUpdatedAt(conversation.updatedAt)}</p>
          </Link>
          <ConversationActionsMenu
            onRename={() => setConversationToRename(conversation)}
            onDelete={() => setConversationToDelete(conversation)}
          />
        </div>
      ))}
      {conversationToRename && (
        <RenameConversationDialog
          initialTitle={conversationToRename.title ?? "Untitled conversation"}
          isSaving={isSavingAction}
          onCancel={() => setConversationToRename(null)}
          onSave={async (title) => {
            await onRename(conversationToRename.id, title);
            setConversationToRename(null);
          }}
        />
      )}
      {conversationToDelete && (
        <DeleteConversationDialog
          title={conversationToDelete.title ?? "Untitled conversation"}
          isDeleting={isSavingAction}
          onCancel={() => setConversationToDelete(null)}
          onDelete={async () => {
            await onDelete(conversationToDelete.id);
            setConversationToDelete(null);
          }}
        />
      )}
    </div>
  );
}
