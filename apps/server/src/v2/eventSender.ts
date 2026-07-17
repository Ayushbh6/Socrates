import type { WebSocket } from "ws"
import { v2ServerEventSchema, type V2ServerEvent } from "@socrates/contracts"
import { createId, nowIso } from "@socrates/shared"

export const makeV2Event = <T extends V2ServerEvent["type"]>(
  type: T,
  payload: Extract<V2ServerEvent, { type: T }>["payload"],
  context: Omit<
    Extract<V2ServerEvent, { type: T }>,
    "id" | "schemaVersion" | "timestamp" | "type" | "payload"
  >,
): Extract<V2ServerEvent, { type: T }> =>
  v2ServerEventSchema.parse({
    id: createId("v2evt"),
    schemaVersion: 2,
    timestamp: nowIso(),
    actor: { type: "system" },
    ...context,
    type,
    payload,
  }) as Extract<V2ServerEvent, { type: T }>

export const sendV2Event = (socket: WebSocket, event: V2ServerEvent): boolean => {
  if (socket.readyState !== 1) return false
  try {
    socket.send(JSON.stringify(event))
    return true
  } catch {
    return false
  }
}
