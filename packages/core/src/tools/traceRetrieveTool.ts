import { traceRetrieveToolInputSchema, traceRetrieveToolModelInputSchema, traceRetrieveToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const traceRetrieveTool: SocratesTool<typeof traceRetrieveToolInputSchema._type, typeof traceRetrieveToolOutputSchema._type> = {
  name: "trace_retrieve",
  description:
    "Search or inspect older visible project conversation memory. Default search is exact/lexical over the 10 most recent visible conversations and returns turn-level Q&A results. Use mode='semantic' for fuzzy conceptual recall when semantic retrieval is ready, mode='combined' for hybrid recall, and mode='audit' only for tool calls, shell output, file operations, patches, errors, commands, or runtime history. Inspect a resultNumber or returned exact ids for precise source text.",
  inputSchema: traceRetrieveToolInputSchema,
  modelInputSchema: traceRetrieveToolModelInputSchema,
  resultSchema: traceRetrieveToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.trace_retrieve(input, context),
  summary: (output) => `Retrieved ${output.results.length} trace result(s).`,
  resultPreview: (output) =>
    output.results
      .map((result) =>
        result.kind === "exact_source"
          ? `${result.handle} exact_source ${result.title}: ${result.content.slice(0, 240)}`
          : `${result.handle} ${result.kind} ${result.title}: ${result.snippet ?? result.summary ?? ""}`,
      )
      .join("\n"),
}
