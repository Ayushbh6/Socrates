---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# edit_files Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`edit_files` is the Global Memory Agent's only scheduled-run write tool.

In v1 it writes only global `identity`, `operating_principles`, and `user_profile` targets. Tool docs and skills are read-only for scheduled memory runs.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Use it only after exact evidence has been inspected with `trace_retrieve`.
- Use it for small durable global memory improvements, not routine summaries.
- Use soul targets rarely and only for broad identity or operating-principle changes.
- Use `user_profile` for stable cross-project user facts or preferences.
- Do not use it for tool-doc or skill improvements; report those candidates in the final `Skipped` section with evidence.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `target`: `identity`, `operating_principles`, `user_profile`, or `skill`.
- `skill` is exposed as a target shape but scheduled runs cannot create or update skills.
- `editMode: "replace"` requires exact `oldText` and `newText`.
- `sectionId` can narrow replacement to one structured section for identity, operating principles, or user profile.
- `rationale` should explain why the evidence is durable.
- `sourceTurnIds` should cite inspected source turns when available.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Inspect exact evidence with `trace_retrieve`; do not edit from manifest summaries or project metadata.
2. Read the current target with `soul` or `user_profile`.
3. Choose the smallest exact `oldText` span that should change.
4. Prefer `sectionId` when updating a structured memory section.
5. Call `edit_files` with a focused replacement and evidence-backed rationale.
6. If evidence suggests a tool-doc or skill improvement, do not call `edit_files`; report the proposed wording and evidence in `Skipped`.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If `oldText` matches zero or multiple times, re-read the target and retry only with a clearly unique span.
- If soul confirmation rejects an edit, do not force it; report the rejection in the final summary.
- If a skill write is rejected, report the skill candidate in `Skipped`.
- If a tool-doc update seems useful, never retry with `target: "tool_doc"`; tool docs are read-only for models in v1.
- If evidence is weak, stale, or project-specific, skip the edit.
<!-- /socrates:section -->
