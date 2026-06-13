# project_docs Usage Guide

`project_docs` reads, searches, and edits the active workspace's project-scoped memory files.

It is the only normal way Socrates should update `.socrates/MEMORY.md` and `.socrates/PROJECT_NOTES.md`.

## Targets

| Area | File | Purpose |
| --- | --- | --- |
| `memory` | `.socrates/MEMORY.md` | Durable project state, decisions, constraints, user preferences, handoff facts. |
| `notes` | `.socrates/PROJECT_NOTES.md` | Active working notes, temporary findings, next steps, investigation breadcrumbs. |

## Operations

```json
{
  "operation": "read",
  "area": "memory"
}
```

```json
{
  "operation": "search",
  "area": "notes",
  "query": "migration"
}
```

```json
{
  "operation": "edit",
  "area": "notes",
  "editMode": "append",
  "text": "## Current investigation\n\n- Found the failing route."
}
```

```json
{
  "operation": "edit",
  "area": "memory",
  "editMode": "replace",
  "oldText": "Old durable fact.",
  "newText": "Updated durable fact."
}
```

## Rules

- Read or search before editing unless appending a fresh working note.
- Use `notes` for short-lived work.
- Use `memory` only for curated durable state.
- Keep memory edits small and evidence-backed.
- Do not use generic file edit or apply_patch on these files.

## Update Heuristic

Update `notes` after meaningful investigations where a next agent would benefit.

Update `memory` when a stable project decision, constraint, preference, or current standing changed.

Skip both when the work was trivial, speculative, or already represented.
