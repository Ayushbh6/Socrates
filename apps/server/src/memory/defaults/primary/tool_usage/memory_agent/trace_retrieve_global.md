# Global trace_retrieve Usage Guide

`trace_retrieve` is the Global Memory Agent's investigation tool for visible conversation history and persisted runtime evidence across Socrates projects. Use it when a possible memory update depends on what happened in a completed turn: exact user wording, assistant behavior, tool calls, shell output, file operations, patches, errors, or repeated decisions.

This tool is not a file reader, not a generic search engine, and not a writer. It retrieves indexed trace evidence. Use `edit_files` only after this tool has produced exact evidence for the memory change.

## Core Principle

Start from the manifest or metadata, then prove the lesson with inspected evidence.

Search results are leads. Inspect results are evidence. Do not update global memory from a summary, count, title, or vague recollection alone.

## What It Can Retrieve

- Visible active or archived conversations across projects.
- User messages and assistant messages.
- Conversation and project provenance.
- Turn summaries and conversation summaries.
- Exact messages by returned `messageId`.
- Exact turns by returned `turnId`.
- Stable trace handles returned by search results.
- Tool calls, shell commands, file operations, patches, and errors in `mode: "audit"`.

## What It Must Not Do

- It must not be treated as proof for hard-deleted conversations.
- It must not turn metadata from `projects` into behavioral evidence.
- It must not use audit mode for ordinary conversation text unless the question is about runtime behavior.
- It must not write or propose a memory edit before exact evidence is inspected.
- It must not make the model preserve opaque ids when a title, quote, ordinal, date, result number, or returned handle will work.

## Mental Model

There are three common workflows:

1. Orient from the manifest or `projects`.
2. Search or browse globally to find candidate evidence.
3. Inspect the candidate result before editing memory.

Use normal search for what the user or assistant said. Use audit search for what tools, files, patches, shell commands, and errors did.

## Standard Input Fields

```json
{
  "operation": "search",
  "scope": "all_projects",
  "mode": "combined",
  "query": "memory workflow should avoid opaque ids",
  "limit": 5,
  "charLimit": 12000
}
```

Use `operation: "inspect"` when a prior result returned a `resultNumber`, `handle`, `turnId`, `messageId`, `toolCallId`, or `conversationId`.

## Search Parameter Reference

| Parameter | Meaning | Use When |
| --- | --- | --- |
| `operation` | Usually `"search"`; optional because search is the default | Starting an investigation. |
| `mode` | `exact`, `semantic`, `combined`, or `audit` | Select lexical, vector, hybrid, or runtime-evidence retrieval. |
| `query` | Text to search | Required for semantic, combined, and audit searches. Optional for exact browsing. |
| `scope` | `all_projects`, `current_project`, `project`, `current_conversation`, or `recent_conversations` | Control the search set. |
| `projectTitle` | Human project title selector | Narrow without preserving a raw project id. |
| `projectId` | Exact project id selector | Disambiguate after `projects`, manifest, or retrieval output. |
| `conversationTitle` | Human conversation title selector | Narrow without preserving a raw conversation id. |
| `conversationId` | Exact conversation id selector | Disambiguate repeated titles after orientation. |
| `conversationLimit` | Number of conversations to consider, max 50 | Bound recent/project browsing. |
| `conversationOffset` | Skip N conversations before considering | Page recency or duplicate titles. |
| `perConversationLimit` | Q/A pairs or messages per conversation, max 20 | Browse conversation windows. |
| `turnNo` | Exact Q/A turn number | User explicitly asks for an ordinal turn. Do not combine with `query`. |
| `role` | `user`, `assistant`, or `any` | Search only user messages, assistant messages, or both. |
| `entryType` | Message/runtime entry type | Narrow to user_query, assistant_response, continuation_summary, tool_call, shell, file, patch, or error. |
| `include` | Evidence families | Audit mode for tool_calls, shell, files, errors, decisions; normal search for messages or summaries. |
| `toolNames` | Tool-name filter | Audit/search for tools such as `edit_files`, `trace_retrieve`, or `bash`. |
| `paths` | File path filters | Find trace evidence involving a path. |
| `command` | Shell command filter | Find shell evidence. |
| `createdAfter` / `createdBefore` | Message/time filters | Narrow by evidence creation time. |
| `updatedAfter` / `updatedBefore` | Conversation activity filters | Narrow conversation activity. |
| `limit` | Result cap, max 20 | Keep output focused. |
| `charLimit` | Output character cap, max 80,000 | Increase when excerpts truncate. |

## Inspect Parameter Reference

