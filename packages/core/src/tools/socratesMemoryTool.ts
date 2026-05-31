import { socratesMemoryToolInputSchema, socratesMemoryToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const socratesMemoryTool: SocratesTool<
  typeof socratesMemoryToolInputSchema._type,
  typeof socratesMemoryToolOutputSchema._type
> = {
  name: "socrates_memory",
  description:
    "Read-only investigation over Socrates-owned memory pages under ~/.Socrates. Supports search and read across primary, project, or all readable memory with category filters, queryless browsing, exact/keyword/whole-word/regex search, memoryLimit/memoryOffset page controls, date filters, diary date filters, context windows, and safe output caps. Use it for learned patterns, tool usage docs, project brief, project memory, and diary entries. Identity and operating principles are core soul context and are not exposed through this tool.",
  inputSchema: socratesMemoryToolInputSchema,
  resultSchema: socratesMemoryToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.socrates_memory(input, context),
  summary: (output) =>
    output.operation === "search" ? `Found ${output.results.length} Socrates memory result(s).` : `Read ${output.results.length} Socrates memory result(s).`,
  resultPreview: (output) =>
    output.results
      .map((result) => `${result.resultNumber}. ${result.path}${result.lineStart ? `:${result.lineStart}` : ""} ${result.title ?? result.matchedText ?? ""}\n${result.snippet ?? ""}`)
      .join("\n\n"),
  metrics: (output) => ({
    filesRead: output.operation === "read" ? output.results.length : 0,
    searchesRun: output.operation === "search" ? 1 : 0,
  }),
}
