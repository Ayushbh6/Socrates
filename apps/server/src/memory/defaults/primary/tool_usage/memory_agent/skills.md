# skills Usage Guide

`skills` lists, searches, and reads visible skills for this worker.

Scheduled memory runs may read skills for context, but must not create or update skills.

## Operations

```json
{
  "operation": "list",
  "scope": "global"
}
```

```json
{
  "operation": "search",
  "query": "tool usage"
}
```

```json
{
  "operation": "read",
  "scope": "global",
  "name": "general"
}
```

## Rules

- Use skills as read-only background guidance.
- Do not treat a skill as evidence for a memory edit.
- Use `trace_retrieve` for evidence.
- Do not call `edit_files` to create or update skills during scheduled runs.
- If a useful reusable workflow should become a skill, mention it in `Skipped` so the user can trigger Memory Center `Skills +`.