| Parameter | Meaning | Use When |
| --- | --- | --- |
| `operation` | Must be `"inspect"` | Open bounded source evidence. |
| `resultNumber` | Result number from prior search | Best normal inspect path. |
| `handle` | Stable trace handle from a result | Inspect the exact indexed evidence without copying raw ids. |
| `turnId` | Exact turn id | Manifest or search result points at a completed turn. |
| `messageId` | Exact message id | Retrieve one exact user or assistant message. |
| `toolCallId` | Exact tool call id | Retrieve one exact tool call. |
| `conversationId` | Exact conversation id | Page through a conversation. |
| `startTurnNo` | First turn for a conversation bundle | Continue a paged inspect. |
| `turnLimit` | Number of turns to include | Bound conversation output. |
| `turnNo` | Exact turn number | Inspect a specific ordinal turn after narrowing. |
| `include` | Evidence families | Include messages, summaries, tool calls, shell, files, errors, decisions. |
| `charLimit` | Output character cap | Control inspected evidence size. |

## Modes

### exact

Use for exact words, quoted phrases, titles, paths, commands, ids, and queryless browsing.

Good for:

- Finding a quoted user instruction.
- Finding a title from the manifest.
- Browsing a known conversation window.
- Checking whether a specific phrase appears in assistant output.

```json
{
  "operation": "search",
  "scope": "all_projects",
  "mode": "exact",
  "query": "do not present command-text parsing as a production security boundary",
  "role": "user",
  "limit": 5
}
```

### semantic

Use for fuzzy conceptual recall when exact wording is unknown.

Global semantic search may fall back to lexical search with a warning. If that happens, try exact keywords from the manifest or inspected summaries.

```json
{
  "operation": "search",
  "scope": "all_projects",
  "mode": "semantic",
  "query": "user prefers memory tools to avoid opaque identifiers",
  "limit": 5
}
```

### combined

Use when both concept and wording matter. This is a good default for cross-project memory candidates.

```json
{
  "operation": "search",
  "scope": "all_projects",
  "mode": "combined",
  "query": "avoid opaque turn ids in memory workflows",
  "limit": 8,
  "charLimit": 16000
}
```

### audit

Use only for runtime evidence.

Good for:

- Did `edit_files` reject a patch?
- Which tool output caused the model to change direction?
- Did a shell command fail?
- Which file path was patched?

```json
{
  "operation": "search",
  "scope": "all_projects",
  "mode": "audit",
  "query": "oldText matched more than once",
  "include": ["tool_calls", "files", "errors"],
  "toolNames": ["edit_files"],
  "limit": 10
}
```

Do not use audit mode just because the final output will become a tool doc. If the evidence is conversation text, use normal search first.

## Scopes

### all_projects

Search all visible active or archived projects.

Use when:

- The manifest includes turns from more than one project.
- A durable memory may apply globally.
- You do not know which project contains the source evidence.

### current_project

Search the current project context for the memory-agent run.

Use when:

- The candidate lesson is clearly project-local.
- The manifest and current run are about one project.

### project

Search a specific project.

Use when:

- You have a `projectTitle` from `projects`.
- You have a `projectId` from the manifest.
- Cross-project search returned too much noise.

### current_conversation

Search only the current conversation context.

Use rarely in the Global Memory Agent. Prefer it only when the candidate came from the current run's latest conversation.

### recent_conversations

Search recent conversations.

Use when recency matters more than project-wide recall, or when checking the immediately preceding context.

## Selector Patterns

Prefer human-legible anchors while searching:

```json
{
  "operation": "search",
  "scope": "project",
  "projectTitle": "Socrates",
  "conversationTitle": "Global memory agent",
  "mode": "combined",
  "query": "exact evidence before edits",
  "limit": 5
}
```

Use ids after the backend has returned them:

```json
{
  "operation": "search",
  "scope": "project",
  "projectId": "proj_...",
  "conversationId": "conv_...",
  "mode": "exact",
  "query": "exact evidence before edits",
  "limit": 5
}
```

Use arrays when one lesson may have several sources:

```json
{
  "operation": "search",
  "scope": "all_projects",
  "projectTitle": ["Socrates", "AI_DPA"],
  "mode": "combined",
  "query": "local markdown notes should stay private",
  "limit": 10
}
```

## Queryless Browsing

Use queryless exact browsing for recency or known-title windows. It is not enough for memory edits by itself; follow up with a targeted search or inspect.

```json
{
  "operation": "search",
  "scope": "project",
  "projectTitle": "Socrates",
  "conversationLimit": 3,
  "perConversationLimit": 5,
  "limit": 10
}
```

## Turn Number Lookup

`turnNo` is exact and exclusive. Use it only when the evidence request is explicitly ordinal.

Correct:

