import type { ClientCommand } from "@socrates/contracts"
import type { SocratesStore } from "../../services/store"

export const handleFeedbackSubmit = (
  store: SocratesStore,
  command: Extract<ClientCommand, { type: "feedback.submit" }>,
): void => {
  store.submitFeedback(command.payload)
}
