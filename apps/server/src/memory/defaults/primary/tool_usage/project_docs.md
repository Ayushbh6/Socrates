---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# project_docs Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`project_docs` reads, searches, and edits the active workspace's project-scoped memory files.

It is the normal way Socrates should update `.socrates/MEMORY.md` and `.socrates/PROJECT_NOTES.md`.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Use `area: "memory"` for durable project facts that should survive across conversations.
- Use `area: "notes"` for active todos, investigation breadcrumbs, next commands, and short-lived handoff state.
- Read project docs before meaningful workspace work when continuity, prior decisions, or active todos matter.
- Update project docs after meaningful work only when there is durable value, changed standing, a blocker, or useful restart context.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "read"` reads one project doc area.
- `operation: "search"` searches project memory and notes.
- `operation: "read_index"` lists structured sections and hashes.
- `operation: "read_section"` requires `sectionId`.
- `project_docs patch_section` (`operation: "patch_section"`) requires `sectionId`, exact `oldText`, and `newText`; do not pass `text`.
- `operation: "edit"` with `editMode: "append"` uses `text`; `editMode: "replace"` uses exact `oldText` and `newText`.
- Outputs may include a backend-owned `runtime` object with current date/time.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Read `notes` for active state and `memory` for durable project context.
2. Use `read_index` or `read_section` before precise structured updates.
3. Use `patch_section` for bounded section edits and `edit append` for appending short notes.
4. Do not edit the backend-owned `runtime_context` section in `PROJECT_NOTES.md`.
5. Keep memory concise: store durable state in `MEMORY.md`, temporary state in `PROJECT_NOTES.md`, and repo doctrine in `repo_docs`.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If `patch_section` rejects because text does not match, re-read the section and retry with exact current text.
- If a section is missing, read the index and choose an existing section instead of inventing one.
- If the runtime-owned section is rejected, leave it to the backend and update another notes section if needed.
- If docs look stale, update the smallest relevant section and cite the current evidence in the prose.
<!-- /socrates:section -->
