import { NextResponse } from "next/server";
import {
  createConversationRecord,
  fetchConversationSummaries,
} from "@/lib/chat/backend";
import type { CreateConversationRequest } from "@/lib/chat/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const conversations = await fetchConversationSummaries();
  return NextResponse.json({ conversations });
}

export async function POST(request: Request) {
  let body: CreateConversationRequest = {};

  try {
    body = (await request.json()) as CreateConversationRequest;
  } catch {
    body = {};
  }

  const conversation = await createConversationRecord({
    title: body.title?.trim() || undefined,
    provider: body.provider,
    model: body.model,
    thinkingEnabled: body.thinkingEnabled,
  });

  return NextResponse.json(
    {
      conversation,
    },
    { status: 201 }
  );
}
