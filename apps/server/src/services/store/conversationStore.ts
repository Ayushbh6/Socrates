import type {
  Conversation,
  ConversationContextUsage,
  ConversationPartialTurn,
  ConversationTokenUsage,
  CreateConversationMessageRequest,
  CreateConversationRequest,
  Message,
  UpdateConversationRequest,
} from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, desc, eq, inArray } from "drizzle-orm"
import {
  approvals,
  artifacts,
  audioOutputs,
  contextUsageSnapshots,
  conversations,
  errors,
  events,
  fileOperations,
  messageFeedback,
  messages,
  modelCalls,
  modelStreamChunks,
  modelUsage,
  patches,
  sessions,
  sessionState,
  shellCommands,
  shellOutputChunks,
  terminalOutputChunks,
  terminalSessions,
  toolCalls,
  turnRuntimeConfigs,
  turns,
  voiceInputs,
} from "../../db/schema"
import { mapConversation, mapMessage } from "../../db/mappers"
import { defaultConversationTitle, deriveConversationTitle, StoreBase } from "./shared"
import type { ConversationModelMessage } from "./types"
import type { ModelTelemetryStore } from "./modelTelemetryStore"

export class ConversationStore extends StoreBase {
  constructor(
    context: ConstructorParameters<typeof StoreBase>[0],
    private readonly modelTelemetry: ModelTelemetryStore,
  ) {
    super(context)
  }

