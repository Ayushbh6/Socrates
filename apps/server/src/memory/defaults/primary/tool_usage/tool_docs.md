# tool_docs Usage Guide

`tool_docs` reads and searches Socrates tool guidance under `~/.Socrates/tool_usage`.

This tool exposes the root docs in `tool_usage/*.md`.

## Core Principle

Use `tool_docs` when tool behavior, parameters, routing, or failure handling is uncertain.

Do not guess tool semantics when a concise tool doc can answer the question.

## Socrates Scope

Socrates can use `tool_docs` for:

- `trace_retrieve`
- `tool_docs`
- `skills`
- `project_docs`
- `repo_docs`
- `soul`
- workspace read/search guidance
- edit/apply_patch guidance
- terminal guidance

## Common Calls

Read the available Socrates tool docs:

```json
{
  "operation": "read",
  "path": "."
}
```

Read one tool doc:

```json
{
  "operation": "read",
  "path": "project_docs.md"
}
```

Search tool guidance:

```json
{
  "operation": "search",
  "query": "replace oldText",
  "limit": 5
}
```

## When To Use

Use this before acting when:

- A tool has similar-looking modes.
- A project memory or repo-doc edit might be durable.
- A prior retrieval result needs exact inspection.
- A file edit touches Socrates-owned docs.
- A terminal command has safety or approval implications.

Skip it when the tool behavior is obvious and already covered by the prompt.
