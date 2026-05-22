import { traceRetrieveToolInputSchema, traceRetrieveToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const traceRetrieveTool: SocratesTool<typeof traceRetrieveToolInputSchema._type, typeof traceRetrieveToolOutputSchema._type> = {
  name: "trace_retrieve",
  description:
    "Retrieve old project-scoped tool traces only when past command/file evidence is explicitly useful. Use structured filters before broad keyword search.",
  inputSchema: traceRetrieveToolInputSchema,
  resultSchema: traceRetrieveToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.trace_retrieve(input, context),
  summary: (output) => `Retrieved ${output.traces.length} trace(s).`,
  resultPreview: (output) => output.traces.map((trace) => `${trace.toolName} ${trace.status}: ${trace.summary}`).join("\n"),
}
