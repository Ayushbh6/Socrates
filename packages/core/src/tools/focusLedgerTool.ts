import { focusLedgerToolInputSchema, focusLedgerToolOutputSchema } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const focusLedgerTool: SocratesTool<
  typeof focusLedgerToolInputSchema._type,
  typeof focusLedgerToolOutputSchema._type
> = {
  name: "focus_ledger",
  displayName: "Updating focus ledger",
  description:
    "V2 Seamless only. Read the project's bounded focus ledger, inspect a focus, update the current focus capsule, record a current-focus blocker, or mark the current work focus complete after the user's requested outcome is genuinely finished. Mutations are restricted to the focus already bound to this turn. Never use this tool to switch, archive, or delete evidence. General Conversation can never be completed.",
  inputSchema: focusLedgerToolInputSchema,
  resultSchema: focusLedgerToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "other",
  decidePolicy: () => ({ type: "auto" }),
  execute: async (input, context) => {
    if (!context.executors.focus_ledger) {
      throw new SocratesError("focus_ledger_unavailable", "The focus ledger is available only in Socrates Seamless.", {
        recoverable: true,
      })
    }
    return context.executors.focus_ledger(input, context)
  },
  summary: (output) => output.message,
  resultPreview: (output) => output.message,
}
