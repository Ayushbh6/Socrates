import type { SendMessageRequest } from "@/lib/chat/types";

export const dynamic = "force-dynamic";
const BACKEND_BASE_URL =
  process.env.PREMCHAT_BACKEND_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:8000";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: SendMessageRequest;

  try {
    body = (await request.json()) as SendMessageRequest;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const content = body.content?.trim();

  if (!content) {
    return Response.json({ error: "Message content is required." }, { status: 400 });
  }

  try {
    const response = await fetch(
      `${BACKEND_BASE_URL}/api/v1/conversations/${id}/messages/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          content,
          provider: body.provider,
          model: body.model,
          thinkingEnabled: body.thinkingEnabled,
        }),
      }
    );

    if (!response.ok || !response.body) {
      const text = await response.text();
      return Response.json(
        { error: text || "Unable to send message.", detail: text || "Unable to send message." },
        { status: response.status || 500 }
      );
    }

    return new Response(response.body, {
      headers: {
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "Content-Type": "application/x-ndjson; charset=utf-8",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send message.";
    const status = 500;
    return Response.json({ error: message, detail: message }, { status });
  }
}
