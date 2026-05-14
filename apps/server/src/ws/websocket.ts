import type { FastifyInstance } from "fastify"
import websocket from "@fastify/websocket"
import type { WebSocket } from "ws"
import {
  clientCommandSchema,
  type ClientCommand,
  type ServerEvent,
  serverEventSchema,
} from "@socrates/contracts"
import { createId, nowIso, normalizeError, SocratesError } from "@socrates/shared"
import { apiError } from "../http"
import type { SocratesStore } from "../services/store"

const placeholderDelayMs = 50

const makeEvent = <T extends ServerEvent["type"]>(
  type: T,
  payload: Extract<ServerEvent, { type: T }>["payload"],
  context: Omit<Partial<ServerEvent>, "type" | "payload" | "schemaVersion" | "timestamp" | "id"> = {},
): ServerEvent => {
  const event = {
    id: createId("evt"),
    type,
    schemaVersion: 1,
    timestamp: nowIso(),
    actor: { type: "system" as const },
    ...context,
    payload,
  }
  return serverEventSchema.parse(event)
}

const sendEvent = (socket: WebSocket, event: ServerEvent): void => {
  socket.send(JSON.stringify(event))
}

const idsFromCommand = (command: ClientCommand) => ({
  ...(command.projectId ? { projectId: command.projectId } : {}),
  ...(command.conversationId ? { conversationId: command.conversationId } : {}),
  ...(command.sessionId ? { sessionId: command.sessionId } : {}),
  ...(command.turnId ? { turnId: command.turnId } : {}),
})

const requireCommandScope = (command: ClientCommand): { projectId: string; conversationId: string } => {
  if (!command.projectId || !command.conversationId) {
    throw new SocratesError("missing_command_scope", "projectId and conversationId are required for this command")
  }
  return { projectId: command.projectId, conversationId: command.conversationId }
}

export const registerWebSocketRoutes = async (app: FastifyInstance, store: SocratesStore): Promise<void> => {
  await app.register(websocket)

  const completionTimers = new Map<string, NodeJS.Timeout>()

  app.addHook("onClose", async () => {
    for (const timer of completionTimers.values()) {
      clearTimeout(timer)
    }
    completionTimers.clear()
  })

  app.get("/ws", { websocket: true }, (socket) => {
    const ready = makeEvent("connection.ready", {
      connectionId: createId("conn"),
      serverTime: nowIso(),
    })
    sendEvent(socket, ready)

    socket.on("message", (raw) => {
      void handleInboundMessage(socket, store, completionTimers, raw.toString())
    })
  })
}

const handleInboundMessage = async (
  socket: WebSocket,
  store: SocratesStore,
  completionTimers: Map<string, NodeJS.Timeout>,
  raw: string,
): Promise<void> => {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    emitError(socket, store, apiError("invalid_json", "WebSocket message must be valid JSON"), { recoverable: true })
    return
  }

  const parsed = clientCommandSchema.safeParse(parsedJson)
  if (!parsed.success) {
    emitError(
      socket,
      store,
      apiError("invalid_websocket_command", "WebSocket command did not match the contract", {
        details: parsed.error.flatten(),
      }),
      { recoverable: true },
    )
    return
  }

  const command = parsed.data

  try {
    switch (command.type) {
      case "chat.message.send":
        handleChatMessageSend(socket, store, completionTimers, command)
        return
      case "chat.turn.cancel":
        handleTurnCancel(socket, store, completionTimers, command)
        return
      case "approval.decide":
        store.resolveApproval(command.payload.approvalId, command.payload.decision, command.payload.reason)
        return
      case "feedback.submit":
        store.submitFeedback(command.payload)
        return
    }
  } catch (error) {
    const normalized = normalizeError(error)
    emitError(socket, store, apiError(normalized.code, normalized.message, { details: normalized.details }), {
      ...idsFromCommand(command),
      recoverable: normalized.recoverable,
    })
  }
}

const handleChatMessageSend = (
  socket: WebSocket,
  store: SocratesStore,
  completionTimers: Map<string, NodeJS.Timeout>,
  command: Extract<ClientCommand, { type: "chat.message.send" }>,
): void => {
  const { projectId, conversationId } = requireCommandScope(command)
  const created = store.createTurnFromUserMessage(projectId, conversationId, command.payload)

  sendEvent(
    socket,
    makeEvent(
      "turn.started",
      {
        turnId: created.turnId,
        userMessage: created.userMessage,
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    ),
  )

  const timer = setTimeout(() => {
    completionTimers.delete(created.turnId)
    const assistantMessage = store.completePlaceholderTurn(projectId, conversationId, created.turnId)
    if (!assistantMessage) {
      return
    }

    const messageCompleted = makeEvent(
      "message.completed",
      {
        message: assistantMessage,
        usage: {
          inputTokens: command.payload.content.length,
          outputTokens: assistantMessage.content.length,
          totalTokens: command.payload.content.length + assistantMessage.content.length,
        },
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    )
    store.appendEvent({
      projectId,
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      type: "message.completed",
      source: "server",
      payload: messageCompleted.payload,
    })
    sendEvent(socket, messageCompleted)

    const turnCompleted = makeEvent(
      "turn.completed",
      {
        turnId: created.turnId,
        assistantMessageId: assistantMessage.id,
        summary: "Placeholder backend lifecycle completed.",
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    )
    store.appendEvent({
      projectId,
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      type: "turn.completed",
      source: "server",
      payload: turnCompleted.payload,
    })
    sendEvent(socket, turnCompleted)
  }, placeholderDelayMs)

  completionTimers.set(created.turnId, timer)
}

const handleTurnCancel = (
  socket: WebSocket,
  store: SocratesStore,
  completionTimers: Map<string, NodeJS.Timeout>,
  command: Extract<ClientCommand, { type: "chat.turn.cancel" }>,
): void => {
  const cancelled = store.cancelTurn(command.payload.turnId, command.payload.reason)
  const timer = completionTimers.get(cancelled.turnId)
  if (timer) {
    clearTimeout(timer)
    completionTimers.delete(cancelled.turnId)
  }

  sendEvent(
    socket,
    makeEvent(
      "turn.cancelled",
      {
        turnId: cancelled.turnId,
        reason: command.payload.reason,
      },
      {
        projectId: cancelled.projectId,
        conversationId: cancelled.conversationId,
        sessionId: cancelled.sessionId,
        turnId: cancelled.turnId,
        actor: { type: "system" },
      },
    ),
  )
}

const emitError = (
  socket: WebSocket,
  store: SocratesStore,
  error: ReturnType<typeof apiError>,
  context: {
    projectId?: string
    conversationId?: string
    sessionId?: string
    turnId?: string
    recoverable: boolean
  },
): void => {
  store.recordError({
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    source: "websocket",
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
    recoverable: context.recoverable,
  })

  const event = makeEvent(
    "error.created",
    {
      error,
      recoverable: context.recoverable,
    },
    {
      ...(context.projectId ? { projectId: context.projectId } : {}),
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.turnId ? { turnId: context.turnId } : {}),
      actor: { type: "system" },
    },
  )
  store.appendEvent({
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    type: "error.created",
    source: "websocket",
    payload: event.payload,
  })
  sendEvent(socket, event)
}
