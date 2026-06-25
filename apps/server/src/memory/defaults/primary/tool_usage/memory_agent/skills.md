---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# skills Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`skills` lets the Global Memory Agent list and describe reusable workflow guidance.

Skills are read-only background guidance for scheduled memory runs and are not evidence for memory edits.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- A reusable workflow or skill may help interpret a repeated pattern.
- The manifest suggests a skill candidate that should be reported for human review.
- You need to understand an existing skill before deciding whether evidence is already represented elsewhere.
- Do not use skills as proof of user behavior or current project state.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "list"` lists skills with exact ids, names, scopes, and descriptions.
- `operation: "describe"` reads a specific skill by exact `id` or `name` and optional `scope`.
- `n` controls list size; `charLimit` controls described skill content size.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. List skills when reusable guidance may apply.
2. Describe the most specific skill before relying on it.
3. Use `trace_retrieve` for exact evidence before any memory write.
4. If a new or changed skill seems useful, report the candidate in `Skipped`; scheduled runs must not edit skills.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If no skill matches, continue with trace evidence and existing memory surfaces.
- If the list is too broad, narrow by scope or describe only the strongest exact match.
- If a skill is missing or stale, report the candidate improvement in `Skipped`.
- If an attempted skill write is rejected, do not retry; scheduled runs cannot update skills.
<!-- /socrates:section -->
