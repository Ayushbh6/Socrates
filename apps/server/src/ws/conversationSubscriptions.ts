import type { WebSocket } from "ws"
import type { ServerEvent } from "@socrates/contracts"
import { sendEvent } from "./eventSender"

export class ConversationSubscriptions {
  private readonly socketsByConversation = new Map<string, Set<WebSocket>>()
  private readonly conversationsBySocket = new WeakMap<WebSocket, Set<string>>()
  private readonly closeHandlerAttached = new WeakSet<WebSocket>()

  subscribe(socket: WebSocket, conversationId: string): void {
    this.ensureCloseHandler(socket)
    const sockets = this.socketsByConversation.get(conversationId) ?? new Set<WebSocket>()
    sockets.add(socket)
    this.socketsByConversation.set(conversationId, sockets)

    const conversations = this.conversationsBySocket.get(socket) ?? new Set<string>()
    conversations.add(conversationId)
    this.conversationsBySocket.set(socket, conversations)
  }

  unsubscribe(socket: WebSocket, conversationId: string): void {
    this.socketsByConversation.get(conversationId)?.delete(socket)
    const conversations = this.conversationsBySocket.get(socket)
    conversations?.delete(conversationId)
  }

  unsubscribeAll(socket: WebSocket): void {
    const conversations = this.conversationsBySocket.get(socket)
    if (!conversations) {
      return
    }
    for (const conversationId of conversations) {
      this.socketsByConversation.get(conversationId)?.delete(socket)
    }
    conversations.clear()
  }

  emit(event: ServerEvent, fallbackSocket?: WebSocket): void {
    const recipients = new Set<WebSocket>()
    if (event.conversationId) {
      for (const socket of this.socketsByConversation.get(event.conversationId) ?? []) {
        recipients.add(socket)
      }
    }
    if (fallbackSocket) {
      recipients.add(fallbackSocket)
    }
    for (const socket of recipients) {
      sendEvent(socket, event)
    }
  }

  send(socket: WebSocket, event: ServerEvent): void {
    sendEvent(socket, event)
  }

  private ensureCloseHandler(socket: WebSocket): void {
    if (this.closeHandlerAttached.has(socket)) {
      return
    }
    this.closeHandlerAttached.add(socket)
    socket.on("close", () => this.unsubscribeAll(socket))
  }
}
