# project_docs Usage Guide

`project_docs` reads, searches, and edits the active workspace's project-scoped memory files.

It is the only normal way Socrates should update `.socrates/MEMORY.md` and `.socrates/PROJECT_NOTES.md`.

These files are a core context-engineering surface. Use them actively so Socrates can stay coherent across turns and across different conversations in the same project.

## Targets

| Area | File | Purpose |
| --- | --- | --- |
| `memory` | `.socrates/MEMORY.md` | Durable cross-conversation project state: goals, decisions, constraints, user preferences for this project, handoff facts, stable current standing. |
| `notes` | `.socrates/PROJECT_NOTES.md` | Active assistant notebook: todos, near-term next steps, temporary findings, investigation breadcrumbs, short-lived working state. |

## Mental Model

`memory` is Socrates' live project memory. It is where durable project facts survive across different chats. Treat it as very important.

Use `memory` for facts that should still guide Socrates tomorrow or in a new conversation:

- Current project goal or direction.
- Durable decisions and constraints.
- Stable user preferences for this project.
- Long-lived blockers, risks, and unresolved handoff facts.
- The exact current standing after a meaningful work session.

`notes` is Socrates' working notebook, like a real assistant's scratchpad and todo list.

Use `notes` for active state that helps the next few turns:

- "Do next" tasks the user gave Socrates.
- Investigation breadcrumbs and files already checked.
- Temporary hypotheses, next commands, and short checklists.
- Work-in-progress handoff after a cancelled, stopped, or hard-stopped run.

`notes` may also contain a backend-owned `runtime_context` section. That section is generated from workspace scan facts such as detected Python environments, dependency files, and package-manager hints. It is protected: do not try to edit it, and do not persist terminal output or live terminal state there.

## Expected Cadence

For nontrivial project work, Socrates should usually read or search `memory` and `notes` early unless the current visible context is clearly enough.

For ongoing work, update `notes` or `memory` roughly every 1-2 meaningful turns when new future-relevant state exists. This does not mean noisy edits after every command; it means do not let important state remain only in transient chat text.

Use `notes` more often than `memory`. Promote only stable, durable facts into `memory`.

Skip edits when the turn is trivial, speculative, already represented, or has no future relevance.

## Explicit Operating Loop

1. Before meaningful implementation or repo investigation, use `repo_docs` first for relevant repo doctrine. If the repo docs are missing, stale, or conflict with known current repo state, update `repo_docs` before implementation.
2. After meaningful work, update `memory` with durable outcomes, decisions, constraints, blockers, and handoff facts that should survive across conversations.
3. Use `notes` actively while working to sustain important live information across sessions: current todos, checked files, next commands, partial progress, and restart points.

## Operations

Read the parsed section index before broad reads when you only need a map:

```json
{
  "operation": "read_index",
  "area": "memory"
}
```

Read one structured section by id:

```json
{
  "operation": "read_section",
  "area": "memory",
  "sectionId": "handoff"
}
```

Patch one structured section by id:

```json
{
  "operation": "patch_section",
  "area": "memory",
  "sectionId": "handoff",
  "oldText": "Old handoff fact.",
  "newText": "Updated handoff fact."
}
```

All `project_docs` outputs may include a `runtime` object with backend-owned `currentDate`, `currentDateTime`, `timeZone`, and `source: "system"`. Use it as the date authority for docs workflows when a date is needed. Successful docs edits also stamp YAML frontmatter with backend-owned `updated_at`, `updated_by`, and `last_edited_section`.

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

- Prefer `read_index` before broad reads when the goal is orientation.
- Prefer `read_section` and `patch_section` for known sections. Use full-file `read` or `edit` only when the section index is insufficient.
- Do not patch or replace the `runtime_context` section. It is system-owned.
- Read or search before editing unless appending a fresh working note.
- Use `notes` for short-lived work and active todos.
- Use `memory` only for curated durable state that should survive across conversations.
- Keep memory edits small, evidence-backed, and human-readable.
- Prefer concise bullets over long transcripts.
- If a note became stale or completed, replace or condense it instead of appending forever.
- Do not use generic file edit or apply_patch on these files.

## Update Heuristic

Update `notes` after meaningful investigations where a next agent would benefit, after the user gives Socrates a todo, or before final answer when the current work creates useful next steps.

Update `memory` when a stable project decision, constraint, preference, long-lived blocker, or current standing changed.

Skip both when the work was trivial, speculative, or already represented.

## Few-Shot Examples

User intent: "Continue from where we left off."

Good tool flow:

```json
{
  "operation": "read_index",
  "area": "memory"
}
```

```json
{
  "operation": "read_section",
  "area": "notes",
  "sectionId": "state_ledger"
}
```

Then answer from the stored state and current files. If you discover the notes are stale, update them before final.

User intent: "Please remember that the next thing is to test the visa workflow tomorrow."

Good update:

```json
{
  "operation": "edit",
  "area": "notes",
  "editMode": "append",
  "text": "## Active todo\n\n- Test the visa workflow tomorrow before making more changes."
}
```

User intent: "This is now the project rule: never wipe app-data without asking."

Good update:

```json
{
  "operation": "edit",
  "area": "memory",
  "editMode": "append",
  "text": "## Durable project rule\n\n- Never wipe app-data or runtime memory without explicit user approval."
}
```

User intent: A debugging turn found the failing file, a workaround, and one unresolved blocker.

Good end-of-turn update:

```json
{
  "operation": "edit",
  "area": "notes",
  "editMode": "append",
  "text": "## Debug handoff\n\n- Checked src/api/client.ts and src/api/cache.ts.\n- Failing command: pnpm test -- cache.test.ts.\n- Likely blocker: stale fixture data; next step is to inspect tests/fixtures/cache.json."
}
```
