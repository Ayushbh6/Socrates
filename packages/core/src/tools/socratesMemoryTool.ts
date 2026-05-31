import { socratesMemoryToolInputSchema, socratesMemoryToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const socratesMemoryTool: SocratesTool<
  typeof socratesMemoryToolInputSchema._type,
  typeof socratesMemoryToolOutputSchema._type
> = {
  name: "socrates_memory",
  description:
    "Read-only investigation over Socrates-owned memory under ~/.Socrates. Supports list, read, and lexical search across primary or project memory with path/date/limit/charLimit bounds. Use it for identity, operating principles, learned patterns, project memory, and diary excerpts; it is not a general filesystem tool.",
  inputSchema: socratesMemoryToolInputSchema,
  resultSchema: socratesMemoryToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.socrates_memory(input, context),
  summary: (output) =>
    output.operation === "list"
      ? `Listed ${output.files?.length ?? 0} Socrates memory file(s).`
      : output.operation === "search"
        ? `Found ${output.matches?.length ?? 0} Socrates memory match(es).`
        : "Read Socrates memory.",
  resultPreview: (output) =>
    output.content ??
    output.matches?.map((match) => `${match.path}:${match.line ?? "?"}: ${match.text}`).join("\n") ??
    output.files?.map((file) => `${file.scope}:${file.path}`).join("\n") ??
    "",
  metrics: (output) => ({
    filesRead: output.operation === "read" ? 1 : output.files?.length ?? 0,
    searchesRun: output.operation === "search" ? 1 : 0,
  }),
}
