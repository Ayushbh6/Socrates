import type { FastifyInstance } from "fastify"
import websocket from "@fastify/websocket"
import type { WebSocket } from "ws"
import { createDefaultSocratesAgent, findModelOption, type SocratesAgent } from "@socrates/core"
import {
  clientCommandSchema,
  type ClientCommand,
  type ModelUsage,
  type ServerEvent,
  serverEventSchema,
} from "@socrates/contracts"
import { createId, nowIso, normalizeError, SocratesError } from "@socrates/shared"
import { apiError } from "../http"
import type { SocratesStore } from "../services/store"

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

export const registerWebSocketRoutes = async (
  app: FastifyInstance,
  store: SocratesStore,
  agent: SocratesAgent = createDefaultSocratesAgent(),
): Promise<void> => {
  await app.register(websocket)

  const activeTurns = new Map<string, AbortController>()

  app.addHook("onClose", async () => {
    for (const controller of activeTurns.values()) {
      controller.abort()
    }
    activeTurns.clear()
  })

  app.get("/ws", { websocket: true }, (socket) => {
    const ready = makeEvent("connection.ready", {
      connectionId: createId("conn"),
      serverTime: nowIso(),
    })
    sendEvent(socket, ready)

    socket.on("message", (raw) => {
      void handleInboundMessage(socket, store, agent, activeTurns, raw.toString())
    })
  })
}

