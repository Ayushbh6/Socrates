import type { FastifyInstance } from "fastify"
import websocket from "@fastify/websocket"
import type { WebSocket } from "ws"
import { v2ClientCommandSchema, type V2ClientCommand } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { V2ExecutionRuntime, type V2ExecutionRuntimeDeps } from "./runtime"

export type V2WebSocketRuntime = {
  runtime: V2ExecutionRuntime
  subscriptions: V2ExecutionRuntime["subscriptions"]
  shutdown: () => Promise<boolean>
}

/**
 * Registers a standalone, namespaced V2 websocket. If Classic already mounted
 * `@fastify/websocket`, the shared Fastify decorator is reused; otherwise this
 * function can be used in isolation by tests or a V2-only host.
 */
export const registerV2WebSocketRoutes = async (
  app: FastifyInstance,
  deps: V2ExecutionRuntimeDeps,
): Promise<V2WebSocketRuntime> => {
  if (!app.hasDecorator("websocketServer")) await app.register(websocket)
  const runtime = new V2ExecutionRuntime(deps)
  await runtime.initialize()

  app.get("/v2/ws", { websocket: true }, (socket) => {
    // The socket opens silently because the V2 envelope requires projectId and
    // flowId. `v2.connection.ready` is sent immediately after the first valid
    // flow subscription, followed by replay and an authoritative snapshot.
    socket.on("message", (raw) => {
      void handleV2InboundMessage(socket, runtime, raw.toString())
    })
  })

  return {
    runtime,
    subscriptions: runtime.subscriptions,
    shutdown: () => runtime.shutdown(),
  }
}

export const handleV2InboundMessage = async (
  socket: WebSocket,
  runtime: V2ExecutionRuntime,
  raw: string,
): Promise<void> => {
  let parsedJson: unknown
  try {
    // Never log `raw`: a credential submission may contain a secret that is
    // permitted to exist only for the in-memory ActiveTurns handoff.
    parsedJson = JSON.parse(raw)
  } catch {
    socket.close(1003, "V2 websocket messages must be valid JSON.")
    return
  }

  const parsed = v2ClientCommandSchema.safeParse(parsedJson)
  if (!parsed.success) {
    const scope = untrustedScope(parsedJson)
    if (!scope) {
      socket.close(1008, "V2 websocket command did not match the contract.")
      return
    }
    runtime.emitCommandError(
      socket,
      scope,
      new SocratesError("invalid_v2_websocket_command", "V2 websocket command did not match the contract.", {
        details: parsed.error.flatten(),
        recoverable: true,
      }),
    )
    return
  }

  const command = parsed.data
  try {
    switch (command.type) {
      case "v2.flow.subscribe":
        runtime.subscribe(socket, command)
        return
      case "v2.flow.unsubscribe":
        runtime.unsubscribe(socket, command.flowId)
        return
      case "v2.message.send":
        await runtime.startTurn(socket, command)
        return
      case "v2.routing.clarification.respond":
        await runtime.respondToClarification(socket, command)
        return
      case "v2.focus.update":
        runtime.updateFocus(command)
        return
      case "v2.turn.cancel":
        runtime.cancel(command)
        return
      case "v2.approval.decide":
        runtime.decideApproval(command)
        return
      case "v2.feedback.submit":
        runtime.submitFeedback(command)
        return
      case "v2.credential.input.submit":
        runtime.submitCredential(command)
        return
      case "v2.terminal.stop":
        await runtime.stopTerminal(command)
        return
      case "v2.terminal.input":
        await runtime.inputTerminal(command)
        return
      case "v2.terminal.resize":
        await runtime.resizeTerminal(command)
        return
      case "v2.terminal.rename":
        runtime.renameTerminal(command)
        return
    }
  } catch (error) {
    runtime.emitCommandError(socket, commandErrorScope(command), error)
  }
}

const commandErrorScope = (command: V2ClientCommand): { projectId: string; flowId: string; turnId?: string } => {
  const payloadTurnId = "turnId" in command.payload && typeof command.payload.turnId === "string"
    ? command.payload.turnId
    : undefined
  return {
    projectId: command.projectId,
    flowId: command.flowId,
    ...(command.turnId ? { turnId: command.turnId } : payloadTurnId ? { turnId: payloadTurnId } : {}),
  }
}

const untrustedScope = (value: unknown): { projectId: string; flowId: string; turnId?: string } | undefined => {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.projectId !== "string" || typeof record.flowId !== "string") return undefined
  return {
    projectId: record.projectId,
    flowId: record.flowId,
    ...(typeof record.turnId === "string" ? { turnId: record.turnId } : {}),
  }
}
