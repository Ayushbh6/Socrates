import { NextResponse } from "next/server";
import { createConversation, listConversations } from "@/lib/chat/store";
import type { CreateConversationRequest } from "@/lib/chat/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ conversations: listConversations() });
}

export async function POST(request: Request) {
  let body: CreateConversationRequest = {};

  try {
    body = (await request.json()) as CreateConversationRequest;
  } catch {
    body = {};
  }

  const conversation = createConversation(body.title?.trim() || undefined);

  return NextResponse.json(
    {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
      },
    },
    { status: 201 }
  );
}
