# soul Usage Guide

`soul` reads global identity and operating principles.

Use it before proposing edits to identity or operating principles so updates preserve the existing structure and do not duplicate content.

## Documents

- `identity`
- `operating_principles`
- `both`

## Common Calls

```json
{
  "operation": "read",
  "document": "both",
  "charLimit": 16000
}
```

## Rules

- Read the relevant soul document before editing it.
- Edit soul only through `edit_files`.
- Soul edits must be rare, durable, evidence-backed, and small.
- Project-specific memory is read-only to this worker.
