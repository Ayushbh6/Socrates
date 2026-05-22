import type { ClientCommand } from "@socrates/contracts"
import type { SocratesStore } from "../../services/store"
import type { ActiveTurns } from "../activeTurns"

export const handleApprovalDecide = (
  store: SocratesStore,
  activeTurns: ActiveTurns,
  command: Extract<ClientCommand, { type: "approval.decide" }>,
): void => {
  store.resolveApproval(command.payload.approvalId, command.payload.decision, command.payload.reason)
  activeTurns.resolveApproval(command.payload.approvalId, {
    decision: command.payload.decision,
    ...(command.payload.reason ? { reason: command.payload.reason } : {}),
  })
}
