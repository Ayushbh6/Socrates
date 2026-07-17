import { ChatWorkspace } from "@/components/chat/ChatWorkspace";
import { ContinueInSeamlessButton } from "@/components/v2/ContinueInSeamlessButton";

export default async function ChatPage({ params }: { params: Promise<{ projectId: string; conversationId: string }> }) {
  const { projectId, conversationId } = await params;

  return (
    <>
      <ContinueInSeamlessButton projectId={projectId} conversationId={conversationId} />
      <ChatWorkspace projectId={projectId} conversationId={conversationId} />
    </>
  );
}
