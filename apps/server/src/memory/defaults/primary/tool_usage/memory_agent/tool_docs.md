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

`tool_docs` reads and searches memory-agent-specific tool guidance under `~/.Socrates/tool_usage/memory_agent/*.md`.

It is read-only for the memory agent in v1.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Memory-agent tool behavior, parameters, routing, or failure handling is uncertain.
- A memory-agent tool failed and guidance should be checked before retrying.
- A complex `trace_retrieve`, `projects`, `skills`, `soul`, or `edit_files` decision needs local guidance.
- Evidence suggests a tool-doc improvement; read current guidance before reporting the candidate.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "read"` reads one doc or the visible memory-agent doc index.
- `operation: "search"` searches memory-agent guidance.
- `path: "."` lists visible memory-agent docs.
- `path: "<name>.md"` reads a memory-agent doc.
- `query`, `searchMode`, `limit`, `offset`, `contextLines`, and `charLimit` control search and output.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Read `.` when the relevant memory-agent doc is unknown.
2. Read the specific doc before retrying a failed memory-agent tool.
3. Search by tool name, operation, failure code, or parameter when the exact doc is unclear.
4. Follow only the memory-agent-visible docs; root Socrates docs are for the main agent.
5. Report proposed tool-doc improvements in `Skipped`; do not edit tool docs.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If a path is missing, read `.` and choose a listed memory-agent doc.
- If search has no hits, broaden by operation name or failure symptom.
- If output is truncated, re-read the file with a larger `charLimit`.
- If guidance appears stale, report the proposed correction and trace evidence in `Skipped`.
<!-- /socrates:section -->
