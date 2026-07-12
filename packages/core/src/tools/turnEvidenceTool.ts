import { turnEvidenceToolInputSchema, turnEvidenceToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const turnEvidenceTool: SocratesTool<typeof turnEvidenceToolInputSchema._type, typeof turnEvidenceToolOutputSchema._type> = {
  name: "turn_evidence",
  description:
    "Read bounded, deterministic evidence for the complete current user-request lifecycle, including automatic Terminal wait/resume continuations. Use overview first; inspect only a code-generated evd_ reference returned by overview. This tool is read-only.",
  inputSchema: turnEvidenceToolInputSchema,
  resultSchema: turnEvidenceToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => {
    if (!context.executors.turn_evidence) throw new Error("turn_evidence executor is unavailable.")
    return context.executors.turn_evidence(input, context)
  },
  summary: (output) => `Read ${output.operation} evidence for task ${output.taskId}.`,
  resultPreview: (output) => output.content.slice(0, 1_000),
}
