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

`trace_retrieve` recalls prior visible conversations in the active project for conversation and evidence investigation. Conversation search uses canonical Q&A parents in the shared LanceDB retrieval index. Audit search reads authoritative runtime evidence from SQLite.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The user refers to prior chats, literal wording, previous tool behavior, screenshots, or earlier errors.
- You need audit evidence for what actually happened in a conversation.
- Prior context may affect a memory, diagnosis, regression, or handoff claim.
- Do not use it for current workspace docs that have dedicated tools; use `project_docs`, `repo_docs`, or `tool_docs`.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "search"` finds prior Q&A parents; `operation: "inspect"` reads one full Q&A parent.
- `mode: "lexical"` performs literal FTS over every supplied term. Keep the query concise; the hard limit is 128 characters. Nothing is silently dropped or truncated.
- `mode: "semantic"` performs vector retrieval for conceptual recall. `mode: "combined"` fuses lexical and vector rankings.
- `mode: "audit"` searches raw tool calls, shell output, file operations, patches, and errors. Its query limit is 1,000 characters.
- Search covers the full active project by default. Optional scopes are `current_conversation`, `recent_conversations`, and `project`; cross-project selectors are unavailable.
- Results contain at most eight numbered entries with content, turn id, conversation title, turn number, matched role, status, and time. Inspect by `resultNumber`, `turnId`, or `conversationTitle` plus `turnNo`.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Choose lexical for known literal words, semantic for a concept, combined when both signals help, and audit only for runtime/tool evidence.
2. Search the full project unless current or recent conversation scope is genuinely sufficient.
3. Inspect promising results before making claims or memory edits.
4. Prefer human-legible anchors in answers: titles, turn numbers, dates, commands, paths, and short quotes.
5. Avoid duplicate calls with identical inputs; narrow or change the query when the first search was insufficient.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If lexical input exceeds 128 characters or another input is malformed, correct the recoverable tool error; do not expect silent query rewriting.
- If search returns no results, try a better literal phrase, semantic wording, combined mode, or fewer filters.
- If results are too broad, narrow by conversation scope/title, role, date, command, or path.
- Treat search snippets as leads; inspect before treating them as evidence.
- If semantic search is rebuilding or unavailable, use lexical search or exact inspect/audit evidence until vectors are ready.
<!-- /socrates:section -->
