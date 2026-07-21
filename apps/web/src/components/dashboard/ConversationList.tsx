"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
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
  onGetDeletionImpact: (conversationId: string) => Promise<{ linkedToFlow: boolean }>;
  onDelete: (conversationId: string, scope: "classic_only" | "everywhere") => Promise<void>;
}

export function ConversationList({
  projectId,
  conversations,
  isSavingAction,
  onRename,
  onGetDeletionImpact,
  onDelete,
}: ConversationListProps) {
  const [conversationToRename, setConversationToRename] = useState<Conversation | null>(null);
  const [conversationToDelete, setConversationToDelete] = useState<Conversation | null>(null);
  const [linkedToFlow, setLinkedToFlow] = useState(false);
  const [isCheckingDeletion, setIsCheckingDeletion] = useState(false);
  const [deletionImpactError, setDeletionImpactError] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const filteredConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return conversations;
    }
    return conversations.filter((conversation) =>
      (conversation.title ?? "Untitled conversation").toLowerCase().includes(normalizedQuery),
    );
  }, [conversations, query]);

  const prepareDelete = async (conversation: Conversation) => {
    setConversationToDelete(conversation);
    setLinkedToFlow(false);
    setDeletionImpactError(undefined);
    setIsCheckingDeletion(true);
    try {
      const impact = await onGetDeletionImpact(conversation.id);
      setLinkedToFlow(impact.linkedToFlow);
    } catch {
      setDeletionImpactError("Could not check Flow history.");
    } finally {
      setIsCheckingDeletion(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label className="relative mb-3 block shrink-0">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-brand-text-light" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations..."
          className="h-11 w-full rounded-lg border border-gray-200 bg-white pl-10 pr-3 text-sm text-brand-text-dark outline-none transition focus:border-brand-teal-dark focus:ring-2 focus:ring-brand-teal-dark/10"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto pr-2">
        {conversations.length === 0 && (
          <div className="border-t border-gray-100 py-6 text-sm text-brand-text-light">
          No conversations yet.
          </div>
        )}
        {conversations.length > 0 && filteredConversations.length === 0 && (
          <div className="border-t border-gray-100 py-6 text-sm text-brand-text-light">
            No matching conversations.
          </div>
        )}
        {filteredConversations.map((conversation) => (
          <div
            key={conversation.id}
            className="-mx-4 flex items-center gap-4 rounded-lg border-t border-gray-100 px-4 py-4 transition-colors hover:bg-gray-50/50"
          >
            <Link href={`/projects/${projectId}/chats/${conversation.id}`} className="min-w-0 flex-1">
              <h4 className="truncate font-medium text-brand-text-dark">{conversation.title ?? "Untitled conversation"}</h4>
              <p className="mt-1 text-sm text-brand-text-light">Updated {formatUpdatedAt(conversation.updatedAt)}</p>
            </Link>
            <ConversationActionsMenu
              onRename={() => setConversationToRename(conversation)}
              onDelete={() => void prepareDelete(conversation)}
            />
          </div>
        ))}
      </div>
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
          linkedToFlow={linkedToFlow}
          isChecking={isCheckingDeletion}
          impactError={deletionImpactError}
          isDeleting={isSavingAction}
          onCancel={() => setConversationToDelete(null)}
          onDelete={async (scope) => {
            await onDelete(conversationToDelete.id, scope);
            setConversationToDelete(null);
          }}
        />
      )}
    </div>
  );
}
