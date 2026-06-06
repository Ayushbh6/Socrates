import type { WebSocket } from "ws"
import type { ClientCommand } from "@socrates/contracts"
import type { SocratesStore } from "../../services/store"
import type { ActiveTurns } from "../activeTurns"
import type { ConversationSubscriptions } from "../conversationSubscriptions"
import { makeEvent } from "../eventSender"

export const handleTurnCancel = (
  socket: WebSocket,
  store: SocratesStore,
  activeTurns: ActiveTurns,
  subscriptions: ConversationSubscriptions,
  command: Extract<ClientCommand, { type: "chat.turn.cancel" }>,
): void => {
  if (command.conversationId) {
    subscriptions.subscribe(socket, command.conversationId)
  }
  const controller = activeTurns.get(command.payload.turnId)
  if (controller) {
    controller.abort()
    activeTurns.delete(command.payload.turnId)
  }
  const cancelled = store.cancelTurn(command.payload.turnId, command.payload.reason)
  store.indexTurnTraceDocuments(cancelled.projectId, cancelled.conversationId, cancelled.turnId)

  subscriptions.emit(
    makeEvent(
      "turn.cancelled",
      {
        turnId: cancelled.turnId,
        reason: command.payload.reason,
        ...(cancelled.partialAssistantMessage ? { partialAssistantMessage: cancelled.partialAssistantMessage } : {}),
      },
      {
        projectId: cancelled.projectId,
        conversationId: cancelled.conversationId,
        sessionId: cancelled.sessionId,
        turnId: cancelled.turnId,
        actor: { type: "system" },
      },
    ),
    socket,
  )
}
