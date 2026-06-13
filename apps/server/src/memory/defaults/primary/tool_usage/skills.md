# skills Usage Guide

`skills` lists, searches, and reads reusable Socrates skills.

Skills are read-only. Use them when a reusable workflow, learned pattern, or specialized procedure may apply.

## Operations

List visible skills:

```json
{
  "operation": "list"
}
```

Search skills:

```json
{
  "operation": "search",
  "query": "frontend testing"
}
```

Read a skill:

```json
{
  "operation": "read",
  "name": "memory-review"
}
```

Read a safe relative file inside a skill:

```json
{
  "operation": "read",
  "name": "memory-review",
  "path": "references/checklist.md"
}
```

## Scopes

- `builtin`: shipped immutable skills.
- `global`: user-level learned skills.
- `project`: workspace-specific skills under `.socrates/skills`.

## Rules

- List or search first when unsure which skill applies.
- Read the selected `SKILL.md` before applying it.
- Read referenced files only when the skill says they matter.
- Do not create or edit skills from main chat.
- Do not use generic file edit or apply_patch on `.socrates/skills/**`.
