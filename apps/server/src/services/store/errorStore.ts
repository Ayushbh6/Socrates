import { createId, nowIso } from "@socrates/shared"
import { errors } from "../../db/schema"
import { StoreBase } from "./shared"

export type RecordErrorInput = {
  conversationId?: string
  sessionId?: string
  turnId?: string
  source: string
  code: string
  message: string
  details?: unknown
  recoverable: boolean
}

export class ErrorStore extends StoreBase {
  recordError(input: RecordErrorInput): string {
    const id = createId("err")
    this.handle.db
      .insert(errors)
      .values({
        id,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        source: input.source,
        code: input.code,
        message: input.message,
        detailsJson: input.details === undefined ? undefined : JSON.stringify(input.details),
        recoverable: input.recoverable,
        createdAt: nowIso(),
      })
      .run()
    return id
  }
}
