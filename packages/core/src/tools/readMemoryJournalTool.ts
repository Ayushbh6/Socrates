import { readMemoryJournalToolInputSchema, readMemoryJournalToolOutputSchema } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const readMemoryJournalTool: SocratesTool<
  typeof readMemoryJournalToolInputSchema._type,
  typeof readMemoryJournalToolOutputSchema._type
> = {
  name: "read_memory_journal",
  description:
    "Read the Memory Agent's own bounded run journal. The current briefing already includes the latest handoff and 2-3 recent summaries. Use list only when older run discovery is necessary (default 5, maximum 10 compact rows), then read one run by runId for its full structured output (default 12,000 characters, hard maximum 20,000). This tool is read-only and is not a general memory search tool.",
  inputSchema: readMemoryJournalToolInputSchema,
  resultSchema: readMemoryJournalToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "other",
  decidePolicy: () => ({ type: "auto" }),
  execute: async (input, context) => {
    if (!context.executors.read_memory_journal) {
      throw new SocratesError("memory_journal_unavailable", "read_memory_journal is not available in this runtime.", { recoverable: true })
    }
    return context.executors.read_memory_journal(input, context)
  },
  summary: (output) =>
    output.operation === "list"
      ? `Listed ${output.runs.length} bounded memory journal run(s).`
      : `Read memory journal run ${output.runs[0]?.runId ?? ""}.`,
  resultPreview: (output) =>
    output.content ?? output.runs.map((run) => `${run.runId} ${run.createdAt}: ${run.summary}`).join("\n"),
}
