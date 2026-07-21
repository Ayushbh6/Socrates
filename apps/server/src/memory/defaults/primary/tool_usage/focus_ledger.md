---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# focus_ledger Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`focus_ledger` is available only in Flow view. It reads the bounded project goal ledger and records progress, blockers, or completion for the goal already bound to the current turn.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- List or inspect goals when Flow navigation context is needed.
- Update the current goal capsule after meaningful progress or record a real blocker.
- Complete the current goal only when the user's requested outcome is genuinely finished.
- Do not use it to switch goals, delete evidence, or complete General Conversation.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation` is `list`, `inspect`, `update_current`, `record_blocker`, or `complete_current`.
- `inspect` requires the exact returned `goalId`.
- Current-goal mutations use `summary`, `blocker`, or `outcome` as required by the live schema; the active goal is implicit.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Work through the normal shared Socrates tools and runtime.
2. Record only material goal progress, a concrete blocker, or genuine completion.
3. Keep ledger text short, human-readable, and grounded in the current turn's evidence.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If unavailable, continue the task normally; the tool exists only in Flow.
- If a mutation is rejected because the goal is not bound to the turn, do not target a different goal manually.
- If completion is uncertain, update progress or leave the goal active rather than claiming success.
<!-- /socrates:section -->
