import {
  BackendRequestError,
  chunkResponseText,
  sendConversationMessage,
} from "@/lib/chat/backend";
import type { ChatStreamEvent, SendMessageRequest } from "@/lib/chat/types";

export const dynamic = "force-dynamic";

function encodeEvent(event: ChatStreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

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
    const result = await sendConversationMessage(id, {
      content,
      provider: body.provider,
      model: body.model,
      thinkingEnabled: body.thinkingEnabled,
    });

    const assistantMessage = {
      ...result.assistantMessage,
      content: "",
      status: "streaming" as const,
    };
    const chunks = chunkResponseText(result.assistantMessage.content);
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            encodeEvent({
              type: "meta",
              conversationId: id,
              conversationTitle: result.conversation.title,
              provider: result.conversation.provider,
              model: result.conversation.model,
              thinkingEnabled: result.conversation.thinkingEnabled,
              userMessage: result.userMessage,
              assistantMessage,
            })
          )
        );

        if (result.assistantMessage.reasoning) {
          controller.enqueue(
            encoder.encode(
              encodeEvent({
                type: "reasoning",
                assistantMessageId: result.assistantMessage.id,
                reasoning: result.assistantMessage.reasoning,
              })
            )
          );
        }

        let chunkIndex = 0;

        const pushChunk = () => {
          if (chunkIndex >= chunks.length) {
            controller.enqueue(
              encoder.encode(
                encodeEvent({
                  type: "done",
                  assistantMessageId: result.assistantMessage.id,
                })
              )
            );
            controller.close();
            return;
          }

          const delta = chunks[chunkIndex] ?? "";
          chunkIndex += 1;
          controller.enqueue(
            encoder.encode(
              encodeEvent({
                type: "delta",
                assistantMessageId: result.assistantMessage.id,
                delta,
              })
            )
          );

          setTimeout(pushChunk, 30 + Math.round(Math.random() * 55));
        };

        setTimeout(pushChunk, 80);
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "Content-Type": "application/x-ndjson; charset=utf-8",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to send message.";
    const status = error instanceof BackendRequestError ? error.status : 500;
    return Response.json({ error: message, detail: message }, { status });
  }
}
