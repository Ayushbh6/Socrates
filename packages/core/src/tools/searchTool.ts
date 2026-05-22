import { searchToolInputSchema, searchToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const searchTool: SocratesTool<typeof searchToolInputSchema._type, typeof searchToolOutputSchema._type> = {
  name: "search",
  description:
    "Find files by name/path or search file contents in the active project workspace. Use mode='files' for file discovery and mode='text' for grep-style content search.",
  inputSchema: searchToolInputSchema,
  resultSchema: searchToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "search",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.search(input, context),
  summary: (output) => `Found ${output.totalMatches} ${output.mode === "files" ? "file" : "text"} matches.`,
  resultPreview: (output) => output.matches.map((match) => `${match.path}${match.line ? `:${match.line}` : ""}${match.text ? ` ${match.text}` : ""}`).join("\n"),
  metrics: () => ({ searchesRun: 1 }),
}
