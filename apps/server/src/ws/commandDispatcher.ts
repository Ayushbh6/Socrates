import type { WebSocket } from "ws"
import type { SocratesAgent } from "@socrates/core"
import type { McpRuntime } from "@socrates/mcp"
import type { ModelProvider } from "@socrates/providers"
import { clientCommandSchema } from "@socrates/contracts"
import { normalizeError } from "@socrates/shared"
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
        if (!command.projectId || !command.conversationId) {
          emitError(socket, store, apiError("missing_command_scope", "projectId and conversationId are required for this command"), {
            recoverable: true,
          })
          return
        }
        subscriptions.subscribe(socket, command.conversationId)
        if (command.payload.replayActiveTurn !== false) {
          for (const event of store.listActiveTurnServerEvents(command.projectId, command.conversationId)) {
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
        if (command.conversationId) {
          subscriptions.subscribe(socket, command.conversationId)
        }
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
        void terminals.handleStop(command).catch((error) => {
          if (socket.readyState !== 1) {
            return
          }
          const normalized = normalizeError(error)
          emitNormalizedError(socket, store, normalized, idsFromCommand(command))
        })
        return
      case "terminal.input":
        await terminals.handleInput(command)
        return
      case "terminal.resize":
        await terminals.handleResize(command)
        return
      case "terminal.rename":
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
