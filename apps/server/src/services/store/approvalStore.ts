import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, eq } from "drizzle-orm"
import { approvals } from "../../db/schema"
import { StoreBase } from "./shared"

export class ApprovalStore extends StoreBase {
  createApproval(input: {
    approvalId?: string
    conversationId: string
    sessionId: string
    turnId: string
    toolCallId?: string
    actionKind: string
    action: unknown
    metadata?: unknown
  }): string {
    const id = input.approvalId ?? createId("appr")
    this.handle.db
      .insert(approvals)
      .values({
        id,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        status: "pending",
        actionKind: input.actionKind,
        actionJson: JSON.stringify(input.action),
        requestedAt: nowIso(),
        metadataJson: input.metadata === undefined ? undefined : JSON.stringify(input.metadata),
      })
      .run()
    return id
  }

  resolveApproval(approvalId: string, decision: "approved" | "rejected", reason?: string): void {
    const approval = this.handle.db.select().from(approvals).where(eq(approvals.id, approvalId)).get()
    if (!approval) {
      throw new SocratesError("approval_not_found", "Approval request not found", { details: { approvalId } })
    }

    const now = nowIso()
    this.handle.db
      .update(approvals)
      .set({
        status: decision,
        decision,
        decidedAt: now,
        metadataJson: JSON.stringify({ reason }),
      })
      .where(eq(approvals.id, approvalId))
      .run()
  }

  rejectPendingForTurn(turnId: string, reason?: string): void {
    this.handle.db
      .update(approvals)
      .set({
        status: "rejected",
        decision: "rejected",
        decidedAt: nowIso(),
        metadataJson: JSON.stringify({ reason: reason ?? "Turn was cancelled.", cancelled: true }),
      })
      .where(and(eq(approvals.turnId, turnId), eq(approvals.status, "pending")))
      .run()
  }
}
