import type { ClientCommand } from "@socrates/contracts"
import type { SocratesStore } from "../../services/store"

export const handleApprovalDecide = (
  store: SocratesStore,
  command: Extract<ClientCommand, { type: "approval.decide" }>,
): void => {
  store.resolveApproval(command.payload.approvalId, command.payload.decision, command.payload.reason)
}
