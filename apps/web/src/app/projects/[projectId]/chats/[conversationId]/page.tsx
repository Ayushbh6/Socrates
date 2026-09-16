import { ChatWorkspace } from "@/components/chat/ChatWorkspace";

export default async function ChatPage({ params }: { params: Promise<{ projectId: string; conversationId: string }> }) {
  const { projectId, conversationId } = await params;

  return <ChatWorkspace projectId={projectId} conversationId={conversationId} />;
}
