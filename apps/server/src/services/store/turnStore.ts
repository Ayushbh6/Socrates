import type { ChatMessageSendPayload, Message } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, eq } from "drizzle-orm"
import { conversations, messages, sessions, turns } from "../../db/schema"
import { mapMessage } from "../../db/mappers"
import { activeTurnStatuses, defaultConversationTitle, deriveConversationTitle, StoreBase } from "./shared"
import type { CreatedTurn } from "./types"
import type { ErrorStore } from "./errorStore"

export class TurnStore extends StoreBase {
  constructor(
    context: ConstructorParameters<typeof StoreBase>[0],
    private readonly errors: ErrorStore,
  ) {
    super(context)
  }

  createTurnFromUserMessage(projectId: string, conversationId: string, payload: ChatMessageSendPayload): CreatedTurn {
    const conversation = this.mustGetConversationRow(projectId, conversationId)
    const content = payload.content.trim()
    if (!content) {
      throw new SocratesError("message_content_required", "Message content is required", { recoverable: true })
    }

    const activeTurn = this.getActiveTurn(conversationId)
    if (activeTurn) {
      throw new SocratesError("turn_already_active", "This conversation already has an active turn", {
        details: { activeTurnId: activeTurn.id },
        recoverable: true,
      })
    }

    const now = nowIso()
    const sessionId = this.ensureSession(projectId, conversationId)
    const turnId = createId("turn")
    const messageId = payload.clientMessageId
    const existingUserMessage = this.handle.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
      .limit(1)
      .get()
    const shouldDeriveTitle = !existingUserMessage && conversation.title === defaultConversationTitle
    const nextTitle = shouldDeriveTitle ? deriveConversationTitle(content) : conversation.title

    this.handle.db
      .insert(messages)
      .values({
        id: messageId,
        conversationId,
        sessionId,
        turnId,
        role: "user",
        content,
        contentFormat: "markdown",
        status: "completed",
        createdAt: now,
        completedAt: now,
      })
      .run()

    this.handle.db
      .insert(turns)
      .values({
        id: turnId,
        sessionId,
        conversationId,
        userMessageId: messageId,
        status: "running",
        startedAt: now,
      })
      .run()

    const runtimeConfigId = this.insertRuntimeConfig(turnId, payload.runtimeConfig, now)
    this.handle.db
      .update(conversations)
      .set({
        ...(nextTitle ? { title: nextTitle } : {}),
        updatedAt: now,
      })
      .where(and(eq(conversations.projectId, projectId), eq(conversations.id, conversationId)))
      .run()

    const userMessage = mapMessage(this.mustGetMessageRow(messageId))
    this.appendEvent({
      projectId,
      conversationId,
      sessionId,
      turnId,
      type: "turn.started",
      source: "server",
      payload: { turnId, userMessage },
    })

    return { sessionId, turnId, runtimeConfigId, userMessage }
  }

  completeAgentTurn(input: {
    conversationId: string
    sessionId: string
    turnId: string
    content: string
    reasoning?: string
  }): Message {
    const now = nowIso()
    const messageId = createId("msg")
    const reasoning = input.reasoning?.trim()
    this.handle.db
      .insert(messages)
      .values({
        id: messageId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        role: "assistant",
        content: input.content,
        contentFormat: "markdown",
        ...(reasoning ? { metadataJson: JSON.stringify({ reasoning }) } : {}),
        status: "completed",
        createdAt: now,
        completedAt: now,
      })
      .run()

    this.handle.db
      .update(turns)
      .set({
        assistantMessageId: messageId,
        status: "completed",
        completedAt: now,
      })
      .where(eq(turns.id, input.turnId))
      .run()

    this.handle.db.update(sessions).set({ status: "idle", updatedAt: now }).where(eq(sessions.id, input.sessionId)).run()
    this.touchConversation(input.conversationId, now)

    return mapMessage(this.mustGetMessageRow(messageId))
  }

  failTurn(input: {
    conversationId: string
    sessionId: string
    turnId: string
    code: string
    message: string
    details?: unknown
  }): string {
    const errorId = this.errors.recordError({
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      source: "provider",
      code: input.code,
      message: input.message,
      details: input.details,
      recoverable: true,
    })
    const now = nowIso()
    this.handle.db
      .update(turns)
      .set({
        status: "failed",
        failedAt: now,
        errorId,
      })
      .where(eq(turns.id, input.turnId))
      .run()
    this.handle.db.update(sessions).set({ status: "idle", updatedAt: now }).where(eq(sessions.id, input.sessionId)).run()
    return errorId
  }

  completePlaceholderTurn(projectId: string, conversationId: string, turnId: string): Message | null {
    const turn = this.handle.db.select().from(turns).where(eq(turns.id, turnId)).get()
    if (!turn || turn.status !== "running") {
      return null
    }

    const now = nowIso()
    const messageId = createId("msg")
    const content = "Socrates backend skeleton received the message. Model execution will be added in a later sprint."

    this.handle.db
      .insert(messages)
      .values({
        id: messageId,
        conversationId,
        sessionId: turn.sessionId,
        turnId,
        role: "assistant",
        content,
        contentFormat: "markdown",
        status: "completed",
        createdAt: now,
        completedAt: now,
      })
      .run()

    this.handle.db
      .update(turns)
      .set({
        assistantMessageId: messageId,
        status: "completed",
        completedAt: now,
      })
      .where(eq(turns.id, turnId))
      .run()

    this.touchConversation(conversationId, now)
    return mapMessage(this.mustGetMessageRow(messageId))
  }

  cancelTurn(turnId: string, reason?: string): { projectId: string; conversationId: string; sessionId: string; turnId: string } {
    const turn = this.handle.db.select().from(turns).where(eq(turns.id, turnId)).get()
    if (!turn) {
      throw new SocratesError("turn_not_found", "Turn not found")
    }

    if (!activeTurnStatuses.includes(turn.status)) {
      throw new SocratesError("turn_not_active", "Turn is not active", {
        details: { turnId, status: turn.status },
      })
    }

    const session = this.handle.db.select().from(sessions).where(eq(sessions.id, turn.sessionId)).get()
    if (!session) {
      throw new SocratesError("session_not_found", "Session not found for turn", { details: { turnId } })
    }

    const now = nowIso()
    this.handle.db
      .update(turns)
      .set({
        status: "cancelled",
        cancelledAt: now,
        metadataJson: JSON.stringify({ reason }),
      })
      .where(eq(turns.id, turnId))
      .run()

    this.appendEvent({
      projectId: session.projectId,
      conversationId: turn.conversationId,
      sessionId: session.id,
      turnId,
      type: "turn.cancelled",
      source: "server",
      payload: { turnId, reason },
    })

    return {
      projectId: session.projectId,
      conversationId: turn.conversationId,
      sessionId: session.id,
      turnId,
    }
  }
}
