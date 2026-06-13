# tool_docs Usage Guide

`tool_docs` reads and searches this worker's tool guidance.

This tool exposes only docs under `tool_usage/memory_agent/`.

## Core Principle

Use `tool_docs` when memory-agent tool behavior is uncertain.

Use these docs for this worker's tools only.

## Common Calls

List memory-agent docs:

```json
{
  "operation": "read",
  "path": "."
}
```

Read one memory-agent tool doc:

```json
{
  "operation": "read",
  "path": "edit_files.md"
}
```

Search memory-agent docs:

```json
{
  "operation": "search",
  "query": "soul confirmation"
}
```

## Visible Docs

- `trace_retrieve.md`
- `projects.md`
- `tool_docs.md`
- `skills.md`
- `soul.md`
- `edit_files.md`
