import type { WebSocket } from "ws"
import { findModelOption, type SocratesAgent } from "@socrates/core"
import type { ClientCommand, ModelUsage } from "@socrates/contracts"
import { normalizeError, SocratesError } from "@socrates/shared"
import { apiError } from "../../http"
import type { SocratesStore } from "../../services/store"
import type { ActiveTurns } from "../activeTurns"
import { appendAndSend, makeEvent, sendEvent } from "../eventSender"

const requireCommandScope = (command: ClientCommand): { projectId: string; conversationId: string } => {
  if (!command.projectId || !command.conversationId) {
    throw new SocratesError("missing_command_scope", "projectId and conversationId are required for this command")
  }
  return { projectId: command.projectId, conversationId: command.conversationId }
}

export const handleChatMessageSend = async (
  socket: WebSocket,
  store: SocratesStore,
  agent: SocratesAgent,
  activeTurns: ActiveTurns,
  command: Extract<ClientCommand, { type: "chat.message.send" }>,
): Promise<void> => {
  const { projectId, conversationId } = requireCommandScope(command)
  const created = store.createTurnFromUserMessage(projectId, conversationId, command.payload)
  const abortController = activeTurns.create(created.turnId)

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
