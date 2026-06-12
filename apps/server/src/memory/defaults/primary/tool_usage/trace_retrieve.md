# trace_retrieve Usage Guide

`trace_retrieve` is Socrates' investigation tool for prior visible conversation history and persisted runtime evidence. Use it when the answer depends on what happened earlier in this project: previous chats, exact wording, message ordinals, older assistant responses, screenshots with provenance, tool calls, shell output, edits, patches, or errors.

This tool is not a generic web search, not a file reader, and not a replacement for the current visible conversation. It retrieves from Socrates' SQLite history for the active project.

## Core Principle

Start with the smallest investigation that can prove or disprove the claim.

For conversation-memory questions, browse/search messages first. For runtime/tool questions, switch explicitly to audit mode. For exact wording, inspect the returned result before quoting.

## What It Can Retrieve

- Visible active or archived conversations in the current project.
- User messages and assistant messages.
- Q/A pair windows from recent or project-wide conversations.
- Conversation titles and ids for provenance.
- Exact messages by returned `messageId`.
- Exact tool/runtime evidence in `mode: "audit"`.
- Tool calls, shell output, file operations, patches, and errors when audit mode is used.

## What It Must Not Do

- It must not return hard-deleted conversations as provenance.
- It must not treat retained attachment files as proof of a deleted conversation.
- It must not infer `turnNo` from natural language. `turnNo` must be passed as a structured integer.
- It must not recursively search old `trace_retrieve` outputs as normal evidence.
- It must not be used for Socrates memory/docs pages; use `tool_docs`, `skills`, `project_docs`, or `repo_docs` for those.

## Mental Model

There are two workflows:

1. Search or browse to find candidate evidence.
2. Inspect one candidate when exact text or full runtime evidence matters.

Search/browse returns compact evidence. Inspect returns fuller bounded source content.

## Standard Input Fields

```json
{
  "operation": "search",
  "mode": "exact",
  "query": "quoted or natural text",
  "scope": "recent_conversations",
  "conversationLimit": 5,
  "limit": 5,
  "charLimit": 6000
}
```

Use `operation: "inspect"` when you already have a `resultNumber`, `messageId`, `conversationId`, or audit id from a prior result.

## Search Parameter Reference

| Parameter | Meaning | Use When |
| --- | --- | --- |
| `operation` | Usually `"search"`; optional because search is the default | Starting a retrieval investigation. |
| `mode` | `exact`, `semantic`, `combined`, or `audit` | Select lexical, vector, hybrid, or runtime-evidence retrieval. |
| `query` | Text to search | Required for `semantic`, `combined`, and `audit`; optional for exact browsing. |
| `scope` | `current_conversation`, `recent_conversations`, or `project` | Control conversation set. |
| `conversationTitle` | Human title filter | Narrow to a named conversation without knowing its id. |
| `conversationId` | Exact conversation id | Disambiguate same-title conversations after search. |
| `conversationLimit` | Number of conversations to consider, max 50 | Bound recent/project searches. |
| `conversationOffset` | Skip N conversations before considering | Select second/third latest or page duplicate titles. |
| `perConversationLimit` | Q/A pairs or messages per conversation, max 20 | Browse conversation windows. |
| `turnNo` | Exact Q/A turn number | User explicitly asks for an ordinal turn. Do not combine with `query`. |
| `role` | `user`, `assistant`, or `any` | Search only user queries, assistant responses, or both. |
| `entryType` | Message/runtime entry type | Narrow to user_query, assistant_response, continuation_summary, tool_call, shell, file, patch, or error. |
| `hasAttachment` | Boolean attachment filter | Find original image/file attachment messages. |
| `include` | Runtime evidence families | Audit mode for tool_calls, shell, files, errors, decisions. |
| `toolNames` | Tool-name filter | Audit/search for specific tools such as `trace_retrieve` or `bash`. |
| `paths` | File path filters | Audit/file evidence involving specific paths. |
| `command` | Shell command filter | Audit shell history. |
| `createdAfter` / `createdBefore` | Message/time filters | Narrow by message creation time. |
| `updatedAfter` / `updatedBefore` | Conversation activity filters | Browse/search conversations active in a period. |
| `limit` | Result-unit cap, max 20 | Keep output focused. |
| `charLimit` | Output character cap, max 80,000 | Increase when excerpts truncate. |

## Inspect Parameter Reference

| Parameter | Meaning | Use When |
| --- | --- | --- |
| `operation` | Must be `"inspect"` | Open exact bounded evidence. |
| `resultNumber` | Result number from prior search | Best normal inspect path. |
| `messageId` | Exact message id from a result | Retrieve one exact user/assistant message. |
| `toolCallId` | Exact tool call id | Retrieve one exact tool call. |
| `conversationId` | Exact conversation id | Page through a conversation. |
| `startTurnNo` | First turn for conversation bundle | Continue a paged conversation inspect. |
| `turnLimit` | Number of turns to include | Bound conversation bundle output. |
| `turnNo` | Exact turn number | Inspect a specific ordinal turn after conversation narrowing. |
| `role` | user/assistant/any | Select role for turn inspect. |
| `paths` | File path filter | Inspect path-specific audit evidence. |
| `command` | Command filter | Inspect shell evidence. |
| `include` | Evidence families | Include messages, summaries, tool calls, shell, files, errors, decisions. |
| `charLimit` | Output character cap | Control raw evidence size. |

