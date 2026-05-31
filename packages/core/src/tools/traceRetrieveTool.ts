import { traceRetrieveToolInputSchema, traceRetrieveToolModelInputSchema, traceRetrieveToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const traceRetrieveTool: SocratesTool<typeof traceRetrieveToolInputSchema._type, typeof traceRetrieveToolOutputSchema._type> = {
  name: "trace_retrieve",
  description:
    "Search or inspect older visible project conversation memory. Default operation is search, default mode is exact/lexical over the 10 most recent visible conversations, excluding the active chat. Normal exact/semantic/combined search returns slim message-first rows: resultNumber, text, entryType, provenanceKind, conversationTitle, conversationId, messageId/messageNo for user_query or assistant_response rows, and pairedUserMessageNo/pairedUserPreview for assistant rows when available. Pick mode first: exact for quoted text, filenames, paths, names, ids, dates, and lexical terms; semantic or combined for fuzzy/hybrid recall. Query search can be narrowed by scope, conversationTitle/conversationId, role, entryType, hasAttachment, createdAfter/createdBefore, limit, and conversationLimit where supported. Use audit only for tool calls, shell output, file operations, patches, errors, commands, or runtime history. Use resultNumber or returned messageId/toolId to inspect deeper. turnNo is not a text-search hint: use it only for an explicit ordinal request such as turn 4 or assistant response 3, do not combine it with query, and expect that one Q/A turn back. If query and turnNo are both provided, query search runs, role is kept as a query filter, and the output warns that turnNo was ignored. Continuation summaries and secondary mentions are fallback evidence only and must not be treated as original message provenance.",
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
        "content" in result
          ? `${result.entryType}${result.conversationTitle ? ` ${result.conversationTitle}` : ""}: ${result.content.slice(0, 240)}`
          : `${result.resultNumber}. ${result.entryType} ${result.conversationTitle}: ${result.text.slice(0, 240)}`,
      )
      .join("\n"),
}
