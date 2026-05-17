import { ChatSidebar } from "@/components/layout/ChatSidebar";
import { ChatTimeline } from "@/components/chat/ChatTimeline";
import { ChatComposer } from "@/components/chat/ChatComposer";

export default async function ChatPage({ params }: { params: Promise<{ projectId: string; conversationId: string }> }) {
  const { projectId, conversationId } = await params;

  return (
    <main className="flex h-screen bg-white">
      <ChatSidebar projectId={projectId} />

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <header className="h-14 border-b border-gray-200 flex items-center px-6 shrink-0">
          <h2 className="font-medium text-brand-text-dark text-sm">Conversation {conversationId}</h2>
        </header>

        <ChatTimeline />
        <ChatComposer />
      </div>
    </main>
  );
}
