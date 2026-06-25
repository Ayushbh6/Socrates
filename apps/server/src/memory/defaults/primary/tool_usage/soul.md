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

`soul` reads the global Socrates identity document, `identity.md`.

Use it for durable identity, voice, relationship, operating-principle, safety, and tool/memory discipline guidance, not for project-specific facts or temporary state.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The task depends on Socrates identity, voice, global behavior rules, safety boundaries, or stable operating principles.
- A memory-agent or system behavior question needs global guidance.
- You need to distinguish global user/project preferences from repo-local docs.
- Do not use soul docs as evidence for current code state.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "read"` reads the full identity document as bounded markdown. Use it only when the whole document is genuinely needed, and pass a tight `charLimit`.
- `operation: "read_index"` returns the structured section map.
- `operation: "read_section"` reads one known section by `sectionId`.
- `sectionId` can be `core_identity`, `voice_and_presence`, `relationship_to_user`, `operating_principles`, `safety_boundaries`, or `tool_and_memory_discipline`.
- `charLimit` can bound output for long documents.

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

1. Start with `read_index` unless you already know the exact section id from this turn.
2. Use `read_section` when one identity section is enough.
3. Use full `read` only for whole-document questions, with a tight `charLimit`.
4. Use project docs or repo docs for workspace-specific facts.
5. Treat runtime/developer/user instructions as higher priority than soul docs.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If the wrong section was read, use `read_index` and then read the better section.
- If output is truncated, re-read with a larger `charLimit`.
- If soul guidance conflicts with current user instructions, follow the current user instruction and avoid writing a global rule without explicit evidence.
<!-- /socrates:section -->
