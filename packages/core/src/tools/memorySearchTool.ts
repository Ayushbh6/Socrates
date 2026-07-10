import { memorySearchInputSchema, memorySearchOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const memorySearchTool: SocratesTool<typeof memorySearchInputSchema._type, typeof memorySearchOutputSchema._type> = {
  name: "memory_search",
  description:
    "Search indexed curated memory sections for exact routing evidence. Use lexical for literal phrases, semantic for concepts, and combined for hybrid recall. Results identify the exact human-facing surface, file, and section Socrates should read. This tool is read-only and cannot edit memory.",
  inputSchema: memorySearchInputSchema,
  resultSchema: memorySearchOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "search",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => {
    if (!context.executors.memory_search) throw new Error("memory_search executor is unavailable.")
    return context.executors.memory_search(input, context)
  },
  summary: (output) => `Retrieved ${output.results.length} memory section(s).`,
  resultPreview: (output) =>
    output.results.map((result) => `${result.resultNumber}. ${result.fileName}/${result.sectionId}: ${result.content.slice(0, 240)}`).join("\n"),
}
