import type { FastifyInstance } from "fastify"
import websocket from "@fastify/websocket"
import { createDefaultSocratesAgent, type SocratesAgent } from "@socrates/core"
import { createId, nowIso } from "@socrates/shared"
import type { SocratesStore } from "../services/store"
import { ActiveTurns } from "./activeTurns"
import { handleInboundMessage } from "./commandDispatcher"
import { makeEvent, sendEvent } from "./eventSender"

export const registerWebSocketRoutes = async (
  app: FastifyInstance,
  store: SocratesStore,
  agent: SocratesAgent = createDefaultSocratesAgent(),
): Promise<void> => {
  await app.register(websocket)

  const activeTurns = new ActiveTurns()

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
      void handleInboundMessage(socket, store, agent, activeTurns, raw.toString())
    })
  })
}
