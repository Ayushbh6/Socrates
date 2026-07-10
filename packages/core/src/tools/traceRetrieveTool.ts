import {
  traceRetrieveGlobalToolInputSchema,
  traceRetrieveGlobalToolOutputSchema,
  traceRetrieveMainToolInputSchema,
  traceRetrieveMainToolOutputSchema,
  type TraceRetrieveGlobalToolOutput,
  type TraceRetrieveMainToolInput,
  type TraceRetrieveMainToolOutput,
} from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const traceRetrieveTool: SocratesTool<typeof traceRetrieveMainToolInputSchema._type, typeof traceRetrieveMainToolOutputSchema._type> = {
  name: "trace_retrieve",
  description:
    "Recall any prior visible conversation in the active project. Search the full project by default. Use lexical with a concise literal query (128 characters max), semantic for conceptual recall, combined for hybrid recall, and audit only for tool/shell/file/patch/error evidence. Narrow to current_conversation or recent_conversations only when useful. Results expose numbered human context and turn references; use inspect with resultNumber or turnId for the full Q&A parent. This tool cannot search other projects.",
  inputSchema: traceRetrieveMainToolInputSchema,
  modelInputSchema: traceRetrieveMainToolInputSchema,
  resultSchema: traceRetrieveMainToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.trace_retrieve(input as TraceRetrieveMainToolInput, context) as Promise<TraceRetrieveMainToolOutput>,
  summary: (output) => `Retrieved ${output.results.length} trace result(s).`,
  resultPreview: (output) =>
    output.results
      .map((result) => `${result.resultNumber}. ${result.conversationTitle} turn ${result.turnNumber} (${result.matchedRole}): ${result.content.slice(0, 240)}`)
      .join("\n"),
}

export const globalTraceRetrieveTool: SocratesTool<typeof traceRetrieveGlobalToolInputSchema._type, typeof traceRetrieveGlobalToolOutputSchema._type> = {
  name: "trace_retrieve",
  description:
    "Recall any prior visible conversation across Socrates projects. This uses the same retrieval behavior as the main agent: lexical with a concise literal query (128 characters max), semantic for conceptual recall, combined for hybrid recall, and audit only for tool/shell/file/patch/error evidence. Search all projects by default or select projects by id/title. Results include project titles and numbered human context; use inspect with resultNumber, turnId, or project/conversation/turn coordinates for the full Q&A parent.",
  inputSchema: traceRetrieveGlobalToolInputSchema,
  modelInputSchema: traceRetrieveGlobalToolInputSchema,
  resultSchema: traceRetrieveGlobalToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.trace_retrieve(input, context) as Promise<TraceRetrieveGlobalToolOutput>,
  summary: (output) => `Retrieved ${output.results.length} trace result(s).`,
  resultPreview: (output) =>
    output.results
      .map((result) => `${result.resultNumber}. ${result.projectTitle} / ${result.conversationTitle} turn ${result.turnNumber} (${result.matchedRole}): ${result.content.slice(0, 240)}`)
      .join("\n"),
}
