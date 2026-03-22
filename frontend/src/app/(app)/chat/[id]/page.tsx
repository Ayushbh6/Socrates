import { notFound } from "next/navigation";
import { ChatScreen } from "@/components/chat/chat-screen";
import { fetchConversationById } from "@/lib/chat/backend";

export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const conversation = await fetchConversationById(id);

  if (!conversation) {
    notFound();
  }

  return <ChatScreen initialConversation={conversation} />;
}
