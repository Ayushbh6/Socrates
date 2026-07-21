---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# current_time Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`current_time` gives the Memory Agent the backend-owned current date, ISO timestamp, and time zone.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Before writing date-sensitive memory prose or resolving relative-date evidence.
- Never infer today's date from older turns, run summaries, or stored memory.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- The tool accepts an empty object.
- Treat its returned time zone and timestamp as authoritative for the run.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Call only when the investigation or proposed memory wording depends on current time.
2. Use the returned value in human-readable prose without storing unnecessary timestamps.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If unavailable, avoid asserting a current date; preserve the source evidence's explicit dates instead.
<!-- /socrates:section -->
