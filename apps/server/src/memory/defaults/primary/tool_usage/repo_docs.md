# repo_docs Usage Guide

`repo_docs` reads, searches, and edits the active workspace's durable repo doctrine.

It is the only normal way Socrates should update `.socrates/repo_docs/*.md`.

## Files

| File | Purpose |
| --- | --- |
| `CORE_IDEA.md` | Repo purpose, current state, current user direction. |
| `REPO_NAVIGATION.md` | Where important code lives and how to move through the repo. |
| `REPO_RULES.md` | Durable repo-specific engineering rules and constraints. |
| `CONTRACTS.md` | Important APIs, data contracts, tool contracts, frontend/backend contracts. |

## Common Calls

Read the repo-doc index:

```json
{
  "operation": "read"
}
```

Read one file:

```json
{
  "operation": "read",
  "path": "REPO_RULES.md"
}
```

Search all repo docs:

```json
{
  "operation": "search",
  "query": "database contract"
}
```

Edit one durable rule:

```json
{
  "operation": "edit",
  "path": "CONTRACTS.md",
  "oldText": "Old contract text.",
  "newText": "New contract text."
}
```

## Rules

- Use `repo_docs` for durable repo doctrine only.
- Do not write temporary notes here.
- Prefer small `oldText`/`newText` replacements with enough context to match once.
- Do not use generic file edit or apply_patch on repo docs.
- Update repo docs when architecture, contracts, navigation, workflows, or persistent pitfalls change.
