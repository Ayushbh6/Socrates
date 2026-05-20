import type { FeedbackSubmitPayload } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { eq } from "drizzle-orm"
import { messageFeedback, messages } from "../../db/schema"
import { StoreBase } from "./shared"

export class FeedbackStore extends StoreBase {
  submitFeedback(payload: FeedbackSubmitPayload): void {
    const message = this.handle.db.select().from(messages).where(eq(messages.id, payload.messageId)).get()
    if (!message) {
      throw new SocratesError("message_not_found", "Message not found for feedback", {
        details: { messageId: payload.messageId },
      })
    }

    const now = nowIso()
    this.handle.db
      .insert(messageFeedback)
      .values({
        id: createId("fb"),
        conversationId: message.conversationId,
        sessionId: message.sessionId,
        turnId: payload.turnId ?? message.turnId,
        messageId: payload.messageId,
        modelCallId: payload.modelCallId,
        rating: payload.rating,
        reasonCode: payload.reasonCode,
        note: payload.note,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const feedbackTurnId = payload.turnId ?? message.turnId ?? undefined
    this.appendEvent({
      conversationId: message.conversationId,
      sessionId: message.sessionId,
      ...(feedbackTurnId ? { turnId: feedbackTurnId } : {}),
      type: "feedback.created",
      source: "server",
      payload,
    })
  }
}
