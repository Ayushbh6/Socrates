---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# read_memory_journal Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`read_memory_journal` reads the Memory Agent's own older structured run handoffs. It is not a substitute for conversation evidence or global memory search.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The current briefing's latest handoff and recent summaries point to an older unresolved investigation.
- Use it only with a concrete continuity question; do not page through journal history broadly.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "list"` returns a small bounded run list; default 5, maximum 10.
- `operation: "read"` requires an exact returned `runId` and supports bounded `charLimit` up to 20,000.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Use the briefing first.
2. List only when an older run is genuinely relevant.
3. Read one exact run, then use `trace_retrieve` for authoritative source evidence before any memory change.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If a run is missing or truncated, do not infer its contents; continue from current evidence.
- Never treat a journal summary alone as sufficient proof for a memory edit.
<!-- /socrates:section -->
