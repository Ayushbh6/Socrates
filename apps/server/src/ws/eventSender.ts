import type { WebSocket } from "ws"
import type { ApiError, ClientCommand, ServerEvent } from "@socrates/contracts"
import { serverEventSchema } from "@socrates/contracts"
import { createId, nowIso } from "@socrates/shared"
import { apiError } from "../http"
import type { SocratesStore } from "../services/store"

export const makeEvent = <T extends ServerEvent["type"]>(
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

export type EventSink = (event: ServerEvent) => void

export const sendEvent = (socket: WebSocket, event: ServerEvent): boolean => {
  if (socket.readyState !== 1) {
    return false
  }
  try {
    socket.send(JSON.stringify(event))
    return true
  } catch {
    return false
  }
}

export const idsFromCommand = (command: ClientCommand) => ({
  ...(command.projectId ? { projectId: command.projectId } : {}),
  ...(command.conversationId ? { conversationId: command.conversationId } : {}),
  ...(command.sessionId ? { sessionId: command.sessionId } : {}),
  ...(command.turnId ? { turnId: command.turnId } : {}),
})

const appendEvent = (store: SocratesStore, event: ServerEvent, source: string): void => {
  store.appendEvent({
    ...(event.projectId ? { projectId: event.projectId } : {}),
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    type: event.type,
    source,
    payload: event.payload,
  })
}

export const appendAndSend = (socket: WebSocket, store: SocratesStore, event: ServerEvent, source: string): void => {
  appendEvent(store, event, source)
  sendEvent(socket, event)
}

export const appendAndEmit = (emit: EventSink, store: SocratesStore, event: ServerEvent, source: string): void => {
  appendEvent(store, event, source)
  emit(event)
}

export const emitError = (
  socket: WebSocket,
  store: SocratesStore,
  error: ApiError,
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

export const emitNormalizedError = (
  socket: WebSocket,
  store: SocratesStore,
  error: { code: string; message: string; details?: unknown; recoverable: boolean },
  context: {
    projectId?: string
    conversationId?: string
    sessionId?: string
    turnId?: string
  },
): void => {
  emitError(socket, store, apiError(error.code, error.message, { details: error.details }), {
    ...context,
    recoverable: error.recoverable,
  })
}
