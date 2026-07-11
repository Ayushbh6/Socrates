import type { WebSocket } from "ws"
import type { SocratesAgent } from "@socrates/core"
import type { McpRuntime } from "@socrates/mcp"
import type { ModelProvider } from "@socrates/providers"
import { clientCommandSchema } from "@socrates/contracts"
import { normalizeError, SocratesError } from "@socrates/shared"
import { apiError } from "../http"
import type { SocratesStore } from "../services/store"
import type { ActiveTurns } from "./activeTurns"
import type { ConversationTerminalManager } from "./conversationTerminals"
import type { ConversationSubscriptions } from "./conversationSubscriptions"
import { handleApprovalDecide } from "./commandHandlers/approvalDecide"
import { handleChatMessageSend } from "./commandHandlers/chatMessageSend"
import { handleTurnCancel } from "./commandHandlers/chatTurnCancel"
import { handleFeedbackSubmit } from "./commandHandlers/feedbackSubmit"
import { emitError, emitNormalizedError, idsFromCommand } from "./eventSender"

export const handleInboundMessage = async (
  socket: WebSocket,
  store: SocratesStore,
  agent: SocratesAgent,
  activeTurns: ActiveTurns,
  terminals: ConversationTerminalManager,
  subscriptions: ConversationSubscriptions,
  raw: string,
  mcpRuntime?: McpRuntime,
  titleProvider?: ModelProvider,
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
      case "chat.conversation.subscribe":
        const subscriptionScope = requireConversationScope(store, command)
        subscriptions.subscribe(socket, subscriptionScope.conversationId)
        if (command.payload.replayActiveTurn !== false) {
          for (const event of store.listActiveTurnServerEvents(subscriptionScope.projectId, subscriptionScope.conversationId)) {
            subscriptions.send(socket, event)
          }
        }
        return
      case "chat.conversation.unsubscribe":
        if (command.conversationId) {
          subscriptions.unsubscribe(socket, command.conversationId)
        } else {
          subscriptions.unsubscribeAll(socket)
        }
        return
      case "chat.message.send":
        const messageScope = requireConversationScope(store, command)
        subscriptions.subscribe(socket, messageScope.conversationId)
        void handleChatMessageSend(socket, store, agent, activeTurns, terminals, subscriptions, command, mcpRuntime, titleProvider).catch((error) => {
          const normalized = normalizeError(error)
          emitNormalizedError(socket, store, normalized, idsFromCommand(command))
        })
        return
      case "chat.turn.cancel":
        handleTurnCancel(socket, store, activeTurns, subscriptions, command)
        return
      case "approval.decide":
        handleApprovalDecide(store, activeTurns, command)
        return
      case "terminal.stop":
        requireSubscribedConversationScope(socket, store, subscriptions, command)
        void terminals.handleStop(command).catch((error) => {
          if (socket.readyState !== 1) {
            return
          }
          const normalized = normalizeError(error)
          emitNormalizedError(socket, store, normalized, idsFromCommand(command))
        })
        return
      case "terminal.input":
        requireSubscribedConversationScope(socket, store, subscriptions, command)
        await terminals.handleInput(command)
        return
      case "terminal.resize":
        requireSubscribedConversationScope(socket, store, subscriptions, command)
        await terminals.handleResize(command)
        return
      case "terminal.rename":
        requireSubscribedConversationScope(socket, store, subscriptions, command)
        terminals.handleRename(command)
        return
      case "feedback.submit":
        handleFeedbackSubmit(store, command)
        return
    }
  } catch (error) {
    const normalized = normalizeError(error)
    emitNormalizedError(socket, store, normalized, idsFromCommand(command))
  }
}

const requireConversationScope = (
  store: SocratesStore,
  command: { projectId?: string | undefined; conversationId?: string | undefined },
): { projectId: string; conversationId: string } => {
  if (!command.projectId || !command.conversationId) {
    throw new SocratesError("missing_command_scope", "projectId and conversationId are required for this command", { recoverable: true })
  }
  store.getConversation(command.projectId, command.conversationId)
  return { projectId: command.projectId, conversationId: command.conversationId }
}

const requireSubscribedConversationScope = (
  socket: WebSocket,
  store: SocratesStore,
  subscriptions: ConversationSubscriptions,
  command: { projectId?: string | undefined; conversationId?: string | undefined },
): { projectId: string; conversationId: string } => {
  const scope = requireConversationScope(store, command)
  if (!subscriptions.isSubscribed(socket, scope.conversationId)) {
    throw new SocratesError("terminal_conversation_not_subscribed", "Subscribe to the Terminal conversation before sending Terminal controls.", {
      recoverable: true,
    })
  }
  return scope
}
