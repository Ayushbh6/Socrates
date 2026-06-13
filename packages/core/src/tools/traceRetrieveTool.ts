import { traceRetrieveToolInputSchema, traceRetrieveToolModelInputSchema, traceRetrieveToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const traceRetrieveTool: SocratesTool<typeof traceRetrieveToolInputSchema._type, typeof traceRetrieveToolOutputSchema._type> = {
  name: "trace_retrieve",
  description:
    "Investigate older visible conversation memory and persisted runtime evidence. Default operation is search. With no query and mode omitted/exact, browse Q/A windows by scope/title/id/date/offset using conversationLimit, conversationOffset, perConversationLimit, role, entryType, hasAttachment, updatedAfter/updatedBefore, createdAfter/createdBefore, limit, and charLimit; Q/A pairs count as one result unless role is specified. Selectors projectId, projectTitle, conversationId, and conversationTitle accept one string or a list; exact ids win over titles, titles win over broad scope, and list order is preserved where possible. scope can be current_conversation, recent_conversations, current_project/project, or all_projects when the executor supports global retrieval. With query, exact/semantic/combined search returns message-first evidence rows with broad snippets around the best match. Use exact for quoted text, filenames, paths, names, ids, dates, and lexical terms; semantic or combined for fuzzy/hybrid recall and always provide query. For latest/previous/recent conversation questions, browse first, then inspect/search precise results. For quoted assistant wording where the user asks for user query x / assistant response y, prefer entryType=\"assistant_response\" or role=\"assistant\" and use returned messageNo/pairedUserMessageNo. Use audit only for tool calls, shell output, file operations, patches, errors, commands, or runtime history. turnNo is exclusive exact ordinal lookup: use it only for explicit turn 4/assistant response 3 style requests, do not combine with query. If query and turnNo are both provided, query search runs, role is kept as a query filter, and the output warns that turnNo was ignored.",
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
          : result.entryType === "qa_pair"
            ? `${result.resultNumber}. qa_pair ${result.conversationTitle} turn ${result.turnNo}: ${(result.userText ?? result.assistantText ?? "").slice(0, 240)}`
          : `${result.resultNumber}. ${result.entryType} ${result.conversationTitle}: ${result.text.slice(0, 240)}`,
      )
      .join("\n"),
}
