import { nowIso, SocratesError } from "@socrates/shared"
import { eq } from "drizzle-orm"
import { approvals } from "../../db/schema"
import { StoreBase } from "./shared"

export class ApprovalStore extends StoreBase {
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
}
