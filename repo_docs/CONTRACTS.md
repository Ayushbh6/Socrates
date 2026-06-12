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

## Persistence Contracts

- Runtime conversation/tool evidence remains in SQLite and is retrieved through `trace_retrieve`.
- Workspace project memory and notes live in workspace files, not `~/.Socrates/projects/<projectId>/`.
- Global tool usage lives under root `~/.Socrates/tool_usage`.
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
- The background memory worker is a specialized core `SocratesAgent` run, not a one-shot provider completion. It can call `trace_retrieve`, `tool_docs`, `skills`, `project_docs` read/search, `repo_docs` read/search, and `soul`; writes are applied only through validated final patch proposals.
- Each project has `project_memory_agent_settings`: `providerId`, `modelId`, `thinkingEnabled`, `thinkingEffort`, timestamps. New projects default to OpenRouter `xiaomi/mimo-v2.5-pro` with thinking off.
- `PATCH /api/projects/:projectId/memory-agent/settings` updates the project setting. Background memory jobs use that setting exactly for provider/model/thinking.
- Memory jobs are enqueued from completed chat turns and process buffered new turn evidence; startup does not automatically process all historical chats.
