# trace_retrieve Usage Guide

`trace_retrieve` is this worker's investigation tool for visible conversation history and persisted runtime evidence across projects.

Use it when a possible memory update depends on what happened in a completed turn: exact user wording, assistant behavior, tool calls, shell output, file operations, patches, errors, or repeated decisions.

This tool is not a file reader, not a generic search engine, and not a writer.

## Core Principle

Search results are leads. Inspected results are evidence.

Do not update global memory from a manifest row, project metadata, summary, count, title, or vague recollection alone.

## What It Can Retrieve

- Visible active or archived conversations across projects.
- User messages and assistant messages.
- Conversation and project provenance.
- Exact messages by returned `messageId`.
- Exact turns by returned `turnId`.
- Stable trace handles returned by search results.
- Tool calls, shell commands, file operations, patches, and errors in `mode: "audit"`.

## Common Calls

Search all projects:

```json
{
  "operation": "search",
  "scope": "all_projects",
  "mode": "combined",
  "query": "avoid opaque ids in memory workflows",
  "limit": 5,
  "charLimit": 12000
}
```

Inspect a result:

```json
{
  "operation": "inspect",
  "resultNumber": 1,
  "charLimit": 16000
}
```

Audit runtime evidence:

```json
{
  "operation": "search",
  "scope": "all_projects",
  "mode": "audit",
  "query": "tool_docs path dot failed",
  "include": ["tool_calls", "errors"],
  "limit": 5
}
```

## Rules

- Use `projects` for metadata orientation when needed.
- Use `trace_retrieve` for proof.
- Prefer titles, quotes, dates, result numbers, and handles over raw opaque ids when possible.
- Use `audit` only for runtime/tool/file/shell/patch/error evidence.
- Inspect before writing with `edit_files`.
