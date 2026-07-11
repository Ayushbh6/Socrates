import type { FastifyInstance } from "fastify"
import websocket from "@fastify/websocket"
import { createDefaultSocratesAgent, type SocratesAgent } from "@socrates/core"
import type { McpRuntime } from "@socrates/mcp"
import type { ModelProvider } from "@socrates/providers"
import { createId, nowIso } from "@socrates/shared"
import type { SocratesStore } from "../services/store"
import { ActiveTurns } from "./activeTurns"
import type { ConversationTerminalManager } from "./conversationTerminals"
import { ConversationSubscriptions } from "./conversationSubscriptions"
import { handleInboundMessage } from "./commandDispatcher"
import { resumeTerminalTask } from "./commandHandlers/chatMessageSend"
import { makeEvent, sendEvent } from "./eventSender"

export const registerWebSocketRoutes = async (
  app: FastifyInstance,
  store: SocratesStore,
  terminals: ConversationTerminalManager,
  subscriptions: ConversationSubscriptions,
  agent: SocratesAgent = createDefaultSocratesAgent(),
  mcpRuntime?: McpRuntime,
  titleProvider?: ModelProvider,
): Promise<void> => {
  await app.register(websocket)

  const activeTurns = new ActiveTurns()
  terminals.setTaskWakeHandler((task) => {
    void resumeTerminalTask(store, agent, activeTurns, terminals, subscriptions, task, mcpRuntime, titleProvider).catch(() => {
      // The durable task remains available for a later reconciliation if a continuation cannot start.
    })
  })
  for (const task of store.listReadyTerminalTasks()) {
    void resumeTerminalTask(store, agent, activeTurns, terminals, subscriptions, task, mcpRuntime, titleProvider).catch(() => undefined)
  }
  app.addHook("onClose", async () => {
    activeTurns.abortAll()
  })

  app.get("/ws", { websocket: true }, (socket) => {
    const ready = makeEvent("connection.ready", {
      connectionId: createId("conn"),
      serverTime: nowIso(),
    })
    sendEvent(socket, ready)

    socket.on("message", (raw) => {
      void handleInboundMessage(socket, store, agent, activeTurns, terminals, subscriptions, raw.toString(), mcpRuntime, titleProvider)
    })
  })
}
