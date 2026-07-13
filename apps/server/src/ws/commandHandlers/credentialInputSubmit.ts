import type { ClientCommand } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { ActiveTurns } from "../activeTurns"

export const handleCredentialInputSubmit = (
  activeTurns: ActiveTurns,
  command: Extract<ClientCommand, { type: "credential.input.submit" }>,
): void => {
  const resolved = activeTurns.resolveCredentialInput(command.payload.turnId, command.payload.credentialRequestId, {
    decision: command.payload.decision,
    source: "user_input",
    ...(command.payload.value === undefined ? {} : { value: command.payload.value }),
  })
  if (!resolved) {
    throw new SocratesError("credential_request_not_active", "This credential request is no longer active.", { recoverable: true })
  }
}