## Modes

### exact

Use for exact words, quoted phrases, dates, paths, ids, titles, commands, and queryless browsing.

`exact` can run without `query`.

Good for:

- "What did I say in the previous conversation?"
- "Find the chat where I wrote this exact sentence."
- "Show the last 3 Q/A pairs from the latest conversation."
- "Find assistant response 3 in conversation X."

### semantic

Use for fuzzy conceptual recall when exact wording is unknown.

Requires `query`.

Good for:

- "Find the conversation where we discussed the memory backfill idea."
- "Find the earlier diagnosis about retrieval loops."

If semantic retrieval is not ready, the tool should warn. Fall back to exact keywords or queryless browse.

### combined

Use when both exact and fuzzy evidence could matter.

Requires `query`.

Good for:

- User gives partial wording and asks for the source conversation.
- User remembers the idea but not the exact phrase.

### audit

Use only for runtime evidence.

Requires `query` unless using an exact returned audit id.

Good for:

- "What tool calls did the agent make?"
- "Why did the previous Terminal command fail?"
- "Show the patch that changed this file."
- "Which tool output confused the model?"

Do not use audit mode for ordinary conversation text unless the user asks specifically about tool/runtime behavior.

## Scopes

### current_conversation

Search only the current visible chat.

Use when:

- The user asks about "this chat".
- The current conversation has many turns and older turns are not in prompt context.

### recent_conversations

Search recent visible conversations, excluding the active chat by default.

Use when:

- The user asks "previous conversation", "latest conversation before this", or "recent chats".
- You need to browse what happened immediately before the current chat.

### project

Search all visible active/archived project conversations.

Use when:

- The user asks for any conversation in the project.
- Recent search failed and the evidence may be older.
- The user gives a quoted phrase and needs exact provenance.

## Queryless Browsing

Use queryless browsing when the user asks about recent/latest/previous conversations rather than a keyword.

Example: latest previous conversation, first 5 Q/A pairs.

```json
{
  "operation": "search",
  "mode": "exact",
  "scope": "recent_conversations",
  "conversationLimit": 1,
  "perConversationLimit": 5,
  "limit": 5
}
```

Example: second latest conversation.

```json
{
  "operation": "search",
  "mode": "exact",
  "scope": "recent_conversations",
  "conversationLimit": 1,
  "conversationOffset": 1,
  "perConversationLimit": 5,
  "limit": 5
}
```

Example: browse all Q/A pairs from a titled conversation.

```json
{
  "operation": "search",
  "mode": "exact",
  "scope": "project",
  "conversationTitle": "apply patch fix",
  "perConversationLimit": 10,
  "limit": 10
}
```

## Turn Number Lookup

`turnNo` is exact and exclusive. Use it only when the user explicitly refers to an ordinal turn.

Correct:

```json
{
  "operation": "search",
  "mode": "exact",
  "scope": "project",
  "conversationTitle": "apply patch fix",
  "turnNo": 3,
  "role": "assistant"
}
```

Incorrect:

```json
{
  "query": "third assistant response",
  "turnNo": 3
}
```

If `query` and `turnNo` are both present, the backend runs the query and ignores `turnNo` with a warning. Retry with only `turnNo` if exact ordinal lookup was intended.

## Role And Entry Filters

Use `role` when the user asks specifically for user messages, assistant responses, or either.

```json
{
  "operation": "search",
  "mode": "exact",
  "query": "staleness guard caught it cold",
  "scope": "project",
  "role": "assistant",
  "limit": 5
}
```

Use `entryType` to target message kinds:

- `user_query`
- `assistant_response`
- `continuation_summary`
- `tool_call`
- `shell`
- `file`
- `patch`
- `error`

For normal conversation text, prefer `role` or `entryType: "assistant_response"` / `entryType: "user_query"`.

## Attachment Provenance

Use `hasAttachment: true` when the source must be an original message with an attachment.

```json
{
  "operation": "search",
  "mode": "exact",
  "scope": "project",
  "hasAttachment": true,
  "query": "screenshot",
  "limit": 5
}
```

Rules:

- Original message attachment provenance is stronger than later file reads.
- Retained `.socrates/attachments` files are not conversation provenance by themselves.
- If the tool warns that only secondary mentions matched, do not claim an origin conversation.

## Inspecting Results

Search results are compact. Inspect when:

- The user asks for exact wording.
- You need to quote or identify precise user query/assistant response numbers.
- The result is a summary or secondary mention.
- The text is truncated.
- The tool returns a `resultNumber` and the answer depends on context outside the excerpt.

Inspect by result number:

