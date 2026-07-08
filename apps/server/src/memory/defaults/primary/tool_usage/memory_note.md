---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# memory_note Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`memory_note` lets the main Socrates agent send a short lead to the Global Memory Agent.

It is an agent-to-agent notepad entry, not a memory write or routing request. The backend automatically attaches the current user message, source project, conversation id, message id, turn id, and default project-local context.

Prefer one note per user turn. The backend normalizes note text, deduplicates repeated leads, and hard-caps distinct memory notes at two per user turn.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The current user message contains a durable preference, boundary, identity/profile fact, or strong correction.
- The user explicitly states an allergy, dietary restriction, accessibility constraint, safety boundary, or strong "please remember/keep in mind" preference, even inside an otherwise ordinary task.
- The turn reveals a genuinely reusable workflow that the Memory Agent may later classify as a skill candidate.
- Socrates notices something important for long-term recall but should not write identity, user profile, or skills directly.
- Do not use it for ordinary task details, temporary plans, weak hints, or facts only needed in the current turn.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `note`: one short human-readable lead for the Memory Agent. Merge related memory candidates into one clean note.
- `importance`: optional `normal` or `high`.
- Do not include conversation ids or message ids in the note unless the user explicitly named them; the backend attaches the current source automatically.
- Do not include target names, skill names, scope choices, or instructions to update a specific memory file.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Keep the note concise and specific.
2. State what seemed important and why the Memory Agent should inspect the current turn.
3. Do not send variants of the same lead. If the tool returns `already_recorded`, treat that memory candidate as already queued or handled.
4. Use `high` for strong corrections, durable identity/profile facts, explicit allergy/safety/accessibility/dietary boundaries, or highly reusable patterns.
5. Continue the user's current task; do not wait for the Memory Agent.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If `memory_note` fails, continue the user-facing task and mention the failed note only if it affects the outcome.
- Do not retry with manually invented ids.
- For immediate project notes or repo docs, use `project_docs` or `repo_docs` instead of `memory_note`.
<!-- /socrates:section -->
