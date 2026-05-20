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
}
