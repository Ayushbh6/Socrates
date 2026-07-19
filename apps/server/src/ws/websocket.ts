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
import type { V2FlowStore } from "../services/v2/flowStore"

export const registerWebSocketRoutes = async (
  app: FastifyInstance,
  store: SocratesStore,
  terminals: ConversationTerminalManager,
  subscriptions: ConversationSubscriptions,
  agent: SocratesAgent = createDefaultSocratesAgent(),
  mcpRuntime?: McpRuntime,
  titleProvider?: ModelProvider,
  flowStore?: V2FlowStore,
): Promise<{ shutdown: () => Promise<boolean> }> => {
  await app.register(websocket)

  const activeTurns = new ActiveTurns()
  let acceptingTaskWakes = true
  terminals.setTaskWakeHandler((task) => {
    if (!acceptingTaskWakes) return
    void resumeTerminalTask(store, agent, activeTurns, terminals, subscriptions, task, mcpRuntime, titleProvider, flowStore).catch(() => {
      // The durable task remains available for a later reconciliation if a continuation cannot start.
    })
  })
  for (const task of store.listReadyTerminalTasks()) {
    if (!acceptingTaskWakes) break
    void resumeTerminalTask(store, agent, activeTurns, terminals, subscriptions, task, mcpRuntime, titleProvider, flowStore).catch(() => undefined)
  }

  app.get("/ws", { websocket: true }, (socket) => {
    const ready = makeEvent("connection.ready", {
      connectionId: createId("conn"),
      serverTime: nowIso(),
    })
    sendEvent(socket, ready)

    socket.on("message", (raw) => {
      void handleInboundMessage(socket, store, agent, activeTurns, terminals, subscriptions, raw.toString(), mcpRuntime, titleProvider, flowStore)
    })
  })

  return {
    shutdown: async () => {
      acceptingTaskWakes = false
      terminals.clearTaskWakeHandler()
      activeTurns.abortAll()
      return activeTurns.waitForIdle()
    },
  }
}
