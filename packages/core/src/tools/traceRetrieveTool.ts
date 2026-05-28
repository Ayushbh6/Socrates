import { traceRetrieveToolInputSchema, traceRetrieveToolModelInputSchema, traceRetrieveToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const traceRetrieveTool: SocratesTool<typeof traceRetrieveToolInputSchema._type, typeof traceRetrieveToolOutputSchema._type> = {
  name: "trace_retrieve",
  description:
    "Search or inspect older project-scoped conversation and execution evidence. Search by natural query, scope, conversation hint, turnNo/role, tool, path, command, and mode. Semantic and combined search depend on the runtime semantic retrieval status; exact/lexical search and inspect remain available. For exact source text, inspect a resultNumber from the previous search or use natural filters such as conversationHint, turnNo, role, query, path, or command.",
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
