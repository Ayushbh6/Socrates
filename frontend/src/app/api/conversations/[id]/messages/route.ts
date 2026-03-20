import {
  addUserMessage,
  appendAssistantDelta,
  chunkAssistantResponse,
  completeAssistantMessage,
  createAssistantMessage,
  generateAssistantResponse,
  getConversation,
  markAssistantMessageError,
} from "@/lib/chat/store";
import type {
  ChatStreamEvent,
  SendMessageRequest,
} from "@/lib/chat/types";

export const dynamic = "force-dynamic";

function encodeEvent(event: ChatStreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const conversation = getConversation(id);

  if (!conversation) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }

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

  const userMessage = addUserMessage(id, content);
  const assistantMessage = createAssistantMessage(id);
  const responseText = generateAssistantResponse(conversation, content);
  const chunks = chunkAssistantResponse(responseText);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          encodeEvent({
            type: "meta",
            conversationId: id,
            userMessage,
            assistantMessage,
          })
        )
      );

      let chunkIndex = 0;

      const pushChunk = () => {
        if (chunkIndex >= chunks.length) {
          completeAssistantMessage(id, assistantMessage.id);
          controller.enqueue(
            encoder.encode(
              encodeEvent({
                type: "done",
                assistantMessageId: assistantMessage.id,
              })
            )
          );
          controller.close();
          return;
        }

        const delta = chunks[chunkIndex] ?? "";
        chunkIndex += 1;
        appendAssistantDelta(id, assistantMessage.id, delta);
        controller.enqueue(
          encoder.encode(
            encodeEvent({
              type: "delta",
              assistantMessageId: assistantMessage.id,
              delta,
            })
          )
        );

        setTimeout(pushChunk, 45 + Math.round(Math.random() * 70));
      };

      setTimeout(pushChunk, 140);
    },
    cancel() {
      markAssistantMessageError(
        id,
        assistantMessage.id,
        "The response stream was interrupted. Please try again."
      );
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "application/x-ndjson; charset=utf-8",
    },
  });
}
