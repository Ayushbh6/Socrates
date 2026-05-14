import Link from "next/link";

interface ConversationListProps {
  projectId: string;
}

export function ConversationList({ projectId }: ConversationListProps) {
  return (
    <div className="mt-8">
      <Link 
        href={`/projects/${projectId}/chats/mock-chat-id`}
        className="block border-t border-gray-100 py-4 cursor-pointer hover:bg-gray-50/50 rounded-lg -mx-4 px-4 transition-colors"
      >
        <h4 className="font-medium text-brand-text-dark">Database normalization questions with diagrams</h4>
        <p className="text-sm text-brand-text-light mt-1">Last message 29 days ago</p>
      </Link>
    </div>
  );
}
