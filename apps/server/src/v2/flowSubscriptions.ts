import type { WebSocket } from "ws"
import type { V2ServerEvent } from "@socrates/contracts"
import { sendV2Event } from "./eventSender"

export class V2FlowSubscriptions {
  private readonly socketsByFlow = new Map<string, Set<WebSocket>>()
  private readonly flowsBySocket = new WeakMap<WebSocket, Set<string>>()
  private readonly closeHandlerAttached = new WeakSet<WebSocket>()

  subscribe(socket: WebSocket, flowId: string): void {
    this.ensureCloseHandler(socket)
    const sockets = this.socketsByFlow.get(flowId) ?? new Set<WebSocket>()
    sockets.add(socket)
    this.socketsByFlow.set(flowId, sockets)
    const flows = this.flowsBySocket.get(socket) ?? new Set<string>()
    flows.add(flowId)
    this.flowsBySocket.set(socket, flows)
  }

  unsubscribe(socket: WebSocket, flowId: string): void {
    this.socketsByFlow.get(flowId)?.delete(socket)
    this.flowsBySocket.get(socket)?.delete(flowId)
  }

  unsubscribeAll(socket: WebSocket): void {
    for (const flowId of this.flowsBySocket.get(socket) ?? []) {
      this.socketsByFlow.get(flowId)?.delete(socket)
    }
    this.flowsBySocket.get(socket)?.clear()
  }

  isSubscribed(socket: WebSocket, flowId: string): boolean {
    return this.flowsBySocket.get(socket)?.has(flowId) ?? false
  }

  emit(event: V2ServerEvent, fallbackSocket?: WebSocket): void {
    const recipients = new Set<WebSocket>(this.socketsByFlow.get(event.flowId) ?? [])
    if (fallbackSocket) recipients.add(fallbackSocket)
    for (const socket of recipients) sendV2Event(socket, event)
  }

  send(socket: WebSocket, event: V2ServerEvent): void {
    sendV2Event(socket, event)
  }

  private ensureCloseHandler(socket: WebSocket): void {
    if (this.closeHandlerAttached.has(socket)) return
    this.closeHandlerAttached.add(socket)
    socket.on("close", () => this.unsubscribeAll(socket))
  }
}
