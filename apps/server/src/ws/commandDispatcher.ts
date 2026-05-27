import type { WebSocket } from "ws"
import type { SocratesAgent } from "@socrates/core"
import { clientCommandSchema } from "@socrates/contracts"
import { normalizeError } from "@socrates/shared"
import { apiError } from "../http"
import type { SocratesStore } from "../services/store"
import type { ActiveTurns } from "./activeTurns"
import type { ConversationTerminalManager } from "./conversationTerminals"
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
        void handleChatMessageSend(socket, store, agent, activeTurns, terminals, command).catch((error) => {
          const normalized = normalizeError(error)
          emitNormalizedError(socket, store, normalized, idsFromCommand(command))
        })
        return
      case "chat.turn.cancel":
        handleTurnCancel(socket, store, activeTurns, command)
        return
      case "approval.decide":
        handleApprovalDecide(store, activeTurns, command)
        return
      case "terminal.stop":
        terminals.handleStop(command)
        return
      case "terminal.input":
        terminals.handleInput(command)
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
