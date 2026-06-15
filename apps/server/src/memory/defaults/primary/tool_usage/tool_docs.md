# tool_docs Usage Guide

`tool_docs` reads and searches Socrates tool guidance under `~/.Socrates/tool_usage`.

This tool exposes the root docs in `tool_usage/*.md`.

## Core Principle

Use `tool_docs` when tool behavior, parameters, routing, or failure handling is uncertain.

Do not guess tool semantics when a concise tool doc can answer the question.

Socrates' memory and docs tools are especially important. If you are unsure whether to read or update `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, or `.socrates/repo_docs/*.md`, read `project_docs.md` or `repo_docs.md` before acting.

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
- You are doing meaningful project/repo work and are unsure how aggressively to use project memory, project notes, or repo docs.

Skip it when the tool behavior is obvious and already covered by the prompt.

## Memory And Docs Guidance

For context continuity, remember this loop:

1. Before meaningful implementation or repo investigation, use `repo_docs` first for relevant repo doctrine. If docs are missing, stale, or conflict with known current state, update them before implementation.
2. After meaningful work, update `project_docs` memory with durable outcomes, decisions, constraints, blockers, and handoff facts.
3. Use `project_docs` notes actively while working to sustain important live state across sessions.

Read these docs directly when needed:

```json
{
  "operation": "read",
  "path": "project_docs.md"
}
```

```json
{
  "operation": "read",
  "path": "repo_docs.md"
}
```
