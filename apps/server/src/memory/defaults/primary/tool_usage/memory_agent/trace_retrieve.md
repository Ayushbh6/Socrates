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

`trace_retrieve` gives the Global Memory Agent exact prior conversation and runtime evidence.

Use it to prove what happened before writing global memory.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Before any `edit_files` write.
- When manifest metadata suggests a durable preference, correction, behavior rule, or repeated tool pattern.
- When tool calls, shell output, patches, files, screenshots, or errors matter.
- Do not treat search snippets or project metadata as sufficient evidence.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "search"` locates evidence; `operation: "inspect"` reads exact evidence.
- `mode: "audit"` is for runtime/tool evidence; normal text search is for user/assistant wording.
- Selectors include project, conversation, title, turn, role, entry type, path, command, tool ID, dates, and limits.
- Inspect can use result numbers, handles, or exact IDs returned by search.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Use `projects` first if the target project or conversation is unclear.
2. Search with the smallest query and scope likely to find the evidence.
3. Inspect promising results before deciding on a write.
4. Use audit mode for tools, shell, files, patches, screenshots, and errors.
5. Prefer titles, dates, commands, paths, and short quotes in rationales; avoid opaque IDs unless they are required provenance.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If no results appear, broaden scope, remove over-specific filters, or search by title/tool/path.
- If too many results appear, narrow by project, conversation, mode, role, date, path, or command.
- If output is truncated, inspect the result or raise `charLimit`.
- If audit mode misses normal conversation text, retry with text search.
- If evidence remains weak or ambiguous, skip the edit.
<!-- /socrates:section -->
