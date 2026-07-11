import { waitToolInputSchema, waitToolOutputSchema } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const waitTool: SocratesTool<typeof waitToolInputSchema._type, typeof waitToolOutputSchema._type> = {
  name: "wait",
  description:
    "Suspend this Socrates task until a meaningful event occurs on one or more named background Terminals. Use only after completing all independent useful work and every remaining step depends on those Terminals. terminalNames must be names shown by Terminal list/context. wakeOn supports completed, failed, and input_required. reason is a compact audit label: required, at most 7 words and 64 characters. This ends the current model execution without a final user answer when waiting is registered; it does not poll or wake on a timer.",
  inputSchema: waitToolInputSchema,
  resultSchema: waitToolOutputSchema,
  permission: "execute",
  executeLane: "mutation",
  category: "other",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => {
    if (!context.executors.wait) {
      throw new SocratesError("terminal_wait_unavailable", "Terminal waiting is unavailable in this runtime.", { recoverable: true })
    }
    return context.executors.wait(input, context)
  },
  summary: (output) => (output.status === "waiting" ? `Waiting for ${output.terminalNames.join(", ")}.` : "A requested Terminal event is already ready."),
  resultPreview: (output) => output.message,
}
