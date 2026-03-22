import { NextResponse } from "next/server";
import {
  BackendRequestError,
  fetchConversationById,
  updateConversationRecord,
} from "@/lib/chat/backend";
import type { UpdateConversationRequest } from "@/lib/chat/types";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const conversation = await fetchConversationById(id);

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 }
    );
  }

  return NextResponse.json({ conversation });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: UpdateConversationRequest;

  try {
    body = (await request.json()) as UpdateConversationRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  try {
    const conversation = await updateConversationRecord(id, body);
    return NextResponse.json({ conversation });
  } catch (error) {
    if (error instanceof BackendRequestError) {
      return NextResponse.json(
        { error: error.message, detail: error.message },
        { status: error.status }
      );
    }

    return NextResponse.json(
      { error: "Unable to update conversation." },
      { status: 500 }
    );
  }
}
