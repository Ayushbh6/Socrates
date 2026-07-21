---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# handover_to_frontier Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`handover_to_frontier` requests an approval-gated, one-way transfer of the rest of the current turn to the configured Frontier model with the complete conversation and tool history.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Only after Socrates has made a substantive effort and reached a concrete capability or reliability blocker it cannot overcome.
- Never merely because work is long, difficult, important, or involves several ordinary tool calls.
- Call it alone and without prose; the user must approve the transfer.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- Optional `focus` is at most 20 words and 160 characters and names only the unresolved priority.
- Do not restate the full task, add a reason field, or request a consultation/return mode.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Exhaust sound in-scope evidence and tools.
2. Identify the exact remaining blocker.
3. Call the tool alone with an optional compact focus and await approval.
4. If accepted, Frontier supplies the sole final answer for the turn.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If the user rejects the handover, do not request it again that turn; continue with Socrates.
- If Frontier is unavailable, report the concrete blocker and finish as honestly as possible.
<!-- /socrates:section -->
