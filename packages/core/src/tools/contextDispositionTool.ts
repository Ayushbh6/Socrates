import {
  contextDispositionToolInputSchema,
  contextDispositionToolOutputSchema,
  type ContextDispositionToolInput,
  type ContextDispositionToolOutput,
} from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const contextDispositionTool: SocratesTool<ContextDispositionToolInput, ContextDispositionToolOutput> = {
  name: "context_disposition",
  displayName: "Context disposition",
  description:
    "Classify substantial tool outputs that you have already inspected so the runtime can manage the current turn before its next model call. Use this only in the same response as at least one functional tool call. Never call it alone and never call it when you are giving the final answer. For each supplied result handle choose keep_exact, distill, release, or unresolved. distill requires a concise summary; other actions must omit summary. Exact evidence is always retained outside model context.",
  inputSchema: contextDispositionToolInputSchema,
  resultSchema: contextDispositionToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "other",
  decidePolicy: () => ({ type: "auto" }),
  execute: async (input, context) => {
    if (!context.applyContextDisposition) {
      throw new SocratesError("context_disposition_unavailable", "Current-turn context disposition is unavailable.", { recoverable: true })
    }
    return context.applyContextDisposition(input)
  },
  summary: (output) => output.summary,
  resultPreview: (output) => output.summary,
}
