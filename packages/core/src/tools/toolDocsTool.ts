import { toolDocsToolInputSchema, toolDocsToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const toolDocsTool: SocratesTool<typeof toolDocsToolInputSchema._type, typeof toolDocsToolOutputSchema._type> = {
  name: "tool_docs",
  description:
    'Read or search global Socrates tool-usage guidance under ~/.Socrates/tool_usage. Call this before retrying a failed tool, when exact tool behavior is uncertain, or before complex/edge-case use of trace_retrieve, Terminal, edit/apply_patch, docs, skills, MCP, or resources. Read-only for the main agent.',
  inputSchema: toolDocsToolInputSchema,
  resultSchema: toolDocsToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.tool_docs(input, context),
  summary: (output) =>
    output.operation === "search" ? `Found ${output.results.length} tool doc result(s).` : `Read ${output.results.length} tool doc result(s).`,
  resultPreview: (output) =>
    output.results
      .map((result) => `${result.resultNumber}. ${result.path}${result.lineStart ? `:${result.lineStart}` : ""} ${result.title ?? result.matchedText ?? ""}\n${result.snippet ?? ""}`)
      .join("\n\n"),
  metrics: (output) => ({
    filesRead: output.operation === "read" ? output.results.length : 0,
    searchesRun: output.operation === "search" ? 1 : 0,
  }),
}
