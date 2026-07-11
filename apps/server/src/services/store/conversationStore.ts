import type {
  Conversation,
  ConversationContextUsage,
  ConversationPartialTurn,
  ConversationTokenUsage,
  CreateConversationMessageRequest,
  CreateConversationRequest,
  Message,
  MessageAttachment,
  RuntimeConfig,
  UpdateConversationRequest,
} from "@socrates/contracts"
import path from "node:path"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, desc, eq, inArray } from "drizzle-orm"
import {
  approvals,
  artifacts,
  audioOutputs,
  aiUsageEvents,
  contextUsageSnapshots,
  conversations,
  errors,
  events,
  fileOperations,
  messageFeedback,
  messageAttachments,
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
  traceDocuments,
  traceEmbeddings,
  traceIndexJobs,
  turnRuntimeConfigs,
  turnUsageReports,
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

  autoTitleConversation(
    projectId: string,
    conversationId: string,
    title: string,
    expectedTitle = defaultConversationTitle,
  ): Conversation | undefined {
    this.mustGetConversationRow(projectId, conversationId)
    const nextTitle = title.trim()
    if (!nextTitle) {
      return
    }

    const now = nowIso()
    const result = this.handle.db
      .update(conversations)
      .set({
        title: nextTitle,
        updatedAt: now,
      })
      .where(
        and(
          eq(conversations.projectId, projectId),
          eq(conversations.id, conversationId),
          eq(conversations.title, expectedTitle),
        ),
      )
      .run()

    if (result.changes === 0) {
      return
    }

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
    lastRuntimeConfig?: RuntimeConfig
  } {
    const conversation = mapConversation(this.mustGetConversationRow(projectId, conversationId))
    const rows = this.handle.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt)
      .all()
    const mappedMessages = this.withMessageAttachments(rows.map(mapMessage))
    const missingReasoningTurnIds = mappedMessages
      .filter((message) => message.role === "assistant" && message.turnId && !message.reasoning)
      .map((message) => message.turnId as string)
    const reasoningByTurnId = this.modelTelemetry.getReasoningTextByTurnIds(missingReasoningTurnIds)

    const contextUsage = this.modelTelemetry.getLatestConversationContextUsage(conversationId)
    const partialTurns = this.getIncompleteTurnStreams(conversationId)
    const lastRuntimeConfig = this.getLatestRuntimeConfig(conversationId)
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
      ...(lastRuntimeConfig ? { lastRuntimeConfig } : {}),
    }
  }

  private getLatestRuntimeConfig(conversationId: string): RuntimeConfig | undefined {
    const row = this.handle.sqlite
      .prepare(
        `SELECT
           turn_runtime_configs.provider_id as providerId,
           turn_runtime_configs.auth_mode as authMode,
           turn_runtime_configs.model_id as modelId,
           turn_runtime_configs.thinking_enabled as thinkingEnabled,
           turn_runtime_configs.thinking_effort as thinkingEffort,
           turn_runtime_configs.approval_mode as approvalMode,
           turn_runtime_configs.sandbox_mode as sandboxMode
         FROM turn_runtime_configs
         INNER JOIN turns ON turns.id = turn_runtime_configs.turn_id
         WHERE turns.conversation_id = ?
         ORDER BY turn_runtime_configs.created_at DESC, turns.started_at DESC
         LIMIT 1`,
      )
      .get(conversationId) as
      | {
          providerId: RuntimeConfig["providerId"]
          authMode: RuntimeConfig["authMode"] | null
          modelId: string
          thinkingEnabled: boolean | 0 | 1
          thinkingEffort: RuntimeConfig["thinkingEffort"] | null
          approvalMode: RuntimeConfig["approvalMode"]
          sandboxMode: RuntimeConfig["sandboxMode"]
        }
      | undefined

    if (!row) {
      return undefined
    }

    return {
      providerId: row.providerId,
      authMode: row.authMode ?? "api_key",
      modelId: row.modelId,
      thinkingEnabled: Boolean(row.thinkingEnabled),
      ...(row.thinkingEffort ? { thinkingEffort: row.thinkingEffort } : {}),
      approvalMode: row.approvalMode,
      sandboxMode: row.sandboxMode,
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
      const traceDocumentRows = this.handle.db
        .select({ id: traceDocuments.id })
        .from(traceDocuments)
        .where(and(eq(traceDocuments.projectId, projectId), eq(traceDocuments.conversationId, conversationId)))
        .all()
      const traceDocumentIds = traceDocumentRows.map((row) => row.id)

      if (shellCommandIds.length > 0) {
        this.handle.db.delete(shellOutputChunks).where(inArray(shellOutputChunks.shellCommandId, shellCommandIds)).run()
      }
      if (terminalIds.length > 0) {
        this.handle.db.delete(terminalOutputChunks).where(inArray(terminalOutputChunks.terminalSessionId, terminalIds)).run()
      }
      if (traceDocumentIds.length > 0) {
        this.handle.db.delete(traceEmbeddings).where(inArray(traceEmbeddings.traceDocumentId, traceDocumentIds)).run()
        const deleteFts = this.handle.sqlite.prepare("DELETE FROM trace_documents_fts WHERE trace_document_id = ?")
        for (const traceDocumentId of traceDocumentIds) {
          deleteFts.run(traceDocumentId)
        }
        this.handle.db.delete(traceDocuments).where(inArray(traceDocuments.id, traceDocumentIds)).run()
      }
      this.handle.db
        .delete(traceIndexJobs)
        .where(and(eq(traceIndexJobs.projectId, projectId), eq(traceIndexJobs.conversationId, conversationId)))
        .run()
      if (turnIds.length > 0) {
        this.handle.db.delete(turnRuntimeConfigs).where(inArray(turnRuntimeConfigs.turnId, turnIds)).run()
        this.handle.db.delete(modelStreamChunks).where(inArray(modelStreamChunks.turnId, turnIds)).run()
        this.handle.db.delete(modelUsage).where(inArray(modelUsage.turnId, turnIds)).run()
        this.handle.db.delete(aiUsageEvents).where(inArray(aiUsageEvents.turnId, turnIds)).run()
        this.handle.db.delete(turnUsageReports).where(inArray(turnUsageReports.turnId, turnIds)).run()
      }
      if (sessionIds.length > 0) {
        this.handle.db.delete(sessionState).where(inArray(sessionState.sessionId, sessionIds)).run()
      }

      this.handle.db.delete(messageFeedback).where(eq(messageFeedback.conversationId, conversationId)).run()
      this.handle.db.delete(messageAttachments).where(eq(messageAttachments.conversationId, conversationId)).run()
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

  getConversationModelMessages(
    projectId: string,
    conversationId: string,
    options: {
      includeImageParts?: boolean
      readAttachmentDataUrl?: (attachment: MessageAttachment) => string | undefined
    } = {},
  ): ConversationModelMessage[] {
    this.mustGetConversationRow(projectId, conversationId)
    const messageRows = this.handle.db
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
    const attachmentsByMessageId = this.getAttachmentsByMessageIds(messageRows.map((message) => message.id))

    return messageRows.map((message) => {
      const attachments = attachmentsByMessageId.get(message.id) ?? []
      const content = buildModelMessageContent(message.content, attachments, options)
      return {
        role: message.role as ConversationModelMessage["role"],
        content,
        id: message.id,
        ...(message.turnId ? { turnId: message.turnId } : {}),
      }
    })
  }

  private withMessageAttachments(messagesToMap: Message[]): Message[] {
    const attachmentsByMessageId = this.getAttachmentsByMessageIds(messagesToMap.map((message) => message.id))
    return messagesToMap.map((message) => {
      const attachments = attachmentsByMessageId.get(message.id)
      return attachments?.length ? { ...message, attachments } : message
    })
  }

  private getAttachmentsByMessageIds(messageIds: string[]): Map<string, MessageAttachment[]> {
    const unique = Array.from(new Set(messageIds))
    if (unique.length === 0) {
      return new Map()
    }
    const placeholders = unique.map(() => "?").join(", ")
    const rows = this.handle.sqlite
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId, session_id AS sessionId,
                turn_id AS turnId, message_id AS messageId, artifact_id AS artifactId, kind, file_name AS fileName,
                mime_type AS mimeType, size_bytes AS sizeBytes, uri, status, created_at AS createdAt
         FROM message_attachments
         WHERE status = 'attached' AND message_id IN (${placeholders})
         ORDER BY created_at`,
      )
      .all(...unique) as MessageAttachment[]
    const grouped = new Map<string, MessageAttachment[]>()
    for (const row of rows) {
      if (!row.messageId) {
        continue
      }
      row.url = `/api/projects/${encodeURIComponent(row.projectId)}/conversations/${encodeURIComponent(row.conversationId)}/attachments/${encodeURIComponent(row.id)}/content`
      grouped.set(row.messageId, [...(grouped.get(row.messageId) ?? []), row])
    }
    return grouped
  }
}

const buildModelMessageContent = (
  content: string,
  attachments: MessageAttachment[],
  options: {
    includeImageParts?: boolean
    readAttachmentDataUrl?: (attachment: MessageAttachment) => string | undefined
  },
): ConversationModelMessage["content"] => {
  if (attachments.length === 0) {
    return content
  }
  const attachmentReference = formatAttachmentReference(attachments)
  const images = attachments.filter((attachment) => attachment.kind === "image")
  if (!options.includeImageParts || images.length === 0) {
    const omitted = images.length > 0 && !options.includeImageParts
      ? `[${images.length} image attachment${images.length === 1 ? "" : "s"} retained in chat but pixels were not sent because the selected model does not support vision.]\n`
      : ""
    const manifest = `${omitted}${attachmentReference}`
    return content.trim() ? `${content}\n\n${manifest}` : manifest
  }

  const parts: ConversationModelMessage["content"] = []
  const text = [content.trim(), attachmentReference].filter(Boolean).join("\n\n")
  parts.push({ type: "text", text })
  for (const attachment of images) {
    const data = options.readAttachmentDataUrl?.(attachment)
    if (data) {
      parts.push({ type: "image", mediaType: attachment.mimeType, data, fileName: attachment.fileName })
    }
  }
  return parts.length > 0 ? parts : content
}

const formatAttachmentReference = (attachments: MessageAttachment[]): string =>
  [
    "Conversation attachments are stored in the workspace. Before answering from an attached text file, inspect the relevant content with read or search instead of guessing:",
    ...attachments.map(
      (attachment) =>
        `- ${attachment.kind} ${attachment.fileName}: ${attachmentReferencePath(attachment.uri)} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
    ),
  ].join("\n")

const attachmentReferencePath = (uri: string): string => {
  const normalized = uri.split(path.sep).join("/")
  const marker = "/.socrates/"
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + 1)
  }
  return path.basename(uri)
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
