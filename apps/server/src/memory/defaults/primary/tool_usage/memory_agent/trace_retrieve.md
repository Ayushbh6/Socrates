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

`trace_retrieve` gives the Global Memory Agent prior conversation and runtime evidence for cross-project investigation. It uses the same Q&A indexing, lexical/vector/hybrid retrieval, audit behavior, inspect behavior, limits, and clean results as main Socrates. Its only broader capability is cross-project scope.

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

- `operation: "search"` locates Q&A parents; `operation: "inspect"` reads one full Q&A parent.
- `mode: "lexical"` performs literal FTS over every supplied term. Use a concise query of at most 128 characters; nothing is silently removed.
- `mode: "semantic"` performs conceptual vector retrieval. `mode: "combined"` fuses lexical and vector rankings.
- `mode: "audit"` searches authoritative raw tool, shell, file, patch, and error evidence with a query of at most 1,000 characters.
- Search covers all projects by default. Use `scope: "project"` plus `projectId` or `projectTitle` to narrow; conversation id/title, role, dates, and a maximum-eight limit are optional.
- Results contain at most eight numbered entries with project title, conversation title, turn number/id, matched role, status, time, and content. Inspect by `resultNumber`, `turnId`, or project/conversation/turn coordinates.
- Legacy `exact`, trace handles, entry-type selectors, and hidden query normalization are not part of this contract.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Use `projects` first if the target project or conversation is unclear.
2. Choose lexical for known literal wording, semantic for concepts, combined when both signals help, and audit only for runtime evidence.
3. Inspect promising results before deciding on a write.
4. Use audit mode for tools, shell, files, patches, screenshots, and errors.
5. Prefer titles, dates, commands, paths, and short quotes in rationales; avoid opaque IDs unless they are required provenance.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If lexical input exceeds 128 characters or another input is malformed, correct the recoverable tool error; the backend never silently slices the query.
- If no results appear, broaden project scope, remove over-specific filters, or try a better lexical/semantic/combined query.
- If too many results appear, narrow by project, conversation, role, date, path, or command.
- If audit mode misses normal conversation text, retry with lexical, semantic, or combined search.
- If evidence remains weak or ambiguous, skip the edit.
<!-- /socrates:section -->
