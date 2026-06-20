---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# trace_retrieve Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`trace_retrieve` supports evidence investigation across prior visible conversations and persisted runtime evidence such as assistant messages, user requests, tool calls, shell output, file operations, patches, screenshots, and errors.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The user refers to prior chats, exact wording, previous tool behavior, screenshots, or earlier errors.
- You need audit evidence for what actually happened in a conversation.
- Prior context may affect a memory, diagnosis, regression, or handoff claim.
- Do not use it for current workspace docs that have dedicated tools; use `project_docs`, `repo_docs`, or `tool_docs`.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "search"` finds prior entries; `operation: "inspect"` reads a selected result or handle.
- Modes include conversation/text search, semantic search when available, and audit search for runtime/tool evidence.
- Scope and filters include project/conversation selectors, title, role, entry type, dates, paths, commands, tool IDs, and limits.
- Inspect can use result numbers, handles, turn numbers, IDs, or exact selectors returned by search.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Start with the smallest search that can locate the relevant conversation or evidence.
2. Use audit mode for tool calls, shell output, files, patches, and errors; use normal conversation search for user/assistant text.
3. Inspect promising results before making claims or memory edits.
4. Prefer human-legible anchors in answers: titles, turn numbers, dates, commands, paths, and short quotes.
5. Avoid duplicate calls with identical inputs; narrow or change the query when the first search was insufficient.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If search returns no results, broaden dates, remove over-specific filters, or search by title/path/tool name.
- If results are too broad, narrow by project, conversation, mode, role, command, path, or date.
- If output is truncated, inspect the result or re-run with a larger `charLimit`.
- Treat search snippets as leads; inspect before treating them as evidence.
- If semantic search is unavailable, use exact text, title, audit, or metadata filters.
<!-- /socrates:section -->
