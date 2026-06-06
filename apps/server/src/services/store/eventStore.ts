import { serverEventSchema, type ServerEvent } from "@socrates/contracts"
import { createId, nowIso } from "@socrates/shared"
import type { DatabaseHandle } from "../../db/client"
import { events } from "../../db/schema"
import type { StoreEventInput } from "./types"

export class EventStore {
  constructor(private readonly handle: DatabaseHandle) {}

  appendEvent(input: StoreEventInput): void {
    const row = this.handle.sqlite.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events").get() as {
      next_sequence: number
    }

    this.handle.db
      .insert(events)
      .values({
        id: createId("evt"),
        projectId: input.projectId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sequence: row.next_sequence,
        type: input.type,
        source: input.source,
        payloadJson: JSON.stringify(input.payload),
        createdAt: nowIso(),
      })
      .run()
  }

  listActiveTurnServerEvents(projectId: string, conversationId: string): ServerEvent[] {
    const rows = this.handle.sqlite
      .prepare(
        `SELECT e.id, e.project_id AS projectId, e.conversation_id AS conversationId, e.session_id AS sessionId,
                e.turn_id AS turnId, e.type, e.payload_json AS payloadJson, e.created_at AS createdAt
         FROM events e
         INNER JOIN turns t ON t.id = e.turn_id
         WHERE t.conversation_id = ?
           AND t.status IN ('queued', 'running', 'awaiting_approval')
           AND e.project_id = ?
           AND e.conversation_id = ?
         ORDER BY e.sequence`,
      )
      .all(conversationId, projectId, conversationId) as Array<{
      id: string
      projectId: string | null
      conversationId: string | null
      sessionId: string | null
      turnId: string | null
      type: string
      payloadJson: string
      createdAt: string
    }>

    return rows.flatMap((row) => {
      let payload: unknown
      try {
        payload = JSON.parse(row.payloadJson)
      } catch {
        return []
      }
      const parsed = serverEventSchema.safeParse({
        id: row.id,
        type: row.type,
        schemaVersion: 1,
        timestamp: row.createdAt,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        ...(row.conversationId ? { conversationId: row.conversationId } : {}),
        ...(row.sessionId ? { sessionId: row.sessionId } : {}),
        ...(row.turnId ? { turnId: row.turnId } : {}),
        actor: { type: "system" },
        payload,
      })
      return parsed.success ? [parsed.data] : []
    })
  }
}