```json
{
  "operation": "inspect",
  "resultNumber": 1,
  "charLimit": 12000
}
```

Inspect by exact message id:

```json
{
  "operation": "inspect",
  "messageId": "msg_..."
}
```

Inspect a conversation window:

```json
{
  "operation": "inspect",
  "conversationId": "conv_...",
  "startTurnNo": 1,
  "turnLimit": 10,
  "charLimit": 16000
}
```

## Common Investigation Recipes

### Find the source of an exact assistant sentence

1. Search exact phrase with `role: "assistant"` or `entryType: "assistant_response"`.
2. Inspect the top result.
3. Report `conversationTitle`, assistant message number, and paired user message number if provided.

```json
{
  "operation": "search",
  "mode": "exact",
  "scope": "project",
  "query": "The staleness guard caught it cold",
  "role": "assistant",
  "limit": 5
}
```

### Diagnose why a previous answer was wrong

1. Use normal search/browse to find the conversation and assistant response.
2. Use audit mode for tool calls and tool outputs in that conversation.
3. Inspect relevant tool calls.
4. Separate tool failure, model misunderstanding, and prompt/tool-contract weakness.

```json
{
  "operation": "search",
  "mode": "audit",
  "scope": "project",
  "conversationTitle": "The",
  "query": "trace_retrieve",
  "include": ["tool_calls", "errors"],
  "limit": 10
}
```

### Check the immediately previous conversation

```json
{
  "operation": "search",
  "mode": "exact",
  "scope": "recent_conversations",
  "conversationLimit": 1,
  "perConversationLimit": 5,
  "limit": 5
}
```

### Search only a known title

```json
{
  "operation": "search",
  "mode": "exact",
  "scope": "project",
  "conversationTitle": "trace retrieve test",
  "query": "deleted conversation",
  "limit": 5
}
```

### Find old runtime errors

```json
{
  "operation": "search",
  "mode": "audit",
  "scope": "project",
  "query": "error failed rejected stale",
  "include": ["errors", "tool_calls", "shell"],
  "limit": 10
}
```

## Output Interpretation

Prefer these fields:

- `resultNumber`: follow-up inspect handle.
- `text` or `content`: evidence excerpt or inspected source.
- `entryType`: what kind of evidence it is.
- `conversationTitle`: human-readable provenance.
- `conversationId`: disambiguation when titles repeat.
- `messageId`: exact inspect target.
- `messageNo`: user/assistant message number when available.
- `pairedUserMessageNo`: paired user turn for assistant responses.
- `pairedUserPreview`: useful for "user query x / assistant response y" questions.
- `warnings`: must be read and followed.

## Failure Handling

If results are empty:

- State the searched scope.
- Widen from recent to project if appropriate.
- Try exact keywords before semantic if semantic is unavailable.
- Browse recent conversations when the user refers to recency.
- Stop after reasonable evidence. Do not loop with identical calls.

If duplicate-call warning appears:

- Do not repeat the same call.
- Inspect an existing result.
- Change scope, title, filters, or query.

If only secondary mentions are found:

- Treat them as leads.
- Do not claim original provenance.
- Say that no visible original source was found if inspection confirms it.

## FAQ

### When should I browse without a query?

When the user frames the task by recency or conversation position: "previous conversation", "latest chat", "second latest", "last three Q/A pairs", or "that conversation titled X". Browse first, then search/inspect if needed.

### When should I search with a query?

When the user gives words, concepts, paths, commands, error text, quoted text, or asks to find a specific claim.

### When should I inspect?

Inspect when the answer depends on exact wording, full context, source provenance, or message numbering. Search snippets are not enough for exact quotation.

### Why not use audit mode for everything?

Audit mode is for runtime evidence. It can surface noisy tool and shell data. Use normal exact/semantic/combined search for conversation text.

### What if the user asks for a deleted conversation?

Search visible active/archived history. If no visible original source exists, say that. Do not infer deleted-conversation provenance from summaries, retained files, or later mentions.

### What if `turnNo` and `query` both seem useful?

Choose one. Use query search to find the conversation or phrase. Use `turnNo` alone only when inspecting a specific ordinal turn.

## Good Final Answer Pattern

For source-identification tasks:

```text
Found it in conversation "<title>".

It is assistant response <n>, paired with user query <m>.
I confirmed this by inspecting result <resultNumber>.
```

For deleted or missing provenance:

```text
I searched <scope>. I found retained secondary evidence, but no visible active/archived original conversation source. That means I cannot honestly name a source conversation from trace history.
```

For tool-call diagnosis:

```text
The loop came from <cause>. The tool returned <shape>, but the model kept <wrong behavior>. The fix is <contract/tool/prompt change>.
```

## Checklist Before Answering

- Did I use the right scope?
- Did I inspect when exact wording mattered?
- Did I respect `turnNo` exclusivity?
- Did I avoid deleted-conversation provenance claims?
- Did I separate original evidence from summaries/secondary mentions?
- Did I stop repeating identical calls?
