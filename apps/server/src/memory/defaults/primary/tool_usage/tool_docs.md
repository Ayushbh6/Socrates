---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# tool_docs Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`tool_docs` reads and searches root Socrates tool guidance under `~/.Socrates/tool_usage`.

For the main Socrates agent, this excludes `tool_usage/memory_agent/**`.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Tool behavior, parameters, routing, or failure handling is uncertain.
- A tool failed and guidance should be checked before retrying.
- A docs, memory, trace, terminal, edit, skill, or MCP workflow has edge cases.
- The user asks how Socrates is supposed to use a tool.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "read"` reads a doc or directory index.
- `operation: "search"` searches guidance by query.
- `path: "."` or `path: "tool_usage"` lists visible root docs.
- `path: "<name>.md"` reads a specific root doc.
- `query`, `searchMode`, `limit`, `offset`, `contextLines`, and `charLimit` control search scope and output size.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Read `.` to list available root guidance when the target doc is unknown.
2. Read a specific doc before retrying a failed or unfamiliar tool.
3. Search by tool name plus failure symptom when exact guidance is unknown.
4. Follow the guidance from the visible root docs only; memory-agent-specific docs are for the background memory worker.
5. Treat tool docs as read-only model guidance in v1.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If a path is missing, read `.` and choose from the listed files.
- If search has no useful hits, search by operation name, failure code, or parameter name.
- If output is truncated, re-read the specific file with a larger `charLimit`.
- If live guidance conflicts with bundled release behavior, prefer current runtime behavior and report the stale doc.
<!-- /socrates:section -->
