# soul Usage Guide

`soul` reads Socrates global identity and operating principles.

This tool is read-only. Use it when the answer or behavior depends on durable global identity, tone, collaboration rules, or core operating principles.

## Documents

| Document | Purpose |
| --- | --- |
| `identity` | Stable identity and user-facing role of Socrates. |
| `operating_principles` | Durable global behavior principles. |
| `both` | Read both documents when the distinction is unclear. |

## Common Calls

```json
{
  "operation": "read",
  "document": "identity"
}
```

```json
{
  "operation": "read",
  "document": "operating_principles"
}
```

```json
{
  "operation": "read",
  "document": "both",
  "charLimit": 12000
}
```

## Rules

- Use `soul` for global identity and principles, not project-specific facts.
- Use `project_docs` for workspace memory and notes.
- Use `repo_docs` for repo doctrine.
- Socrates cannot edit soul documents.