```json
{
  "operation": "search",
  "scope": "project",
  "projectTitle": "Socrates",
  "conversationTitle": "trace retrieve test",
  "mode": "exact",
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

## Inspecting Results

Inspect when:

- The candidate memory depends on exact wording.
- The search result is a summary or secondary mention.
- The result is truncated.
- You need `sourceTurnIds` for `edit_files`.
- You need to separate user preference from one-off task instruction.
- You need to verify whether a runtime failure was tool behavior, model behavior, or user direction.

Inspect by result number:

```json
{
  "operation": "inspect",
  "resultNumber": 1,
  "charLimit": 20000
}
```

Inspect by returned handle:

```json
{
  "operation": "inspect",
  "handle": "trace_...",
  "include": ["messages", "tool_calls", "files", "errors"],
  "charLimit": 30000
}
```

Inspect by turn id from the manifest:

```json
{
  "operation": "inspect",
  "turnId": "turn_...",
  "include": ["messages", "tool_calls", "shell", "files", "errors"],
  "charLimit": 30000
}
```

## Common Investigation Recipes

### Convert a repeated correction into a durable preference

1. Search all projects with `combined` for the correction.
2. Inspect the strongest result.
3. Confirm it is a stable preference, not a one-off instruction.
4. Update the smallest relevant memory target with `sourceTurnIds`.

```json
{
  "operation": "search",
  "scope": "all_projects",
  "mode": "combined",
  "query": "do not ask the model to preserve opaque ids in memory workflows",
  "limit": 5
}
```

### Investigate a failed memory edit

1. Search audit evidence for `edit_files`.
2. Inspect the failed tool call.
3. Identify whether the issue was missing `oldText`, ambiguous `oldText`, target selection, or soul confirmation.
4. Retry only with a corrected patch.

```json
{
  "operation": "search",
  "scope": "all_projects",
  "mode": "audit",
  "query": "rejected oldText target already exists soul confirmation",
  "include": ["tool_calls", "errors"],
  "toolNames": ["edit_files"],
  "limit": 10
}
```

### Find evidence for a tool doc update

1. Search normal conversation text for the tool behavior discussion.
2. Search audit mode for actual tool results if behavior is disputed.
3. Inspect both if the doc change depends on both instruction and runtime evidence.

```json
{
  "operation": "search",
  "scope": "all_projects",
  "mode": "combined",
  "query": "trace_retrieve audit mode should be runtime evidence only",
  "limit": 5
}
```

### Narrow a noisy global search

1. Use `projects` to list likely projects.
2. Search with `projectTitle`.
3. Add `conversationTitle`, `updatedAfter`, `role`, or `entryType`.
4. Inspect the top result.

```json
{
  "operation": "search",
  "scope": "project",
  "projectTitle": "Socrates",
  "mode": "exact",
  "entryType": "assistant_response",
  "query": "This protected-path check is a cross-platform preflight guard",
  "limit": 5
}
```

## Output Interpretation

Prefer these fields:

- `resultNumber`: follow-up inspect handle.
- `handle`: stable inspect target returned by trace indexing.
- `text` or `content`: evidence excerpt or inspected source.
- `sourceKind` / `entryType`: what kind of evidence it is.
- `projectName` / `projectId`: project provenance.
- `conversationTitle` / `conversationId`: conversation provenance.
- `messageId`: exact message inspect target.
- `turnId`: stable source for `sourceTurnIds`.
- `toolCallId`: exact tool-call inspect target.
- `warnings`: must be read and followed.

## Failure Handling

If results are empty:

- State the searched scope in your reasoning.
- Try exact keywords from the manifest or known title.
- Widen from `project` to `all_projects` if the lesson may be global.
- Narrow by date or project if global search is too noisy.
- Stop after reasonable attempts. Do not loop identical calls.

If semantic or combined search warns that semantic is unavailable:

- Treat the result as lexical.
- Retry with exact keywords, titles, paths, or tool names.

If only summaries match:

- Treat them as leads.
- Inspect the source turn or conversation if available.
- Do not write memory until exact source evidence is found.

If audit results are noisy:

- Add `toolNames`, `paths`, `command`, or `include`.
- Inspect one relevant result instead of repeating broad audit search.

## Good Memory Edit Pattern

```text
Evidence: inspected turn <turnId> in project "<projectName>", conversation "<conversationTitle>".
Lesson: <one durable rule, not a transcript summary>.
Target: <identity | operating_principles | tool_doc | skill>.
Patch: smallest exact replacement or focused create.
```

## Checklist Before edit_files

- Did I inspect exact evidence, not just search snippets?
- Is the lesson durable across future turns?
- Is this the right target: soul, tool doc, or skill?
- Did I avoid making the model preserve unnecessary opaque ids?
- Do I have a stable `turnId` or handle for provenance?
- Did I use audit mode only for runtime behavior?
