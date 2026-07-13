---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# memory_notes Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`memory_notes` is the Memory Agent inbox for short leads sent by the main Socrates agent.

Each note is a human-readable notepad item. The backend attaches the source turn, user message, source project, default skill scope, conversation id, and message id so the Memory Agent can chain into `trace_retrieve` for real evidence.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The manifest says open memory notes exist.
- Socrates flagged a user preference, strong correction, durable profile fact, or skill-worthy workflow.
- You need exact source ids for a note before using `trace_retrieve`.
- You finished investigating a note and need to mark it done.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "list"` returns open and processing notes with previews. Use `limit` 10 or less; the contract caps list output at 10.
- `operation: "read"` takes `noteNumber`, returns the full note and attached source ids, and marks an open note as processing.
- `operation: "mark_done"` takes `noteNumber`, `outcome`, and a one-line `resolution`, then closes the note after you handled it.
- `outcome` must be one of `applied`, `already_represented`, `skipped`, or `proposed_skill`.
- `limit` controls list size up to 10.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. List notes when the manifest says the inbox is non-empty; do not request more than 10.
2. Read one relevant note before acting on it.
3. Use the returned project, conversation, turn, or message ids with `trace_retrieve` when the note needs exact evidence.
4. Classify the note first: user profile, identity, skill proposal, or no durable action.
5. Before any durable action, inspect the exact full Q&A parent and evaluate the full source user message. A note, excerpt, search chunk, or assistant paraphrase is not enough to authorize a write.
6. Check for a genuine memory opt-out. Interpret intent semantically: quoted examples, hypotheticals, and discussion of opt-out behavior are not themselves opt-outs. Apply a clearly scoped opt-out only to that content; if scope is broad or ambiguous, treat the whole source message as opted out.
7. Make the appropriate identity/profile edit or skill proposal only if evidence supports it and the content was not opted out.
8. Mark the note done only after the relevant action is recorded, you confirm the memory is already represented, or you decide the note is not durable enough. Always include a compact `outcome` plus `resolution` saying what you did, what already covered it, or why you skipped it.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If a note lacks enough evidence, use the attached ids first; then search trace context by titles or keywords.
- If the evidence is weak, stale, or project-specific rather than global, use outcome `skipped` and put that reason in the `mark_done` resolution.
- If the user genuinely opted the source content out of memory, use outcome `skipped`, do not edit or propose anything, and use a generic resolution that does not repeat the withheld content.
- If the evidence is already represented in identity/user_profile/skills, use outcome `already_represented` and identify the existing section or skill in the resolution.
- If `mark_done` fails, mention the note number in `Blocked`.
<!-- /socrates:section -->
