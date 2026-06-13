# Contracts

## Tool Surface

Base model-visible tools are:

```text
read
search
edit
apply_patch
bash
trace_retrieve
tool_docs
skills
project_docs
repo_docs
soul
list_project_resources
mcp_registry
```

`socrates_memory` and `project_notes` are no longer model-visible tools.

## Docs Tool Contracts

`tool_docs`:

```ts
{
  operation: "read" | "search"
  area?: "tool_usage"
  path?: string
  query?: string
  searchMode?: "exact_phrase" | "keyword_all" | "keyword_any" | "whole_word" | "regex"
  limit?: number
  offset?: number
  charLimit?: number
}
```

`skills`:

```ts
{
  operation: "list" | "search" | "read"
  scope?: "builtin" | "global" | "project"
  name?: string
  path?: string
  query?: string
  limit?: number
  offset?: number
  charLimit?: number
}
```

`project_docs`:

```ts
{
  operation: "read" | "search" | "edit"
  area: "memory" | "notes"
  query?: string
  editMode?: "append" | "replace"
  oldText?: string
  newText?: string
  text?: string
  charLimit?: number
}
```

`repo_docs` allowlist:

```text
CORE_IDEA.md
REPO_NAVIGATION.md
REPO_RULES.md
CONTRACTS.md
```

## Global Memory Agent Tools

The backend Global Memory Agent uses a separate memory-only registry:

```text
trace_retrieve
projects
tool_docs
skills
soul
edit_files
```

Memory-agent `trace_retrieve` is global. Search accepts `scope: "current_conversation" | "recent_conversations" | "current_project" | "project" | "all_projects"`, plus `projectId`, `projectTitle`, `conversationId`, and `conversationTitle` selectors. Each selector may be one string or a list. Exact ids take precedence over titles; titles take precedence over broad scope; list order is preserved where possible. Broad global searches remember result refs so `operation: "inspect", resultNumber: n` works after search.

`projects`:

```ts
{
  operation: "list_projects" | "list_conversations"
  projectId?: string
  limit?: number
  offset?: number
}
```

`edit_files`:

```ts
{
  target: "identity" | "operating_principles" | "tool_doc" | "skill"
  name?: string
  editMode: "replace" | "create"
  oldText?: string
  newText: string
  rationale?: string
  sourceTurnIds?: string[]
}
```

The memory agent does not receive generic `edit`, `apply_patch`, `bash`, `project_docs`, or `repo_docs`. Project and repo state are reached through `projects` metadata plus global `trace_retrieve`; durable writes are only through scoped `edit_files`.

## Persistence Contracts

- Runtime conversation/tool evidence remains in SQLite and is retrieved through `trace_retrieve`.
- Workspace project memory and notes live in workspace files, not `~/.Socrates/projects/<projectId>/`.
- Global tool usage lives under root `~/.Socrates/tool_usage`.
- Global Memory Agent tool guidance lives under root `~/.Socrates/tool_usage/memory_agent/`.
- Global learned skills live under root `~/.Socrates/skills`.
- Project skills live under workspace `.socrates/skills`.
- `identity.md` and `operating_principles.md` live directly under root `~/.Socrates`.
- Diary is not a production memory surface.
- Terminal protected-path preflight rejects obvious command mentions of workspace memory/repo docs/skills and global skills/tool usage/soul docs before PTY spawn. This is not a process sandbox and does not replace approval UX.

## WebSocket/Worker Contracts

- `memory.agent.completed` has `jobId`, `status`, `modelId`, `actionsApplied`, and `actionsRejected`; it no longer reports `diaryAppended`.
- `memory.diary.appended` is no longer part of the server event union.
- `memory.primary.updated.targetKind` is `tool_usage` or `skills`.
- Soul update confirmation events remain.
- The Global Memory Agent is a specialized core `SocratesAgent` run, not a one-shot provider completion and not a per-turn project worker.
- It receives a manifest of completed-turn events since the durable `events.sequence` watermark, capped for token budget. It can use `trace_retrieve` and `projects` to pull deeper evidence only when useful.
- Planned manifest contract correction: pack manifest entries incrementally and stop when adding the next completed-turn entry would exceed 60k estimated tokens or when 80 completed-turn entries have been included. Watermark advancement must stop at the last included sequence.
- Writes happen during the agent run through `edit_files`; there is no final JSON patch proposal contract.
- Global settings live in `memory_agent_global_settings`; global run state and the event watermark live in `memory_agent_global_state`.
- `GET /api/memory-agent` returns settings, state, and recent runs.
- `PATCH /api/memory-agent/settings` updates enabled/cadence/provider/model/thinking.
- `POST /api/memory-agent/run` triggers a manual global run.
- Completed chat turns are indexed for retrieval but do not enqueue memory jobs directly. Scheduled runs wake from the global settings cadence.

## Context Compression Contracts

- Current compression is not yet a true structured-output contract. It asks for JSON, parses text, and stores snapshots if parsing succeeds.
- This must be replaced with shared schema-backed outputs for Socrates chat compression and Memory Agent compression.
- A snapshot must not become active unless the output validates against the schema and the packed context is recounted under the hard cap.
- Compressor prompts belong in `packages/core/src/prompts/`, not embedded inside runtime compression code.
