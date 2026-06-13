# projects Usage Guide

`projects` gives the Global Memory Agent metadata-only orientation across visible Socrates projects and conversations. Use it to decide where to run `trace_retrieve`.

This tool is not evidence for a memory edit. It does not return message bodies, assistant responses, tool calls, shell output, file contents, patches, screenshots, or errors.

## Core Principle

Use `projects` to find the right project or conversation. Use `trace_retrieve` to prove what happened.

Project metadata can tell you where to look. It cannot justify a memory change by itself.

## What It Can Return

- Visible non-deleted projects.
- Project names and ids.
- Project descriptions when present.
- Project status.
- Last update and last activity times.
- Conversation and resource counts.
- Primary workspace path when present.
- Visible active or archived conversations for a project.
- Conversation titles, ids, status, update times, and turn counts.

## What It Must Not Do

- It must not be used as proof of a user preference.
- It must not be used as proof of assistant behavior.
- It must not replace `trace_retrieve` for exact wording.
- It must not replace audit retrieval for tool calls, files, shell, patches, or errors.
- It must not cause memory edits from counts, timestamps, or workspace paths alone.

## Mental Model

There are two operations:

1. `list_projects` finds candidate projects.
2. `list_conversations` finds candidate conversations inside one project.

After orientation, call `trace_retrieve` with `projectTitle`, `projectId`, `conversationTitle`, or `conversationId`.

## Input Reference

| Parameter | Meaning | Use When |
| --- | --- | --- |
| `operation` | `list_projects` or `list_conversations` | Select metadata operation. |
| `projectId` | Project id | Required for `list_conversations`. |
| `limit` | Result cap, max 100 | Keep output bounded. |
| `offset` | Skip result count | Page through projects or conversations. |

## list_projects

Use when the manifest references multiple projects, a project title is ambiguous, or a global search needs a narrower target.

```json
{
  "operation": "list_projects",
  "limit": 20
}
```

Returned project fields may include:

- `id`
- `name`
- `description`
- `status`
- `updatedAt`
- `lastActivityAt`
- `conversationCount`
- `resourceCount`
- `workspacePath`

## list_conversations

Use when you have a `projectId` and need recent visible conversation titles or ids.

```json
{
  "operation": "list_conversations",
  "projectId": "proj_...",
  "limit": 20
}
```

Returned conversation fields may include:

- `id`
- `projectId`
- `title`
- `status`
- `updatedAt`
- `turnCount`

## Common Orientation Recipes

### Find the project before global retrieval

1. List projects.
2. Pick the likely project by `name`, `workspacePath`, and `lastActivityAt`.
3. Search with `trace_retrieve` using `projectTitle` when the name is clear.

```json
{
  "operation": "list_projects",
  "limit": 50
}
```

Then:

```json
{
  "operation": "search",
  "scope": "project",
  "projectTitle": "Socrates",
  "mode": "combined",
  "query": "memory agent exact evidence before edits",
  "limit": 5
}
```

### Disambiguate repeated conversation titles

1. List conversations for the project.
2. Compare `title`, `updatedAt`, and `turnCount`.
3. Use `conversationId` only after the metadata makes the title ambiguous.

```json
{
  "operation": "list_conversations",
  "projectId": "proj_...",
  "limit": 50
}
```

Then:

```json
{
  "operation": "search",
  "scope": "project",
  "projectId": "proj_...",
  "conversationId": "conv_...",
  "mode": "exact",
  "query": "oldText matched more than once",
  "limit": 5
}
```

### Browse recent activity before choosing search terms

1. List projects ordered by activity.
2. List conversations in the most relevant project.
3. Use conversation titles as human-readable anchors in `trace_retrieve`.

```json
{
  "operation": "list_projects",
  "limit": 10,
  "offset": 0
}
```

## Good And Bad Uses

Good:

```json
{
  "operation": "list_projects",
  "limit": 20
}
```

Then search exact evidence:

```json
{
  "operation": "search",
  "scope": "project",
  "projectTitle": "AI_DPA",
  "mode": "combined",
  "query": "docs markdown notes should stay private",
  "limit": 5
}
```

Bad:

```text
Project AI_DPA has a workspace path and recent activity, so write a memory saying docs are private.
```

The bad pattern edits from metadata. It must retrieve exact conversation evidence first.

## Output Interpretation

Prefer these fields:

- `name`: human-readable project selector for later retrieval.
- `id`: disambiguation selector for later retrieval.
- `workspacePath`: orientation only; not evidence.
- `lastActivityAt` / `updatedAt`: recency orientation.
- `conversationCount` / `turnCount`: size orientation.
- `title`: human-readable conversation selector.
- `status`: visible active/archive status.
- `totalMatches`: whether paging may be needed.
- `warnings`: must be read and followed.

## Failure Handling

If the project list is too broad:

- Lower `limit` for recent projects.
- Use `offset` to page.
- Prefer project titles from the manifest or user-visible context.

If `list_conversations` fails:

- Confirm `projectId` came from `list_projects` or the manifest.
- Retry only after correcting the id.

If conversation titles repeat:

- Use `updatedAt`, `turnCount`, and `conversationId`.
- Then inspect exact evidence with `trace_retrieve`.

## Checklist Before trace_retrieve

- Do I know whether this is a project-local or cross-project lesson?
- Do I have a project title or id?
- Do I need a conversation title or id to reduce noise?
- Am I treating metadata as orientation only?
- Is the next step exact evidence retrieval?
