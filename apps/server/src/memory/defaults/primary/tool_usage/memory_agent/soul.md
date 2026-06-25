---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# soul Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`soul` reads global Socrates `identity.md` for the memory agent.

It is the read path before rare edits to `identity`.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Before any proposed identity edit.
- When evidence may already be covered by global behavior rules.
- When a user correction appears global rather than project-specific.
- Do not use soul docs as evidence; use `trace_retrieve` for evidence.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "read"` reads the full identity document as bounded markdown. Use it only when the whole document is genuinely needed, and pass a tight `charLimit`.
- `operation: "read_index"` returns the structured section map.
- `operation: "read_section"` reads one known section by `sectionId`.
- `sectionId` can be `core_identity`, `voice_and_presence`, `relationship_to_user`, `operating_principles`, `safety_boundaries`, or `tool_and_memory_discipline`.
- `charLimit` bounds output.

Section meanings:
- `core_identity`: stable Socrates role, purpose, and self-definition.
- `voice_and_presence`: durable tone, cadence, warmth, directness, and conversational presence.
- `relationship_to_user`: stable collaboration stance toward this user.
- `operating_principles`: broad cross-project behavior rules.
- `safety_boundaries`: boundaries around secrets, destructive actions, privacy, and sensitive work.
- `tool_and_memory_discipline`: durable rules for context gathering, tool use, repo docs, project docs, skills, MCPs, and memory hygiene.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Start with `read_index` unless you already know the exact section id from this run.
2. Read the relevant identity section before considering an identity edit.
3. Compare the current document against inspected trace evidence.
4. Use `edit_files` only for small, durable, global changes.
5. Let the soul confirmation pass reject weak or unsafe edits.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If output is truncated, re-read with a larger `charLimit`.
- If the wrong section was selected, use `read_index` and then read the better section.
- If confirmation rejects an edit, do not retry broadly; report the rejection.
- If evidence is project-specific, skip soul edits and leave project memory to the main Socrates agent.
<!-- /socrates:section -->