const handleInboundMessage = async (
  socket: WebSocket,
  store: SocratesStore,
  agent: SocratesAgent,
  activeTurns: Map<string, AbortController>,
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
        void handleChatMessageSend(socket, store, agent, activeTurns, command).catch((error) => {
          const normalized = normalizeError(error)
          emitError(socket, store, apiError(normalized.code, normalized.message, { details: normalized.details }), {
            ...idsFromCommand(command),
            recoverable: normalized.recoverable,
          })
        })
        return
      case "chat.turn.cancel":
        handleTurnCancel(socket, store, activeTurns, command)
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

const handleChatMessageSend = async (
  socket: WebSocket,
  store: SocratesStore,
  agent: SocratesAgent,
  activeTurns: Map<string, AbortController>,
  command: Extract<ClientCommand, { type: "chat.message.send" }>,
): Promise<void> => {
  const { projectId, conversationId } = requireCommandScope(command)
  const created = store.createTurnFromUserMessage(projectId, conversationId, command.payload)
  const abortController = new AbortController()
  activeTurns.set(created.turnId, abortController)

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

  const history = store.getConversationModelMessages(projectId, conversationId)
  const promptContext = store.getAgentContext(projectId)
  const modelCallId = store.createModelCall({
    conversationId,
    sessionId: created.sessionId,
    turnId: created.turnId,
    runtimeConfigId: created.runtimeConfigId,
    providerId: command.payload.runtimeConfig.providerId,
    modelId: command.payload.runtimeConfig.modelId,
    request: {
      providerId: command.payload.runtimeConfig.providerId,
      modelId: command.payload.runtimeConfig.modelId,
      messages: history,
      promptContext,
      runtimeConfig: command.payload.runtimeConfig,
    },
  })

  let answerText = ""
  let reasoningText = ""
  let latestUsage: ModelUsage | undefined

  try {
    for await (const modelEvent of agent.streamTurn({
      providerId: command.payload.runtimeConfig.providerId,
      modelId: command.payload.runtimeConfig.modelId,
      runtimeConfig: command.payload.runtimeConfig,
      messages: history,
      promptContext,
      abortSignal: abortController.signal,
    })) {
      if (abortController.signal.aborted) {
        return
      }

      if (modelEvent.type === "model.reasoning.delta") {
        reasoningText += modelEvent.text
        store.appendModelStreamChunk({
          modelCallId,
          turnId: created.turnId,
          channel: "reasoning",
          text: modelEvent.text,
        })
        const event = makeEvent(
          "agent.thinking.delta",
          { text: modelEvent.text },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "main_agent" },
          },
        )
        appendAndSend(socket, store, event, "core")
      }

      if (modelEvent.type === "model.answer.delta") {
        answerText += modelEvent.text
        store.appendModelStreamChunk({
          modelCallId,
          turnId: created.turnId,
          channel: "answer",
          text: modelEvent.text,
        })
        const event = makeEvent(
          "agent.answer.delta",
          { messageId: modelCallId, text: modelEvent.text },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "main_agent" },
          },
        )
        appendAndSend(socket, store, event, "core")
      }

      if (modelEvent.type === "model.usage") {
        latestUsage = modelEvent.usage
      }

      if (modelEvent.type === "model.completed") {
        latestUsage = modelEvent.usage ?? latestUsage
      }

      if (modelEvent.type === "model.failed") {
        throw modelEvent.error
      }
    }

    const assistantMessage = store.completeAgentTurn({
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      content: answerText,
      reasoning: reasoningText,
    })
    store.completeModelCall({
      modelCallId,
      response: { messageId: assistantMessage.id, finish: "completed" },
      ...(latestUsage ? { usage: toStoredUsage(latestUsage) } : {}),
    })

    const messageCompleted = makeEvent(
      "message.completed",
      {
        message: assistantMessage,
        ...(latestUsage ? { usage: toContractUsage(latestUsage) } : {}),
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    )
    appendAndSend(socket, store, messageCompleted, "core")

    const tokenUsage = store.getConversationTokenUsage(conversationId)
    const model = findModelOption(command.payload.runtimeConfig.providerId, command.payload.runtimeConfig.modelId)
    if (model?.contextWindowTokens) {
      store.recordContextUsageSnapshot({
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        modelCallId,
        providerId: command.payload.runtimeConfig.providerId,
        modelId: command.payload.runtimeConfig.modelId,
        contextWindowTokens: model.contextWindowTokens,
        contextUsedTokens: tokenUsage.totalTokens,
      })
      const contextUsage = makeEvent(
        "context.usage.snapshot",
        {
          providerId: command.payload.runtimeConfig.providerId,
          modelId: command.payload.runtimeConfig.modelId,
          contextWindowTokens: model.contextWindowTokens,
          contextUsedTokens: tokenUsage.totalTokens,
          contextLeftTokens: Math.max(model.contextWindowTokens - tokenUsage.totalTokens, 0),
          contextUsedPercent: Math.min(100, Math.round((tokenUsage.totalTokens / model.contextWindowTokens) * 1000) / 10),
        },
        {
          projectId,
          conversationId,
          sessionId: created.sessionId,
          turnId: created.turnId,
          actor: { type: "main_agent" },
        },
      )
      appendAndSend(socket, store, contextUsage, "core")
    }

    const turnCompleted = makeEvent(
      "turn.completed",
      {
        turnId: created.turnId,
        assistantMessageId: assistantMessage.id,
        summary: "Agent response completed.",
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    )
    appendAndSend(socket, store, turnCompleted, "core")
  } catch (error) {
    if (abortController.signal.aborted) {
      return
    }
    const normalized = normalizeError(error)
    const errorId = store.failTurn({
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    })
    store.failModelCall(modelCallId, errorId)
    const failed = makeEvent(
      "turn.failed",
      {
        turnId: created.turnId,
        error: apiError(normalized.code, normalized.message, { details: normalized.details }),
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    )
    appendAndSend(socket, store, failed, "core")
  } finally {
    activeTurns.delete(created.turnId)
  }
}

const handleTurnCancel = (
  socket: WebSocket,
  store: SocratesStore,
  activeTurns: Map<string, AbortController>,
  command: Extract<ClientCommand, { type: "chat.turn.cancel" }>,
): void => {
  const controller = activeTurns.get(command.payload.turnId)
  if (controller) {
    controller.abort()
    activeTurns.delete(command.payload.turnId)
  }
  const cancelled = store.cancelTurn(command.payload.turnId, command.payload.reason)

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

const appendAndSend = (socket: WebSocket, store: SocratesStore, event: ServerEvent, source: string): void => {
  store.appendEvent({
    ...(event.projectId ? { projectId: event.projectId } : {}),
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    type: event.type,
    source,
    payload: event.payload,
  })
  sendEvent(socket, event)
}

const toContractUsage = (usage: ModelUsage) => ({
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
})

const toStoredUsage = (usage: ModelUsage) => ({
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
})

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