  listConversations(projectId: string): Conversation[] {
    this.mustGetProjectRow(projectId)
    return this.handle.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.projectId, projectId), inArray(conversations.status, ["active", "archived"])))
      .orderBy(desc(conversations.updatedAt))
      .all()
      .map(mapConversation)
  }

  createConversation(projectId: string, input: CreateConversationRequest): Conversation {
    const project = this.mustGetProjectRow(projectId)
    const now = nowIso()
    const id = createId("conv")
    const title = input.title?.trim() || defaultConversationTitle

    this.handle.db
      .insert(conversations)
      .values({
        id,
        projectId,
        userId: project.userId,
        title,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run()

    this.appendEvent({
      projectId,
      conversationId: id,
      type: "conversation.created",
      source: "server",
      payload: { projectId, conversationId: id },
    })

    return mapConversation(this.mustGetConversationRow(projectId, id))
  }

  updateConversationTitle(projectId: string, conversationId: string, input: UpdateConversationRequest): Conversation {
    this.mustGetConversationRow(projectId, conversationId)
    const title = input.title.trim()
    if (!title) {
      throw new SocratesError("conversation_title_required", "Conversation title is required", { recoverable: true })
    }

    const now = nowIso()
    this.handle.db
      .update(conversations)
      .set({
        title,
        updatedAt: now,
      })
      .where(and(eq(conversations.projectId, projectId), eq(conversations.id, conversationId)))
      .run()

    this.appendEvent({
      projectId,
      conversationId,
      type: "conversation.updated",
      source: "server",
      payload: { projectId, conversationId, title },
    })

    return mapConversation(this.mustGetConversationRow(projectId, conversationId))
  }

  getConversation(
    projectId: string,
    conversationId: string,
  ): {
    conversation: Conversation
    messages: Message[]
    partialTurns?: ConversationPartialTurn[]
    tokenUsage: ConversationTokenUsage
    contextUsage?: ConversationContextUsage
  } {
    const conversation = mapConversation(this.mustGetConversationRow(projectId, conversationId))
    const rows = this.handle.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt)
      .all()
    const mappedMessages = rows.map(mapMessage)
    const missingReasoningTurnIds = mappedMessages
      .filter((message) => message.role === "assistant" && message.turnId && !message.reasoning)
      .map((message) => message.turnId as string)
    const reasoningByTurnId = this.modelTelemetry.getReasoningTextByTurnIds(missingReasoningTurnIds)

    const contextUsage = this.modelTelemetry.getLatestConversationContextUsage(conversationId)
    const partialTurns = this.getIncompleteTurnStreams(conversationId)
    return {
      conversation,
      messages: mappedMessages.map((message) => {
        if (message.role !== "assistant" || message.reasoning || !message.turnId) {
          return message
        }
        const reasoning = reasoningByTurnId.get(message.turnId)
        return reasoning ? { ...message, reasoning } : message
      }),
      ...(partialTurns.length > 0 ? { partialTurns } : {}),
      tokenUsage: this.modelTelemetry.getConversationTokenUsage(conversationId),
      ...(contextUsage ? { contextUsage } : {}),
    }
  }

  private getIncompleteTurnStreams(conversationId: string): ConversationPartialTurn[] {
    const rows = this.handle.sqlite
      .prepare(
        `SELECT id, status
         FROM turns
         WHERE conversation_id = ?
           AND assistant_message_id IS NULL
           AND status IN ('running', 'failed', 'cancelled')
         ORDER BY started_at`,
      )
      .all(conversationId) as Array<{ id: string; status: "running" | "failed" | "cancelled" }>

    if (rows.length === 0) {
      return []
    }

    const reasoningByTurnId = this.modelTelemetry.getReasoningTextByTurnIds(rows.map((row) => row.id))
    return rows
      .map((row) => {
        const answer = this.modelTelemetry.getAnswerTextByTurnId(row.id)
        const reasoning = reasoningByTurnId.get(row.id)?.trim()
        return {
          turnId: row.id,
          status: row.status,
          ...(answer ? { answer } : {}),
          ...(reasoning ? { reasoning } : {}),
        }
      })
      .filter((turn) => turn.answer || turn.reasoning)
  }

  createConversationUserMessage(
    projectId: string,
    conversationId: string,
    input: CreateConversationMessageRequest,
  ): { conversation: Conversation; message: Message } {
    const conversation = this.mustGetConversationRow(projectId, conversationId)
    const content = input.content.trim()
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

    const existingUserMessage = this.handle.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
      .limit(1)
      .get()

    const now = nowIso()
    const sessionId = this.ensureSession(projectId, conversationId)
    const turnId = createId("turn")
    const messageId = createId("msg")
    const shouldDeriveTitle = !existingUserMessage && conversation.title === defaultConversationTitle
    const nextTitle = shouldDeriveTitle ? deriveConversationTitle(content) : conversation.title

    this.handle.db
      .insert(turns)
      .values({
        id: turnId,
        sessionId,
        conversationId,
        userMessageId: messageId,
        status: "completed",
        startedAt: now,
        completedAt: now,
      })
      .run()

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
      .update(conversations)
      .set({
        ...(nextTitle ? { title: nextTitle } : {}),
        updatedAt: now,
      })
      .where(and(eq(conversations.projectId, projectId), eq(conversations.id, conversationId)))
      .run()

    this.handle.db.update(sessions).set({ status: "idle", updatedAt: now }).where(eq(sessions.id, sessionId)).run()

    const message = mapMessage(this.mustGetMessageRow(messageId))
    this.appendEvent({
      projectId,
      conversationId,
      sessionId,
      turnId,
      type: "message.created",
      source: "server",
      payload: { message },
    })

    return {
      conversation: mapConversation(this.mustGetConversationRow(projectId, conversationId)),
      message,
    }
  }

  deleteConversation(projectId: string, conversationId: string): { deletedConversationId: string } {
    this.mustGetConversationRow(projectId, conversationId)
    const deleteRows = this.handle.sqlite.transaction(() => {
      const turnRows = this.handle.db
        .select({ id: turns.id })
        .from(turns)
        .where(eq(turns.conversationId, conversationId))
        .all()
      const turnIds = turnRows.map((row) => row.id)
      const sessionRows = this.handle.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.conversationId, conversationId))
        .all()
      const sessionIds = sessionRows.map((row) => row.id)
      const shellCommandRows = this.handle.db
        .select({ id: shellCommands.id })
        .from(shellCommands)
        .where(eq(shellCommands.conversationId, conversationId))
        .all()
      const shellCommandIds = shellCommandRows.map((row) => row.id)
      const terminalRows = this.handle.db
        .select({ id: terminalSessions.id })
        .from(terminalSessions)
        .where(eq(terminalSessions.conversationId, conversationId))
        .all()
      const terminalIds = terminalRows.map((row) => row.id)

      if (shellCommandIds.length > 0) {
        this.handle.db.delete(shellOutputChunks).where(inArray(shellOutputChunks.shellCommandId, shellCommandIds)).run()
      }
      if (terminalIds.length > 0) {
        this.handle.db.delete(terminalOutputChunks).where(inArray(terminalOutputChunks.terminalSessionId, terminalIds)).run()
      }
      if (turnIds.length > 0) {
        this.handle.db.delete(turnRuntimeConfigs).where(inArray(turnRuntimeConfigs.turnId, turnIds)).run()
        this.handle.db.delete(modelStreamChunks).where(inArray(modelStreamChunks.turnId, turnIds)).run()
        this.handle.db.delete(modelUsage).where(inArray(modelUsage.turnId, turnIds)).run()
      }
      if (sessionIds.length > 0) {
        this.handle.db.delete(sessionState).where(inArray(sessionState.sessionId, sessionIds)).run()
      }

      this.handle.db.delete(messageFeedback).where(eq(messageFeedback.conversationId, conversationId)).run()
      this.handle.db.delete(audioOutputs).where(eq(audioOutputs.conversationId, conversationId)).run()
      this.handle.db.delete(voiceInputs).where(eq(voiceInputs.conversationId, conversationId)).run()
      this.handle.db.delete(patches).where(eq(patches.conversationId, conversationId)).run()
      this.handle.db.delete(fileOperations).where(eq(fileOperations.conversationId, conversationId)).run()
      this.handle.db.delete(shellCommands).where(eq(shellCommands.conversationId, conversationId)).run()
      this.handle.db.delete(terminalSessions).where(eq(terminalSessions.conversationId, conversationId)).run()
      this.handle.db.delete(approvals).where(eq(approvals.conversationId, conversationId)).run()
      this.handle.db.delete(toolCalls).where(eq(toolCalls.conversationId, conversationId)).run()
      this.handle.db.delete(contextUsageSnapshots).where(eq(contextUsageSnapshots.conversationId, conversationId)).run()
      this.handle.db.delete(modelCalls).where(eq(modelCalls.conversationId, conversationId)).run()
      this.handle.db.delete(artifacts).where(eq(artifacts.conversationId, conversationId)).run()
      this.handle.db.delete(errors).where(eq(errors.conversationId, conversationId)).run()
      this.handle.db.delete(events).where(eq(events.conversationId, conversationId)).run()
      this.handle.db.delete(messages).where(eq(messages.conversationId, conversationId)).run()
      this.handle.db.delete(turns).where(eq(turns.conversationId, conversationId)).run()
      this.handle.db.delete(sessions).where(eq(sessions.conversationId, conversationId)).run()
      this.handle.db
        .delete(conversations)
        .where(and(eq(conversations.projectId, projectId), eq(conversations.id, conversationId)))
        .run()
    })

    deleteRows()
    this.appendEvent({
      projectId,
      type: "conversation.deleted",
      source: "server",
      payload: { projectId, deletedConversationId: conversationId },
    })

    return { deletedConversationId: conversationId }
  }

  getConversationModelMessages(projectId: string, conversationId: string): ConversationModelMessage[] {
    this.mustGetConversationRow(projectId, conversationId)
    return this.handle.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt)
      .all()
      .filter((message) => {
        if (!["user", "assistant", "system", "developer"].includes(message.role)) {
          return false
        }
        if (message.status === "completed") {
          return true
        }
        return message.role === "assistant" && message.status === "cancelled" && isCancelledPartialAssistant(message.metadataJson)
      })
      .map((message) => ({
        role: message.role as ConversationModelMessage["role"],
        content: message.content,
        id: message.id,
        ...(message.turnId ? { turnId: message.turnId } : {}),
      }))
  }
}

const isCancelledPartialAssistant = (metadataJson: string | null): boolean => {
  if (!metadataJson) {
    return false
  }
  try {
    const parsed = JSON.parse(metadataJson) as { partial?: unknown; cancelled?: unknown }
    return parsed.partial === true && parsed.cancelled === true
  } catch {
    return false
  }
}
