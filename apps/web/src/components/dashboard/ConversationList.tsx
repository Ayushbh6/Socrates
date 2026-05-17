import Link from "next/link";
import type { Conversation } from "@socrates/contracts";
import { formatUpdatedAt } from "@/lib/dates";

interface ConversationListProps {
  projectId: string;
  conversations: Conversation[];
}

export function ConversationList({ projectId, conversations }: ConversationListProps) {
  return (
    <div className="mt-8">
      {conversations.length === 0 && (
        <div className="border-t border-gray-100 py-6 text-sm text-brand-text-light">
          No conversations yet.
        </div>
      )}
      {conversations.map((conversation) => (
        <Link
          key={conversation.id}
          href={`/projects/${projectId}/chats/${conversation.id}`}
          className="block border-t border-gray-100 py-4 cursor-pointer hover:bg-gray-50/50 rounded-lg -mx-4 px-4 transition-colors"
        >
          <h4 className="font-medium text-brand-text-dark">{conversation.title ?? "Untitled conversation"}</h4>
          <p className="text-sm text-brand-text-light mt-1">Updated {formatUpdatedAt(conversation.updatedAt)}</p>
        </Link>
      ))}
    </div>
  );
}
