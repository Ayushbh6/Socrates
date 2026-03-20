import { notFound } from "next/navigation";
import { ChatScreen } from "@/components/chat/chat-screen";
import { getConversation } from "@/lib/chat/store";

export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const conversation = getConversation(id);

  if (!conversation) {
    notFound();
  }

  return <ChatScreen initialConversation={conversation} />;
}
