# Socrates DB Structure

This document defines the initial SQLite database design for Socrates.

The database is the source of truth for conversations, runtime state, model calls, tool calls, approvals, usage, errors, and replayable event history. The goal is that any single user query can be reconstructed later from the database:

```text
user query
  -> runtime config
  -> model request
  -> model reasoning/answer stream
  -> tool calls
  -> approvals
  -> shell/file/git outputs
  -> errors
  -> final assistant response
  -> token usage and metadata
```

## Local Storage Location

The default Socrates SQLite file is user-owned app data, not repo checkout data:

```text
~/.Socrates/socrates.sqlite
```

The server resolves this path from `SOCRATES_HOME` plus `socrates.sqlite`. `SOCRATES_DB_PATH` remains the explicit override for tests, special development runs, and recovery. The legacy development DB at `app-data/socrates.sqlite` is import-only: on default startup, if the user-owned DB does not exist and no explicit `SOCRATES_DB_PATH` is set, the server copies the legacy DB and any WAL/SHM siblings once, then runs migrations against the user-owned file. `SOCRATES_SKIP_LEGACY_DB_IMPORT=true` disables that one-time import.

## Design Principle

The database should be event-log first.

Structured tables like `messages`, `model_calls`, `tool_calls`, and `errors` make querying easy. The `events` table is the chronological audit log that allows full replay.

```text
events = complete timeline
other tables = indexed structured views of important entities
```

## Entity Hierarchy

```text
user
  project
    project_workspaces
    project_resources
    project_instructions
    conversation
      session
        turn
          messages
          model_calls
          tool_calls
          approvals
          voice_inputs
          audio_outputs
          message_feedback
          errors
          usage_snapshots
          events
```

## Core Concepts

### User

A user is the local profile for the person using Socrates.

Socrates is local-first and single-user in V1, but a `users` table still gives the app a clean place to store display name, onboarding state, and user-level preferences.

### Project

A project is the Socrates metadata container for a real local workspace folder.

The `projects` row is not the folder itself. It stores Socrates UI identity, description, status, history links, and ownership. The real local workspace path lives in `project_workspaces`.

In V1, every active project must have exactly one primary workspace folder. Global unscoped chats should not exist in V1.

### Conversation

A conversation is the full chat thread shown inside a project.

One conversation can have multiple sessions if the user changes workspace/runtime context later.

### Session

A session is the execution context attached to a conversation.

It stores things like workspace path, branch, environment, and status.

Changing model, thinking mode, or approval mode does not require a new session. Those settings belong to the turn runtime config.

### Turn

A turn is one user request and the full agent lifecycle needed to answer it.

Example:

```text
User asks: "Fix the failing tests"
  -> model call
  -> read file tool
  -> shell command approval
  -> npm test
  -> patch
  -> final assistant response
```

All of that is one turn.

### Message

A message is human-visible chat content.

Examples:

- User message.
- Assistant final response.
- Optional assistant visible reasoning summary if exposed and shown as a chat item.

Internal tool events should not be stored only as messages. They belong in `events` and their structured tables.

Voice input, read-aloud output, and feedback should attach to messages through separate tables instead of adding many nullable columns to `messages`.

### Event

An event is any meaningful step in the agent runtime.

Events are append-only and ordered by `sequence` within a session. They are the audit trail.

### Tool And Terminal Audit Data

Tool calls, foreground shell commands, and started conversation Terminals are persisted separately from model-visible prompt history.

`tool_calls`, `shell_commands`, and `shell_output_chunks` store foreground tool and command provenance. `terminal_sessions` and `terminal_output_chunks` store conversation-scoped started Terminals and their full PTY/stdout/stderr chunk history. Model-facing Terminal `status`, `output`, and `stop` calls may return only new output since the last model-visible check, but this cursor is prompt hygiene only; it must not delete or rewrite terminal chunks.

`trace_documents` indexes runtime audit evidence from messages, tool calls, foreground shell commands, detached Terminal sessions, file operations, patches, errors, and compaction summaries. `trace_retrieve mode="audit" include=["shell"]` should find both foreground shell command output and detached Terminal session output through the same shell evidence category.

## Tables

## `users`

Stores the local user profile.

Socrates is single-user in V1, but this table avoids scattering profile and onboarding state across ad hoc settings files.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `user_...`. |
| `display_name` | `TEXT` | yes | What Socrates should call the user. |
| `onboarding_completed` | `INTEGER` | yes | Boolean as `0` or `1`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `onboarded_at` | `TEXT` | no | Set when onboarding completes. |
| `metadata_json` | `TEXT` | no | User-level metadata and future preferences. |

## `projects`

Stores Socrates project metadata.

Projects are the primary organizing unit for Socrates. Conversations, resources, instructions, artifacts, and runtime sessions should belong to a project.

The project display name can differ from the folder name. This lets users keep clean UI names even when local folders have legacy, duplicated, or awkward names.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `proj_...`. |
| `user_id` | `TEXT` | yes | FK to `users.id`. |
| `name` | `TEXT` | yes | Project display name. |
| `description` | `TEXT` | no | Optional project description. |
| `status` | `TEXT` | yes | `active`, `archived`, `deleted`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `archived_at` | `TEXT` | no | Set when archived. |
| `metadata_json` | `TEXT` | no | Project-level metadata. |

## `project_workspaces`

Stores local workspace folders attached to projects.

V1 requires one primary workspace for every active project. The supported creation modes are:

```text
created_folder
existing_folder
```

`none` remains in the enum for migration/recovery/future modes, but normal V1 project creation should not create active projects without a primary workspace path.

When a workspace is created or attached, Socrates creates this project-local scaffold:

```text
<workspace>/.socrates/
<workspace>/.socrates/MEMORY.md
<workspace>/.socrates/PROJECT_NOTES.md
<workspace>/.socrates/resources/
<workspace>/.socrates/repo_docs/
```

The project memory, project notes, and runtime `.socrates/repo_docs/*.md` files are structured markdown documents with Socrates YAML frontmatter and explicit `socrates:section` markers. SQLite stores parsed section indexes for lookup, but markdown remains the durable source of truth. Dedicated docs/memory write paths may stamp optional frontmatter fields `updated_at`, `updated_by`, and `last_edited_section` after successful backend-owned edits. Project notes include active project context and may also include a protected generated `runtime_context` section for compact workspace scan facts; terminal output, live terminal state, dependency dumps, package lists, and root-script inventories must not be persisted there.

Socrates should not edit the workspace root `.gitignore` in V1.

For active V1 projects, `path` must be present on the primary workspace row.

Workspace paths can be changed from the project dashboard. A change must preserve exactly one active primary workspace: mark the old primary row `detached` with `is_primary = 0`, then insert a new `active` row with `is_primary = 1`. Workspace switching is blocked while any turn in the project is queued, running, or awaiting approval.

When attaching a folder that already contains `.socrates`, the backend requires an explicit scaffold action. `use_existing` preserves the directory and ensures `.socrates/resources/` plus missing `.socrates/repo_docs/` templates; `reset` deletes only that selected folder's `.socrates` directory before recreating `.socrates/resources/` and repo-doc templates.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `pws_...`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`. |
| `kind` | `TEXT` | yes | `existing_folder`, `created_folder`, `none`. |
| `path` | `TEXT` | no | Absolute local path. Required for active V1 primary workspaces. |
| `git_repo_root` | `TEXT` | no | Absolute git root if detected. |
| `git_branch` | `TEXT` | no | Current or last known branch. |
| `git_commit` | `TEXT` | no | Current or last known commit hash. |
| `is_primary` | `INTEGER` | yes | Boolean as `0` or `1`; one primary workspace per project. |
| `status` | `TEXT` | yes | `active`, `missing`, `detached`, `archived`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra workspace metadata. |

## `project_resources`

Stores project-level resources.

Resources are reusable context attached to a project, such as PDFs, documents, text notes, images, links, or selected local files.

Uploaded file-backed resources should be stored under the primary workspace scaffold by default:

```text
<primary_workspace>/.socrates/resources/
```

Direct files manually copied into `<primary_workspace>/.socrates/resources/` are treated as Socrates-owned project resources after resource-list sync. The sync creates or reactivates `project_resources` rows plus file artifacts for direct files in that folder and hides uploaded resource rows when their underlying file is removed manually.

The `uri` column should point to the stored resource path or linked source, depending on `source`.

Chat composer image attachments are separate from project resources. They live under `<primary_workspace>/.socrates/attachments/` and are tracked by `message_attachments`, not `project_resources`, so screenshots sent in chat do not appear in the dashboard Resources panel.

When the primary workspace changes, active uploaded resources whose `uri` points inside the old primary workspace `.socrates/resources/` directory should be copied into the new primary workspace `.socrates/resources/`, with `project_resources.uri` and the artifact path updated to the copied file. Linked or external resource paths are not copied or rewritten.

Resource removal is a soft delete in SQLite: set `project_resources.status = "deleted"` and exclude those rows from normal project/resource responses. For uploaded resources whose `uri` points inside the owning primary workspace `.socrates/resources/` directory, the backend should also delete the copied file. Linked or external paths must not be physically deleted.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `pres_...`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`. |
| `artifact_id` | `TEXT` | no | FK to `artifacts.id` if file-backed. |
| `name` | `TEXT` | yes | Display name. |
| `kind` | `TEXT` | yes | `pdf`, `document`, `text`, `image`, `url`, `local_file`, `note`, `other`. |
| `source` | `TEXT` | yes | `uploaded`, `linked_file`, `created_note`, `url`, `generated`. |
| `uri` | `TEXT` | no | URL or local path reference when applicable. |
| `status` | `TEXT` | yes | `active`, `processing`, `failed`, `archived`, `deleted`. |
| `error_id` | `TEXT` | no | FK to `errors.id` if processing failed. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extraction/indexing metadata, tags, etc. |

## `project_instructions`

Stores persistent project instructions.

These are the project-scoped guidance that should be included when building context for conversations in the project.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `pins_...`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`. |
| `title` | `TEXT` | no | Optional instruction title. |
| `content` | `TEXT` | yes | Instruction text. |
| `status` | `TEXT` | yes | `active`, `archived`, `deleted`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra instruction metadata. |

## `conversations`

Stores project-scoped chat threads.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `conv_...`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`. |
| `user_id` | `TEXT` | yes | FK to `users.id`, denormalized for easier queries. |
| `title` | `TEXT` | no | Display title for sidebar. |
| `status` | `TEXT` | yes | `active`, `archived`, `deleted`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `archived_at` | `TEXT` | no | Set when archived. |
| `metadata_json` | `TEXT` | no | JSON for future non-critical metadata. |

V1 conversation creation behavior:

```text
create conversations row
title defaults to "New conversation"
do not create a session until the first user message is sent
```

V1 title behavior:

```text
first user message only
  -> if title is still "New conversation"
  -> derive title from the first word of the message
  -> truncate first word to 10 characters plus "..." when needed
```

Manual rename updates `conversations.title` and `conversations.updated_at`.

V1 delete behavior:

```text
conversation delete is a hard delete
do not set conversations.status = "deleted"
do not archive the conversation
```

Because the current schema does not rely on database-level `ON DELETE CASCADE`, the backend store must delete conversation-scoped rows in an explicit transaction before deleting the `conversations` row.

Conversation deletion should remove rows tied to the conversation, including:

- `messages`
- `sessions`
- `turns`
- `events`
- `turn_runtime_configs`
- `model_calls`
- `model_stream_chunks`
- `model_usage`
- `context_usage_snapshots`
- `tool_calls`
- `approvals`
- `shell_commands`
- `shell_output_chunks`
- `terminal_sessions`
- `terminal_output_chunks`
- `file_operations`
- `patches`
- `artifacts` when the artifact is conversation-scoped
- `message_feedback`
- `voice_inputs`
- `audio_outputs`
- `errors`
- `trace_documents`
- `trace_documents_fts`
- `trace_embeddings`
- `trace_index_jobs`

Conversation deletion must not delete the owning project, project instructions, project resources, or workspace files outside conversation-scoped artifacts. Chat attachment image files under `.socrates/attachments` remain on disk even when their conversation row is hard-deleted.

## `sessions`

Stores runtime/workspace execution contexts.

Sessions are created lazily. Opening a new empty conversation should not create a session. The first user message creates or reuses the active session for that conversation.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `sess_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`, denormalized for easier queries. |
| `project_workspace_id` | `TEXT` | no | FK to `project_workspaces.id` when a workspace is attached. |
| `workspace_path` | `TEXT` | no | Absolute path to active workspace/repo if available. |
| `workspace_name` | `TEXT` | no | Friendly display name. |
| `git_repo_root` | `TEXT` | no | Absolute git root if detected. |
| `git_branch` | `TEXT` | no | Current branch at session start or latest known branch. |
| `git_commit` | `TEXT` | no | Current commit hash at session start or latest known commit. |
| `status` | `TEXT` | yes | `active`, `idle`, `running`, `failed`, `closed`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `closed_at` | `TEXT` | no | Set when session closes. |
| `metadata_json` | `TEXT` | no | Runtime metadata not worth first-class columns yet. |

## `turns`

Stores one user request lifecycle.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `turn_...`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`, denormalized for easier queries. |
| `user_message_id` | `TEXT` | no | FK to `messages.id` for the user message that started the turn. |
| `assistant_message_id` | `TEXT` | no | FK to final assistant message if completed. |
| `status` | `TEXT` | yes | `queued`, `running`, `awaiting_approval`, `completed`, `failed`, `cancelled`. |
| `started_at` | `TEXT` | yes | ISO timestamp. |
| `completed_at` | `TEXT` | no | Set when completed. |
| `failed_at` | `TEXT` | no | Set when failed. |
| `cancelled_at` | `TEXT` | no | Set when cancelled. |
| `error_id` | `TEXT` | no | FK to `errors.id` for terminal failure. |
| `metadata_json` | `TEXT` | no | Extra turn-level metadata. |

## `turn_runtime_configs`

Stores the exact model, thinking, approval, sandbox, and generation settings used for a turn.

This is what allows one conversation/session to freely switch models, thinking mode, and approval mode between user queries.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `trc_...`. |
| `turn_id` | `TEXT` | yes | FK to `turns.id`, usually one config per turn. |
| `provider_id` | `TEXT` | yes | `openai`, `anthropic`, `google`, `openrouter`, `ollama`, `litellm`, etc. |
| `auth_mode` | `TEXT` | yes | Provider auth source, defaulting to `api_key`; `chatgpt_subscription` is the experimental OpenAI ChatGPT Codex mode. |
| `model_id` | `TEXT` | yes | Provider model id. |
| `thinking_enabled` | `INTEGER` | yes | Boolean as `0` or `1`. |
| `thinking_effort` | `TEXT` | no | `none`, `low`, `medium`, `high`, `xhigh`, or provider-specific mapped value. |
| `approval_mode` | `TEXT` | yes | `manual`, `approve_all`, `read_only_auto`, etc. |
| `sandbox_mode` | `TEXT` | yes | `read_only`, `workspace_write`, `danger_full_access`, etc. |
| `temperature` | `REAL` | no | Generation temperature. |
| `max_output_tokens` | `INTEGER` | no | Max output token limit sent to provider. |
| `context_window_tokens` | `INTEGER` | no | Known model context window size at call time. |
| `tool_policy_json` | `TEXT` | no | JSON describing enabled tools and permissions. |
| `provider_options_json` | `TEXT` | no | Provider-specific options. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

## `messages`

Stores human-visible chat messages.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `msg_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | no | FK to `turns.id`; null for system/session messages if needed. |
| `role` | `TEXT` | yes | `system`, `user`, `assistant`, `tool`, `developer`. |
| `content` | `TEXT` | yes | Visible message text. |
| `content_format` | `TEXT` | yes | `text`, `markdown`, `json`, etc. |
| `status` | `TEXT` | yes | `streaming`, `completed`, `failed`, `cancelled`. |
| `parent_message_id` | `TEXT` | no | Optional FK to previous message. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `completed_at` | `TEXT` | no | Set when streaming completes. |
| `metadata_json` | `TEXT` | no | Message metadata. Completed assistant messages may store `reasoning`. Cancelled partial assistant messages store `partial: true`, `cancelled: true`, and optional `cancellationReason`. |

If a turn is running, failed, or cancelled and has streamed chunks but no completed assistant `messages` row, the HTTP conversation load can recover a `partialTurns` view from `model_stream_chunks`. That recovery is response data, not a fake message row. The `messages` table remains for real visible user/assistant messages and persisted cancelled partial assistant messages. On backend startup, stale active turns from a previous app/process close are reconciled as cancelled/stopped, using any persisted stream chunks as partial assistant text when available.

## `events`

Stores the complete chronological audit trail.

This table is append-only except for rare maintenance/migration work.

Live chat resilience depends on this table. WebSocket turn events are persisted before broadcast, and `chat.conversation.subscribe` can replay the stored active-turn events to a newly connected socket after refresh, route navigation, or reconnect.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `evt_...`. |
| `project_id` | `TEXT` | no | FK to `projects.id` when event belongs to a project. |
| `conversation_id` | `TEXT` | no | FK to `conversations.id` when event belongs to a conversation. |
| `session_id` | `TEXT` | no | FK to `sessions.id` when event belongs to a session. |
| `turn_id` | `TEXT` | no | FK to `turns.id` when event belongs to a turn. |
| `sequence` | `INTEGER` | yes | Strictly increasing global event sequence. |
| `type` | `TEXT` | yes | Stable event name like `agent.answer.delta`. |
| `source` | `TEXT` | yes | `web`, `server`, `core`, `provider`, `workspace`, `tool`, `system`. |
| `payload_json` | `TEXT` | yes | Event payload JSON matching `packages/contracts`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

Suggested indexes:

```sql
CREATE UNIQUE INDEX events_sequence_idx ON events(sequence);
CREATE INDEX events_session_sequence_idx ON events(session_id, sequence);
CREATE INDEX events_project_sequence_idx ON events(project_id, sequence);
CREATE INDEX events_turn_sequence_idx ON events(turn_id, sequence);
CREATE INDEX events_type_idx ON events(type);
```

## `model_calls`

Stores each call to a model provider.

A single turn can contain multiple model calls.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `mcall_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | yes | FK to `turns.id`. |
| `runtime_config_id` | `TEXT` | no | FK to `turn_runtime_configs.id`. |
| `provider_id` | `TEXT` | yes | Provider used for this call. |
| `model_id` | `TEXT` | yes | Model used for this call. |
| `status` | `TEXT` | yes | `started`, `streaming`, `completed`, `failed`, `cancelled`. |
| `request_json` | `TEXT` | yes | Full normalized request sent through `ModelProvider`. Current requests include `estimatedTokens` and `contextBudgetTokens` for compatibility, populated from provider-aware context counting, plus token-count metadata such as method, base count, safety margin, exact-count attempt status, and warnings. |
| `provider_request_json` | `TEXT` | no | Provider-specific request payload if captured. |
| `response_json` | `TEXT` | no | Final normalized response summary. |
| `provider_response_json` | `TEXT` | no | Provider-specific final response if captured. |
| `error_id` | `TEXT` | no | FK to `errors.id`. |
| `started_at` | `TEXT` | yes | ISO timestamp. |
| `completed_at` | `TEXT` | no | Set when completed. |
| `metadata_json` | `TEXT` | no | Provider metadata. |

## `model_stream_chunks`

Stores streamed model output chunks when exact stream replay is needed.

The `events` table also records stream deltas. This table gives a query-friendly view grouped by model call.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `chunk_...`. |
| `model_call_id` | `TEXT` | yes | FK to `model_calls.id`. |
| `turn_id` | `TEXT` | yes | FK to `turns.id`. |
| `sequence` | `INTEGER` | yes | Strictly increasing per model call. |
| `channel` | `TEXT` | yes | `reasoning`, `reasoning_summary`, `answer`, `tool_call`, `metadata`. |
| `text` | `TEXT` | no | Text delta when the chunk is textual. |
| `payload_json` | `TEXT` | no | JSON payload for non-text chunks. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

## `model_usage`

Stores token usage and cost for model calls.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `usage_...`. |
| `model_call_id` | `TEXT` | yes | FK to `model_calls.id`. |
| `turn_id` | `TEXT` | yes | FK to `turns.id`. |
| `provider_id` | `TEXT` | yes | Provider id. |
| `model_id` | `TEXT` | yes | Model id. |
| `input_tokens` | `INTEGER` | no | Prompt/input tokens. |
| `output_tokens` | `INTEGER` | no | Visible answer output tokens. |
| `reasoning_tokens` | `INTEGER` | no | Reasoning/thinking tokens if provider reports them. |
| `cached_input_tokens` | `INTEGER` | no | Cached input tokens if provider reports them. |
| `cache_write_tokens` | `INTEGER` | no | Cache-write tokens when provider reports or normalizes them. |
| `uncached_input_tokens` | `INTEGER` | no | Input tokens not served from cache when derivable. |
| `tool_call_tokens` | `INTEGER` | no | Tool-call-related tokens if separately reported. |
| `total_tokens` | `INTEGER` | no | Total tokens reported or calculated. |
| `cost_usd` | `REAL` | no | Estimated or provider-reported cost. |
| `cost_source` | `TEXT` | no | `provider_reported`, `computed`, or `unknown`. |
| `routed_provider` | `TEXT` | no | Upstream endpoint that actually served the request. For OpenRouter this is the routed provider; for direct providers it is the provider id. |
| `pricing_snapshot_json` | `TEXT` | no | Versioned pricing snapshot for computed costs. |
| `raw_usage_json` | `TEXT` | no | Raw usage object from provider. |
| `metadata_json` | `TEXT` | no | Provider usage metadata, for example OpenRouter routed provider and provider usage fields. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

## `ai_usage_events`

Canonical append/update ledger for billable AI work tied to a visible turn. Rows use `source_kind` (`main_model_call`, `context_compaction`, `conversation_title`, or `memory_router`) plus `source_id` to connect model calls, compaction snapshots, title generation, and structured memory-router calls to provider/model/status, token totals, cache read/write tokens, `cost_usd`, `cost_source`, `routed_provider`, `pricing_snapshot_json`, raw provider usage metadata, and provider metadata.

## `turn_usage_reports`

Materialized completed-turn cost/cache report keyed by `turn_id`. Stores cumulative token/cache/cost totals plus provider/model/call/compaction breakdown JSON and quality flags such as computed or unknown cost sources. `model_usage` remains compatibility storage; UI/API cost reporting should use `turn_usage_reports` and `ai_usage_events`.

## `context_usage_snapshots`

Stores live context-window usage snapshots for the UI.

This supports context accounting around provider requests. The current chat header shows only the latest used count, such as `23,433 tokens`; richer remaining/percent widgets can be added later.

`context_used_tokens` is the safety count used for model-facing context budgeting. It is counted from the assembled provider-call payload, including system prompt, visible messages, hidden compaction summaries, current-turn tool calls/results, and tool definitions/schemas. Provider-exact counts may be used near thresholds when available; local/fallback tokenizer counts include the configured safety margin.

`context_window_tokens` should represent the effective Socrates prompt budget at that call, capped by the context-compression hard cap even when the selected model advertises a larger provider context window. When no snapshot exists for an older turn, the server may estimate latest context usage from the most recent `model_calls.request_json`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `ctxuse_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | no | FK to `turns.id` if snapshot belongs to a turn. |
| `model_call_id` | `TEXT` | no | FK to `model_calls.id` if tied to a model call. |
| `provider_id` | `TEXT` | yes | Provider id. |
| `model_id` | `TEXT` | yes | Model id. |
| `context_window_tokens` | `INTEGER` | yes | Total available context window. |
| `context_used_tokens` | `INTEGER` | yes | Tokens used at snapshot time. |
| `context_left_tokens` | `INTEGER` | yes | Tokens remaining at snapshot time. |
| `context_used_percent` | `REAL` | yes | Percent used, e.g. `21.3`. |
| `compaction_status` | `TEXT` | no | `not_needed`, `recommended`, `required`, `compacted`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra context accounting metadata. |

## `context_compaction_snapshots`

Stores append-only hidden context compaction snapshots.

Compaction snapshots are runtime context, not transcript content. They summarize older same-conversation history, bulky current-turn evidence, decisions, failures, and handles, while raw messages/tools/events remain the source of truth.

Exactly one completed snapshot per conversation may be marked active/latest through `active = 1`; older snapshots remain for audit and chain provenance through `previous_snapshot_id`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `ctxcmp_...`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | no | FK to `turns.id` when the snapshot was produced during or after a turn. |
| `previous_snapshot_id` | `TEXT` | no | Previous snapshot in the compaction chain. |
| `status` | `TEXT` | yes | `running`, `completed`, `no_op`, or `failed`. |
| `active` | `INTEGER` | yes | Boolean. True only for the latest completed snapshot for a conversation. |
| `reason` | `TEXT` | yes | `precompute`, `threshold`, `emergency`, or `manual`. |
| `source_message_ids_json` | `TEXT` | yes | JSON ids for source messages included in the snapshot input. |
| `source_turn_ids_json` | `TEXT` | yes | JSON ids for source turns included in the snapshot input. |
| `summary_json` | `TEXT` | no | Structured compressor output. |
| `rendered_summary` | `TEXT` | no | Hidden context block rendered from `summary_json`. |
| `source_handles_json` | `TEXT` | no | JSON inspect/search handles for exact `trace_retrieve` fallback. |
| `input_tokens_estimate` | `INTEGER` | no | Estimated input tokens sent to compression. |
| `output_tokens_estimate` | `INTEGER` | no | Estimated compressor output tokens. |
| `context_tokens_before` | `INTEGER` | yes | Estimated context tokens before compaction. |
| `context_tokens_after` | `INTEGER` | no | Estimated context tokens after compaction. |
| `target_tokens` | `INTEGER` | yes | Target packed-context token count. |
| `compressor_provider_id` | `TEXT` | yes | Provider used for the compressor call. |
| `compressor_model_id` | `TEXT` | yes | Model used for the compressor call. |
| `usage_json` | `TEXT` | no | Compressor usage metrics, separate from normal answer usage. |
| `error_id` | `TEXT` | no | FK to `errors.id` when failed. |
| `started_at` | `TEXT` | yes | ISO timestamp. |
| `completed_at` | `TEXT` | no | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra compaction metadata. |

## `tool_calls`

Stores each agent tool call.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `tcall_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | yes | FK to `turns.id`. |
| `model_call_id` | `TEXT` | no | FK to model call that requested the tool. |
| `tool_name` | `TEXT` | yes | Stable tool name. |
| `status` | `TEXT` | yes | `requested`, `awaiting_approval`, `running`, `completed`, `failed`, `cancelled`, `rejected`. |
| `arguments_json` | `TEXT` | yes | Validated tool arguments. |
| `result_json` | `TEXT` | no | Tool result if completed. |
| `error_id` | `TEXT` | no | FK to `errors.id`. |
| `requires_approval` | `INTEGER` | yes | Boolean as `0` or `1`. |
| `approval_id` | `TEXT` | no | FK to `approvals.id` if approval was needed. |
| `started_at` | `TEXT` | no | ISO timestamp. |
| `completed_at` | `TEXT` | no | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra tool metadata. |

## `approvals`

Stores user approval requests and decisions.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `appr_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | yes | FK to `turns.id`. |
| `tool_call_id` | `TEXT` | no | FK to `tool_calls.id`. |
| `status` | `TEXT` | yes | `requested`, `approved`, `rejected`, `expired`, `cancelled`. |
| `action_kind` | `TEXT` | yes | `shell_command`, `file_write`, `patch_apply`, `git_commit`, etc. |
| `action_json` | `TEXT` | yes | Full action payload shown to user. |
| `decision` | `TEXT` | no | `approved`, `rejected`. |
| `decided_by` | `TEXT` | no | User id or local user marker. |
| `requested_at` | `TEXT` | yes | ISO timestamp. |
| `decided_at` | `TEXT` | no | ISO timestamp. |
| `expires_at` | `TEXT` | no | Optional expiry. |
| `metadata_json` | `TEXT` | no | Extra approval metadata. |

## `shell_commands`

Stores shell command executions.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `sh_...`. |
| `tool_call_id` | `TEXT` | yes | FK to `tool_calls.id`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | yes | FK to `turns.id`. |
| `command` | `TEXT` | yes | Command string. |
| `cwd` | `TEXT` | yes | Working directory. |
| `status` | `TEXT` | yes | `queued`, `running`, `exited`, `failed`, `cancelled`. |
| `exit_code` | `INTEGER` | no | Process exit code. |
| `signal` | `TEXT` | no | Termination signal if any. |
| `started_at` | `TEXT` | yes | ISO timestamp. |
| `completed_at` | `TEXT` | no | ISO timestamp. |
| `duration_ms` | `INTEGER` | no | Runtime duration. |
| `metadata_json` | `TEXT` | no | Extra shell/process metadata, including operation, platform, shell kind, shell executable, process id/status, terminal id/name/status, and next output sequence when present. |

## `shell_output_chunks`

Stores stdout/stderr chunks for shell commands.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `shout_...`. |
| `shell_command_id` | `TEXT` | yes | FK to `shell_commands.id`. |
| `sequence` | `INTEGER` | yes | Strictly increasing per shell command. |
| `stream` | `TEXT` | yes | `stdout` or `stderr`. |
| `text` | `TEXT` | yes | Output chunk text. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

## `terminal_sessions`

Stores conversation-scoped Terminal sessions started through the model-visible `bash` tool or auto-detached from a long blocking `bash run`.

Terminal sessions are durable conversation runtime state. A Terminal may outlive a single turn, but it is still scoped to one project, one conversation, and one workspace path. On server restart, rows that were `running` or `awaiting_input` are reconciled with the local Terminal supervisor when possible; uncontrollable rows become `detached` or `missing`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `term_...`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `workspace_path` | `TEXT` | yes | Workspace path used when the Terminal was started. |
| `name` | `TEXT` | yes | User/model-facing terminal name. |
| `command` | `TEXT` | yes | Original command string. |
| `cwd` | `TEXT` | yes | Last known working directory. |
| `status` | `TEXT` | yes | `running`, `exited`, `stopped`, `detached`, `awaiting_input`, `missing`, or legacy `stale`. |
| `platform` | `TEXT` | no | Runtime platform such as `darwin`, `linux`, or `win32`. |
| `shell_kind` | `TEXT` | no | `posix`, `powershell`, or `cmd`. |
| `shell_executable` | `TEXT` | no | Resolved shell executable. |
| `process_id` | `TEXT` | no | Runtime process handle id from the workspace shell session. |
| `exit_code` | `INTEGER` | no | Process exit code when known. |
| `signal` | `TEXT` | no | Termination signal when known. |
| `auto_detached` | `INTEGER` | yes | Boolean as `0` or `1`; true when detached from a long blocking `run`. |
| `awaiting_input` | `INTEGER` | yes | Boolean as `0` or `1`; true when conservative prompt detection surfaced user-only stdin. |
| `last_prompt` | `TEXT` | no | Safe prompt text for awaiting-input UI/model context. Secret-like input itself is never stored here. |
| `started_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `completed_at` | `TEXT` | no | ISO timestamp for exited, stopped, detached, missing, or legacy stale completion. |
| `metadata_json` | `TEXT` | no | Extra terminal metadata such as linked tool call id or stop reason. |

## `terminal_output_chunks`

Stores full Terminal output, including raw PTY replay chunks, and redacted user-input markers independently from per-tool shell command output.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `tout_...`. |
| `terminal_session_id` | `TEXT` | yes | FK to `terminal_sessions.id`. |
| `sequence` | `INTEGER` | yes | Strictly increasing per terminal session. |
| `stream` | `TEXT` | yes | Output stream label. Terminal v3 uses `pty` for raw replay chunks; legacy/summary streams include `stdout`, `stderr`, `log`, `result`, and redacted `input`. |
| `text` | `TEXT` | yes | Output chunk text. PTY output is persisted for bounded xterm replay. User stdin is persisted only as redacted marker text. |
| `redacted` | `INTEGER` | yes | Boolean as `0` or `1`; true for user-only stdin markers or other redacted terminal entries. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

## `file_operations`

Stores file reads, writes, deletes, moves, and patch-related file operations.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `fop_...`. |
| `tool_call_id` | `TEXT` | no | FK to `tool_calls.id`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | yes | FK to `turns.id`. |
| `operation` | `TEXT` | yes | `read`, `write`, `delete`, `move`, `apply_patch`. |
| `path` | `TEXT` | yes | File path. |
| `old_path` | `TEXT` | no | Previous path for moves/renames. |
| `content_hash_before` | `TEXT` | no | Hash before write/delete/patch. |
| `content_hash_after` | `TEXT` | no | Hash after write/patch. |
| `status` | `TEXT` | yes | `started`, `completed`, `failed`, `cancelled`. |
| `error_id` | `TEXT` | no | FK to `errors.id`. |
| `started_at` | `TEXT` | yes | ISO timestamp. |
| `completed_at` | `TEXT` | no | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra file operation metadata. |

Verified `edit` and `apply_patch` operations store full-file hashes in `content_hash_before` and `content_hash_after`. `metadata_json` may include read-back verification state, before/after byte sizes, and line delta. Mutation tools must not persist a successful completed file operation unless the disk read-back matched the planned content. File freshness for `edit` is harness-tracked from prior `read` results in the active turn, not from model-carried hashes in tool input JSON.

## `patches`

Stores proposed and applied patches.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `patch_...`. |
| `tool_call_id` | `TEXT` | no | FK to `tool_calls.id`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | yes | FK to `turns.id`. |
| `status` | `TEXT` | yes | `proposed`, `approved`, `applied`, `rejected`, `failed`. |
| `diff_text` | `TEXT` | yes | Unified diff or patch text. |
| `files_json` | `TEXT` | no | JSON list of affected files. |
| `approval_id` | `TEXT` | no | FK to `approvals.id` if approval was needed. |
| `error_id` | `TEXT` | no | FK to `errors.id`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `applied_at` | `TEXT` | no | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra patch metadata. |

## `memory_agent_global_settings`

Stores the single global Memory Agent model/cadence configuration used by scheduled and manual memory-agent runs.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key; current runtime uses the singleton id `global`. |
| `provider_id` | `TEXT` | yes | Provider id from the credential-aware model registry. |
| `auth_mode` | `TEXT` | yes | Provider auth source, defaulting to `api_key`; `chatgpt_subscription` is valid only for OpenAI ChatGPT Codex. |
| `model_id` | `TEXT` | yes | Provider model id. |
| `thinking_enabled` | `INTEGER` | yes | Boolean stored as 0/1. |
| `thinking_effort` | `TEXT` | no | Optional thinking effort when enabled/supported. |
| `enabled` | `INTEGER` | yes | Boolean stored as 0/1. |
| `cadence_minutes` | `INTEGER` | yes | Scheduler cadence in minutes. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Reserved for future memory-agent model metadata. |

## `memory_agent_jobs`

Stores each backend Global Memory Agent batch. Scheduled and manual runs inspect completed-turn evidence after the durable watermark, run only when cumulative signal thresholds are met, and pack manifest entries up to 80 turns or the 60k estimated-token cap.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `memjob_...`. |
| `project_id` | `TEXT` | yes | Project whose memory is being updated. |
| `conversation_id` | `TEXT` | no | Representative/latest conversation id for the batch. |
| `session_id` | `TEXT` | no | Representative/latest session id for the batch. |
| `turn_id` | `TEXT` | no | Representative/latest turn id for the batch. |
| `status` | `TEXT` | yes | `running`, `completed`, `no_op`, or `failed`. |
| `trigger` | `TEXT` | yes | Why the batch ran, such as `buffer_limit` or `idle`. |
| `provider_id` | `TEXT` | yes | Provider used for the memory-agent call. |
| `model_id` | `TEXT` | yes | Model used, including fallback when fallback succeeded. |
| `fallback_model_ids_json` | `TEXT` | no | Ordered fallback model ids considered for the job. |
| `evidence_turn_ids_json` | `TEXT` | yes | Turn ids included in the sanitized evidence batch. |
| `evidence_tokens_estimate` | `INTEGER` | yes | Estimated input evidence tokens. |
| `output_json` | `TEXT` | no | Parsed strict JSON memory-agent output when available. |
| `error_id` | `TEXT` | no | FK to `errors.id` when failed. |
| `started_at` | `TEXT` | yes | ISO timestamp. |
| `completed_at` | `TEXT` | no | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Batch metadata, model attempts, and truncation notes. |

## `memory_notes`

Stores Socrates-to-Memory-Agent notepad leads. The model-facing create contract stays small (`note`, optional `importance`); source refs, source project/workspace metadata, and the default project-local skill-scope hint are backend-attached lookup values so the Memory Agent can chain into `trace_retrieve`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `memnote_...`. |
| `note_number` | `INTEGER` | yes | Human-facing inbox number for list/read/mark_done. |
| `status` | `TEXT` | yes | `open`, `processing`, `done`, or `dismissed`. |
| `priority` | `TEXT` | yes | Compatibility storage for note importance; runtime uses `normal` or `high`. |
| `intent` | `TEXT` | yes | Compatibility storage; Socrates no longer authors intent and new rows use a fixed internal review intent. |
| `note` | `TEXT` | yes | Human note written by Socrates or another sending agent. |
| `project_id` | `TEXT` | no | Source project when the note came from a project conversation. |
| `conversation_id` | `TEXT` | no | Backend-attached source conversation id. |
| `turn_id` | `TEXT` | no | Backend-attached source turn id. |
| `message_id` | `TEXT` | no | Backend-attached current user message id. |
| `message_excerpt` | `TEXT` | no | Bounded source user-message excerpt returned by `memory_notes.read`. |
| `resolution` | `TEXT` | no | One-line Memory Agent closure reason recorded by `memory_notes.mark_done`, such as the profile section updated, skill proposal created, or why the note was skipped. |
| `created_by_agent` | `TEXT` | yes | Sending agent id, usually `socrates`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `claimed_at` | `TEXT` | no | ISO timestamp when a Memory Agent run starts processing it. |
| `completed_at` | `TEXT` | no | ISO timestamp when marked done/dismissed. |
| `metadata_json` | `TEXT` | no | Extra backend refs, `attachedSource`, `defaultSkillScope`, source project name, workspace path, trace lookup hints, and processing notes. |

## `worker_model_settings`

Stores user-configurable model choices for background workers that do not have a dedicated chat-side picker.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `wms_...`. |
| `worker_id` | `TEXT` | yes | Unique worker role: `skill_writer`, `context_compactor`, `title_generator`, or `memory_router`. |
| `provider_id` | `TEXT` | yes | Provider id from the normal model registry. |
| `auth_mode` | `TEXT` | yes | Provider auth source, defaulting to `api_key`; `chatgpt_subscription` is valid only for OpenAI ChatGPT Codex worker selections. |
| `model_id` | `TEXT` | yes | Provider model id from the normal model registry. |
| `thinking_enabled` | `INTEGER` | yes | Boolean stored as 0/1. |
| `thinking_effort` | `TEXT` | no | Optional thinking effort when enabled/supported. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Reserved for future worker-model metadata. |

## `memory_agent_actions`

Stores each proposed, applied, or rejected memory edit or skill-freshness request produced by a memory-agent job.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `memact_...`. |
| `job_id` | `TEXT` | yes | FK to `memory_agent_jobs.id`. |
| `project_id` | `TEXT` | yes | Owning project scope. |
| `turn_id` | `TEXT` | no | Source/representative turn for the action. |
| `target_kind` | `TEXT` | yes | `user_profile`, `soul`, or `skill_request`. Tool docs remain read-only for models. |
| `target_path` | `TEXT` | no | Memory file path being changed, or target skill path/id after a Skill Writer Agent task is created. |
| `status` | `TEXT` | yes | `proposed`, `awaiting_confirmation`, `applied`, or `rejected`. |
| `requires_confirmation` | `INTEGER` | yes | Boolean; true for soul patches. |
| `confirmation_id` | `TEXT` | no | FK to `memory_agent_confirmations.id`. |
| `before_hash` | `TEXT` | no | SHA-256 hash before patch application. |
| `after_hash` | `TEXT` | no | SHA-256 hash after patch application. |
| `patch_json` | `TEXT` | yes | Backend-controlled patch proposal or approved skill task with expected hash, old text, new text, rationale, and source turn ids when applicable. |
| `rationale` | `TEXT` | no | Concise evidence-backed rationale. |
| `error` | `TEXT` | no | Rejection/failure reason. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `applied_at` | `TEXT` | no | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra validation and confirmation metadata. |

## `memory_agent_confirmations`

Stores the internal second-call confirmation flow for soul edits.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `memconf_...`. |
| `job_id` | `TEXT` | yes | FK to `memory_agent_jobs.id`. |
| `action_id` | `TEXT` | yes | FK to `memory_agent_actions.id`. |
| `project_id` | `TEXT` | yes | Project that triggered the proposal. |
| `document` | `TEXT` | yes | `identity`. |
| `prompt_text` | `TEXT` | yes | Exact confirmation prompt shown to the model. |
| `response_text` | `TEXT` | no | Raw model response. |
| `decision` | `TEXT` | no | `yes`, `no`, or `invalid`; only `yes` applies. |
| `provider_id` | `TEXT` | yes | Provider used for confirmation. |
| `model_id` | `TEXT` | yes | Model used for confirmation. |
| `requested_at` | `TEXT` | yes | ISO timestamp. |
| `decided_at` | `TEXT` | no | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Confirmation metadata and normalized decision details. |

## `memory_doc_indexes`

Stores the latest parsed index row for each structured Socrates memory document. The markdown file is still the source of truth; this table is a rebuilt lookup/cache surface.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `mdoc_...`. |
| `scope` | `TEXT` | yes | `workspace` or `global`. |
| `project_id` | `TEXT` | yes | Workspace project id, or `global` for global docs. |
| `path` | `TEXT` | yes | Runtime doc path, such as `.socrates/MEMORY.md` or `tool_usage/read_search.md`. |
| `doc_type` | `TEXT` | yes | Structured doc type such as `project_memory`, `repo_rules`, `user_profile`, or `tool_doc`. |
| `owner_tool` | `TEXT` | yes | Dedicated tool that owns mutation: `project_docs`, `repo_docs`, `tool_docs`, `soul`, `user_profile`, or `skills`. |
| `schema_version` | `INTEGER` | yes | Memory-doc schema version from YAML frontmatter. |
| `content_hash` | `TEXT` | yes | SHA-256 of the full markdown document. |
| `section_count` | `INTEGER` | yes | Number of parsed `socrates:section` blocks. |
| `indexed_at` | `TEXT` | yes | ISO timestamp when this index row was rebuilt. |
| `metadata_json` | `TEXT` | no | Parser warnings and future index metadata. |

Unique index: `scope + project_id + path`.

## `memory_doc_sections`

Stores parsed section rows for structured Socrates memory documents.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `mdsec_...`. |
| `doc_index_id` | `TEXT` | yes | FK to `memory_doc_indexes.id`, cascade deleted on reindex. |
| `scope` | `TEXT` | yes | Copied from the parent index for lookup. |
| `project_id` | `TEXT` | yes | Copied from the parent index for lookup. |
| `path` | `TEXT` | yes | Runtime doc path. |
| `doc_type` | `TEXT` | yes | Parent doc type. |
| `section_id` | `TEXT` | yes | Stable section id, such as `handoff`, `hard_rules`, or `stable_preferences`. |
| `kind` | `TEXT` | yes | Section category used for routing and display. |
| `tags_json` | `TEXT` | yes | JSON array of section tags. |
| `heading` | `TEXT` | yes | First markdown heading inside the section. |
| `line_start` | `INTEGER` | yes | 1-based opening marker line. |
| `line_end` | `INTEGER` | yes | 1-based closing marker line. |
| `content_hash` | `TEXT` | yes | SHA-256 of section content. |
| `summary` | `TEXT` | yes | Short generated summary from section text. |
| `token_estimate` | `INTEGER` | yes | Rough section token estimate. |
| `updated_at` | `TEXT` | yes | ISO timestamp when indexed. |
| `metadata_json` | `TEXT` | no | Future section metadata. |

Unique index: `doc_index_id + section_id`. Lookup index: `scope + project_id + doc_type + section_id`.

## `notifications`

Stores durable top-right notification-center items.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `note_...`. |
| `project_id` | `TEXT` | no | Optional project scope. |
| `conversation_id` | `TEXT` | no | Optional conversation scope. |
| `turn_id` | `TEXT` | no | Optional source turn. |
| `type` | `TEXT` | yes | Notification type, for example `memory.soul.updated`. |
| `title` | `TEXT` | yes | Short user-facing title. |
| `body` | `TEXT` | no | User-facing body text. |
| `severity` | `TEXT` | yes | `info`, `success`, `warning`, or `error`. |
| `payload_json` | `TEXT` | no | Structured details such as changed docs, rationale, confirmation decision, and compact diff. |
| `read_at` | `TEXT` | no | ISO timestamp when read; null means unread. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

## `errors`

Stores every runtime error, including provider errors, tool errors, validation errors, shell failures, and internal errors.

Errors are stored whether or not the turn eventually succeeds.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `err_...`. |
| `conversation_id` | `TEXT` | no | FK to `conversations.id` if known. |
| `session_id` | `TEXT` | no | FK to `sessions.id` if known. |
| `turn_id` | `TEXT` | no | FK to `turns.id` if known. |
| `source` | `TEXT` | yes | `server`, `core`, `provider`, `workspace`, `tool`, `db`, `websocket`, `ui`. |
| `code` | `TEXT` | yes | Stable error code. |
| `message` | `TEXT` | yes | Human-readable error message. |
| `stack` | `TEXT` | no | Stack trace when available. |
| `details_json` | `TEXT` | no | Structured error details. |
| `recoverable` | `INTEGER` | yes | Boolean as `0` or `1`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

## `artifacts`

Stores generated or tracked artifacts from a turn.

Examples:

- Reports.
- Logs.
- Rendered previews.
- Generated files.
- Screenshots.
- Exported diffs.
- Voice input recordings.
- Generated read-aloud audio.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `art_...`. |
| `project_id` | `TEXT` | no | FK to `projects.id` if artifact belongs to a project. |
| `conversation_id` | `TEXT` | no | FK to `conversations.id` if artifact belongs to a conversation. |
| `session_id` | `TEXT` | no | FK to `sessions.id` if artifact belongs to a session. |
| `turn_id` | `TEXT` | no | FK to `turns.id`. |
| `kind` | `TEXT` | yes | `file`, `log`, `screenshot`, `diff`, `report`, `audio_input`, `audio_output`, etc. |
| `path` | `TEXT` | no | Local path if artifact exists on disk. |
| `content_hash` | `TEXT` | no | Hash for integrity/change detection. |
| `mime_type` | `TEXT` | no | Artifact MIME type. |
| `size_bytes` | `INTEGER` | no | Size if known. |
| `metadata_json` | `TEXT` | no | Extra artifact metadata. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

## `voice_inputs`

Stores speech input that was transcribed into a normal user message.

Voice input should not replace `messages`. It is the capture/transcription record that explains how a user message was created.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `voicein_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | no | FK to `turns.id` created from the transcript. |
| `message_id` | `TEXT` | no | FK to `messages.id` for the final user message. |
| `audio_artifact_id` | `TEXT` | no | FK to `artifacts.id` where `kind = audio_input`. |
| `transcription_provider_id` | `TEXT` | no | Provider used for transcription. |
| `transcription_model_id` | `TEXT` | no | Model used for transcription. |
| `language` | `TEXT` | no | Detected or selected language. |
| `transcript_text` | `TEXT` | no | Final transcript used to create the message. |
| `raw_transcript_json` | `TEXT` | no | Raw provider transcription response. |
| `confidence` | `REAL` | no | Provider confidence if available. |
| `duration_ms` | `INTEGER` | no | Captured audio duration. |
| `status` | `TEXT` | yes | `recording`, `transcribing`, `completed`, `failed`, `cancelled`. |
| `error_id` | `TEXT` | no | FK to `errors.id`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `completed_at` | `TEXT` | no | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra voice-input metadata. |

## `audio_outputs`

Stores read-aloud/text-to-speech output attached to an assistant message.

Read aloud should not mutate the assistant message. It is an optional output artifact generated from that message.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `audioout_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | no | FK to `turns.id`. |
| `message_id` | `TEXT` | yes | FK to assistant `messages.id`. |
| `audio_artifact_id` | `TEXT` | no | FK to `artifacts.id` where `kind = audio_output`. |
| `provider_id` | `TEXT` | no | TTS provider id, if server-side TTS was used. |
| `model_id` | `TEXT` | no | TTS model id, if applicable. |
| `voice_id` | `TEXT` | no | Voice selected for playback. |
| `source_text_hash` | `TEXT` | no | Hash of text used for audio generation. |
| `duration_ms` | `INTEGER` | no | Generated audio duration. |
| `status` | `TEXT` | yes | `requested`, `generating`, `ready`, `played`, `failed`, `cancelled`. |
| `error_id` | `TEXT` | no | FK to `errors.id`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `completed_at` | `TEXT` | no | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra TTS/playback metadata. |

## `message_feedback`

Stores user feedback for assistant messages, turns, and model calls.

Feedback should be attached to the exact thing being rated. In most UI cases this is the final assistant message, but the schema also allows linking back to the turn and model call for analytics/debugging.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `fb_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | no | FK to `turns.id`. |
| `message_id` | `TEXT` | no | FK to `messages.id`, usually the assistant response. |
| `model_call_id` | `TEXT` | no | FK to `model_calls.id` if feedback targets a specific model call. |
| `rating` | `TEXT` | yes | `thumbs_up`, `thumbs_down`. |
| `reason_code` | `TEXT` | no | Optional reason like `incorrect`, `unhelpful`, `too_slow`, `great`. |
| `note` | `TEXT` | no | Optional user note. |
| `created_by` | `TEXT` | no | User id or local user marker. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Extra feedback metadata. |

## `session_state`

Stores the latest resumable state for a session.

This is not the audit log. It is a convenience table for fast resume. The canonical history remains `events`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `session_id` | `TEXT` | yes | Primary key and FK to `sessions.id`. |
| `active_turn_id` | `TEXT` | no | FK to running/awaiting turn. |
| `last_event_sequence` | `INTEGER` | yes | Latest event sequence for this session. |
| `state_json` | `TEXT` | yes | Resumable runtime state. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |

## `schema_migrations`

Tracks database migrations.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | `INTEGER` | yes | Primary key. |
| `name` | `TEXT` | yes | Migration name. |
| `applied_at` | `TEXT` | yes | ISO timestamp. |
| `checksum` | `TEXT` | no | Optional migration checksum. |

## Event Naming

The concrete public WebSocket schemas live in `packages/contracts`.

Events persisted from the server's public runtime stream must use the same names as the server events emitted to the frontend. Internal provider events may use provider-facing names inside `packages/providers`, but those names should be translated before persistence or UI emission.

Current persisted/public V1 event names:

```text
user.created
user.updated
user.onboarding.completed

conversation.created
conversation.updated

project.created
project.updated
project.archived
project.workspace.attached
project.workspace.detached
project.resource.created
project.resource.updated
project.resource.deleted
project.instructions.updated

session.created
session.updated
session.closed

turn.started
turn.awaiting_approval
turn.completed
turn.failed
turn.cancelled

message.created
message.completed

agent.thinking.delta
agent.answer.delta
context.usage.snapshot
context.compaction.started
context.compaction.completed
context.compaction.failed

tool.call.requested
tool.call.started
tool.call.output
tool.call.completed
tool.call.failed
tool.call.rejected

approval.requested
approval.resolved

voice.input.started
voice.input.completed
voice.input.failed

transcription.started
transcription.completed
transcription.failed

audio.output.requested
audio.output.started
audio.output.completed
audio.output.played
audio.output.failed

feedback.created
feedback.updated

shell.started
shell.stdout.delta
shell.stderr.delta
shell.exited
shell.failed

file.operation.started
file.operation.completed
file.operation.failed

patch.proposed
patch.applied
patch.rejected
patch.failed

memory.agent.started
memory.agent.completed
memory.agent.failed
memory.primary.updated
memory.primary.update_rejected
memory.note.created
memory.note.completed
memory.skill.proposed
memory.skill.approved
memory.skill.updated
memory.soul.confirmation.requested
memory.soul.confirmation.resolved
memory.soul.updated
memory.soul.update_rejected

notification.created
notification.read

error.created
artifact.created
```

Structured model-call lifecycle state is stored in `model_calls`, `model_stream_chunks`, `model_usage`, and `context_usage_snapshots`. Do not rely on `model.*` UI events for the V1 public contract.

## Voice, Read-Aloud, And Feedback Storage

Voice input, read aloud, and thumbs up/down feedback are first-class persisted flows.

The correct model is:

```text
voice input
  -> voice_inputs
  -> transcription events
  -> normal user message
  -> normal turn

read aloud
  -> assistant message
  -> audio_outputs
  -> optional audio artifact

feedback
  -> message_feedback
  -> exact message/turn/model call being rated
```

These should not be implemented as a few extra columns on `messages`. They have their own lifecycle, provider metadata, artifacts, errors, and replay events.

## Thinking And Reasoning Storage

Socrates should store and display reasoning separately from final answer text when the provider exposes it.

Important limitation:

```text
Socrates can store reasoning content only when the provider exposes it.
If the provider exposes only reasoning token counts, Socrates stores only the counts.
```

Storage split:

```text
model_stream_chunks.channel = reasoning
model_stream_chunks.channel = reasoning_summary
model_stream_chunks.channel = answer

model_usage.reasoning_tokens = token count when reported
```

UI split:

```text
Thinking
  provider-exposed reasoning or reasoning summary

Response
  normal assistant answer text
```

Context rule:

```text
Reasoning/thinking text is not carried forward as semantic prompt context between later user queries.
```

Socrates may show and persist provider-exposed reasoning for the turn where it was produced, but the next turn should normally receive the previous user message and final assistant answer, not the prior reasoning stream.

## Tool Trace Retrieval

Full messages, tool calls, model calls, events, shell output, patches, errors, and outputs are persisted for audit, replay, and targeted retrieval. They should not be blindly carried forward into later model context.

The model-visible retrieval path is the `trace_retrieve` tool. The intended implementation is a hybrid search/inspect layer over an internal trace index. Raw runtime tables remain the source of truth:

```text
messages
tool_calls
events
shell_commands
shell_output_chunks
terminal_sessions
terminal_output_chunks
file_operations
patches
errors
model_calls
model_stream_chunks
model_usage
```

The retrieval-only index layer creates trace documents from those source tables:

```text
trace_documents
trace_index_jobs
```

`trace_documents` are not model-visible tools. They are the canonical searchable corpus behind `trace_retrieve`. They contain bounded, provenance-linked chunks such as:

- User message chunks.
- Assistant response chunks.
- Tool-call summaries.
- Shell command outcomes and important output excerpts.
- Edit/patch summaries.
- Error and blocker summaries.
- Turn summaries.
- Conversation rolling summaries.
- Context compaction summaries.
- Verbatim anchors for exact high-value user-provided source text.

Retrieval should be project-scoped by backend code and support natural-language search, current conversation scope, recent conversation scope, project scope, conversation title/hint resolution, tool name, path, command, date/time, error code, source kind, and exact follow-up handles. Search and inspect must join or validate against visible non-deleted conversations (`active` and `archived`) so orphan trace documents from hard-deleted conversations cannot be returned.

Search and inspect outputs include conversation provenance derived from raw `conversations` rows: id, title when available, status, updated time, and whether the source is from the current conversation. This prevents the agent from guessing whether retrieved evidence came from the current chat or an earlier project conversation.

Structured ordinal recall is supported through `trace_retrieve` search fields, not a new table. `turnNo` counts user/Q&A turns in the resolved conversation, and optional `role` selects the user message, assistant message, or both messages for the turn. `turnNo` is an exact ordinal selector, not a search hint. If a model sends both text `query` and `turnNo`, the backend runs the query search, ignores `turnNo`, keeps `role` as a query sub-filter, and returns a warning explaining that exact turn lookup requires `turnNo` without `query`. Query search may also narrow by `role`, `entryType`, `hasAttachment`, `createdAfter`, `createdBefore`, `conversationTitle`, and `conversationId`. The ordinal lookup reads exact raw `turns` and `messages` rows as the source of truth and returns slim message-first rows with `entryType`, `messageId`, `messageNo`, `conversationTitle`, and `conversationId`; it does not backfill trace documents or infer ordinals from query text.

Current retrieval combines:

- Structured prefiltering by project, conversation, source kind, path, command, tool, and time.
- Lexical search over titles, summaries, content, paths, commands, and errors.
- Reranking that boosts exact path/title/command matches, verbatim anchors, recent relevant evidence, and high-importance source docs.
- Exact `turnNo` lookup before FTS when the model supplies a structured ordinal selector.
- Optional semantic search over active project embeddings when configured.
- Provenance marking distinguishes original turns, original attachment-bearing messages, secondary mentions, summaries, and audit evidence so the agent cannot treat later recaps or retained attachment files as deleted-conversation proof.

Large trace outputs must be bounded by `charLimit`, return truncation metadata, and offer enough ids for a follow-up retrieval.

Inspecting a `conversationId` returns a bounded ordered conversation bundle paged with `startTurnNo` and `turnLimit`. Inspecting a returned `messageId`, `turnId`, `toolCallId`, or `handle` returns exact bounded source content from trace documents when present, with raw-table fallback for exact visible sources. Inspecting ids from deleted conversations returns no result with a deleted/not-found warning.

Conversation hard delete also deletes the conversation's `trace_documents`, `trace_documents_fts` rows, `trace_embeddings`, and `trace_index_jobs`. A cleanup migration removes older orphan trace/index rows that were created before this cascade existed. Chat attachment files under `.socrates/attachments` are intentionally retained on disk and are not proof of active conversation provenance by themselves.

## Trace Index Tables

The implemented schema includes `trace_documents`, `trace_embeddings`, `project_embedding_configs`, and `trace_index_jobs`, plus an internal SQLite FTS table for lexical search.

## `trace_documents`

Stores bounded retrieval documents derived from raw Socrates history.

The source data remains in the original tables. `trace_documents` stores searchable text, summaries, metadata, and provenance so retrieval can be fast and scope-aware without dumping raw event logs into prompts.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `tdoc_...`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`; all retrieval is project-scoped. |
| `conversation_id` | `TEXT` | no | FK to `conversations.id` when document belongs to a conversation. |
| `turn_id` | `TEXT` | no | FK to `turns.id` when document belongs to a turn. |
| `source_kind` | `TEXT` | yes | `message`, `tool_call`, `shell_command`, `file_operation`, `patch`, `error`, `turn_summary`, `conversation_summary`, `verbatim_anchor`, etc. |
| `source_table` | `TEXT` | yes | Original table name such as `messages` or `tool_calls`. |
| `source_id` | `TEXT` | yes | Original row id. |
| `handle` | `TEXT` | yes | Stable inspect handle returned by `trace_retrieve`. |
| `title` | `TEXT` | yes | Human-readable title for retrieval results. |
| `summary` | `TEXT` | no | Compact summary. Deterministic first, model-generated only when needed. |
| `content` | `TEXT` | yes | Searchable text chunk or exact preserved content. |
| `content_hash` | `TEXT` | yes | Hash used to avoid redundant re-indexing and re-embedding. |
| `importance` | `TEXT` | no | `low`, `normal`, `high`, `critical`. |
| `preserve_verbatim` | `INTEGER` | yes | Boolean. True for exact source chunks that must not be summarized away. |
| `chunk_index` | `INTEGER` | no | Chunk order for multi-chunk source rows. |
| `token_count_estimate` | `INTEGER` | no | Local tokenizer estimate for search/chunk sizing and trace budgeting. |
| `metadata_json` | `TEXT` | no | Tags, paths, commands, files, scores, title hints, etc. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |

Suggested indexes:

```sql
CREATE INDEX trace_documents_project_created_idx ON trace_documents(project_id, created_at);
CREATE INDEX trace_documents_conversation_created_idx ON trace_documents(conversation_id, created_at);
CREATE INDEX trace_documents_turn_idx ON trace_documents(turn_id);
CREATE INDEX trace_documents_source_idx ON trace_documents(source_table, source_id);
CREATE UNIQUE INDEX trace_documents_handle_idx ON trace_documents(handle);
CREATE INDEX trace_documents_kind_idx ON trace_documents(source_kind);
```

SQLite FTS should be considered for lexical search over `title`, `summary`, `content`, and metadata-derived text.

## `trace_embeddings`

Stores semantic embeddings for `trace_documents`.

Embeddings are generated asynchronously. Chat turns do not wait for embedding jobs to finish. Lexical/exact retrieval works immediately after trace documents are created.

The implemented embedding phase supports both a hosted default and a fully local option:

```text
hosted default: OpenAI text-embedding-3-small
offline local: Ollama embeddinggemma by default, with Hugging Face / sentence-transformers as an advanced local backend later
```

Embedding provider choice is independent from the chat model provider. A user may chat with OpenRouter while embedding with OpenAI, or chat with OpenAI while embedding locally through Ollama. Retrieval must only compare vectors generated by the same provider id, model id, and dimensions.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `temb_...`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`; denormalized for project-scoped status and retrieval. |
| `trace_document_id` | `TEXT` | yes | FK to `trace_documents.id`. |
| `provider_id` | `TEXT` | yes | Embedding provider, currently `openai` or `ollama`. |
| `model_id` | `TEXT` | yes | Embedding model id, e.g. `text-embedding-3-small` or `embeddinggemma`. |
| `dimensions` | `INTEGER` | yes | Vector dimension. |
| `vector_json` | `TEXT` | yes | Vector storage for SQLite V1; can move to a vector extension later. |
| `content_hash` | `TEXT` | yes | Matches the embedded `trace_documents.content_hash`. |
| `usage_json` | `TEXT` | no | Provider usage metadata when available. |
| `status` | `TEXT` | yes | `completed` or `failed`. |
| `error_message` | `TEXT` | no | Failure detail for retry/status display. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `embedded_at` | `TEXT` | no | Set when embedding succeeds. |

Suggested indexes:

```sql
CREATE INDEX trace_embeddings_project_provider_idx ON trace_embeddings(project_id, provider_id, model_id, dimensions);
CREATE INDEX trace_embeddings_document_idx ON trace_embeddings(trace_document_id);
CREATE INDEX trace_embeddings_status_idx ON trace_embeddings(project_id, status);
CREATE UNIQUE INDEX trace_embeddings_active_content_idx ON trace_embeddings(trace_document_id, provider_id, model_id, dimensions, content_hash);
```

## `project_embedding_configs`

Stores each project's semantic search configuration.

The project dashboard embedding modal reads and writes this config through backend APIs. Embedding configuration is project-scoped and independent from per-turn chat model settings.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `embcfg_...`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`; one active config per project. |
| `provider_id` | `TEXT` | yes | `openai`, `ollama`, or future local/hosted providers. |
| `model_id` | `TEXT` | yes | Embedding model id. |
| `dimensions` | `INTEGER` | no | Known after a successful provider check. |
| `credential_source` | `TEXT` | yes | `server_env`, `workspace_env`, or `none`. |
| `workspace_env_file` | `TEXT` | no | Selected workspace env filename for OpenAI keys, never the key value. |
| `ollama_base_url` | `TEXT` | no | Local Ollama base URL. |
| `status` | `TEXT` | yes | `ready`, `failed`, or `disabled`. |
| `active` | `INTEGER` | yes | Boolean. Retrieval uses the one active project config. |
| `last_error` | `TEXT` | no | Last check/indexing error. |
| `last_checked_at` | `TEXT` | no | Last diagnostics timestamp. |
| `metadata_json` | `TEXT` | no | Diagnostics, setup guidance, provider raw metadata, counts. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |

Suggested indexes:

```sql
CREATE INDEX project_embedding_configs_project_active_idx ON project_embedding_configs(project_id, active);
CREATE INDEX project_embedding_configs_provider_model_idx ON project_embedding_configs(provider_id, model_id);
```

## `trace_index_jobs`

Tracks asynchronous indexing and embedding work.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `tjob_...`. |
| `project_id` | `TEXT` | yes | FK to `projects.id`. |
| `conversation_id` | `TEXT` | no | FK to `conversations.id` when job is conversation-scoped. |
| `turn_id` | `TEXT` | no | FK to `turns.id` when job indexes one turn. |
| `job_kind` | `TEXT` | yes | `build_trace_documents`, `embed_trace_documents`, `summarize_turn`, `summarize_conversation`. |
| `status` | `TEXT` | yes | `queued`, `running`, `completed`, `failed`, `cancelled`. |
| `attempts` | `INTEGER` | yes | Retry count. |
| `error_id` | `TEXT` | no | FK to `errors.id` if failed. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `started_at` | `TEXT` | no | ISO timestamp. |
| `completed_at` | `TEXT` | no | ISO timestamp. |
| `metadata_json` | `TEXT` | no | Job parameters, changed source ids, output counts. |

Trace indexing flow:

```text
turn completes or is cancelled
  -> raw tables are already persisted
  -> enqueue trace_index_jobs.build_trace_documents
  -> build deterministic trace_documents from new messages/tools/events
  -> search works immediately through SQLite FTS and exact inspect handles
  -> if project embeddings are configured, enqueue trace_index_jobs.embed_trace_documents
  -> embedding runner stores trace_embeddings asynchronously without blocking chat
```

Summaries:

- Deterministic summaries should be generated first for common tool traces and command outcomes.
- Model-generated summaries may be used later for long assistant messages, large tool outputs, noisy shell output, multi-tool turns, and rolling conversation summaries.
- Summary rows must preserve provenance through `source_table`, `source_id`, `conversation_id`, and `turn_id`.
- Verbatim anchors preserve exact user-provided source text and should be returned or inspected when exact wording matters.

## Context Assembly And Compression

The normal prompt history between user queries should carry final user/assistant dialogue, not historical tool dumps.

Default carry-forward shape:

```text
user_query_1
final_answer_1
user_query_2
current-turn tool calls and results
final_answer_2
```

Current-turn tool results may be passed back to the model until the final answer is reached. After the turn completes, detailed tool traces stay in SQLite and become available through `trace_retrieve`.

Compression should run at provider-call boundaries. A tool can stream and persist large output, but that output only becomes model context when Socrates sends the next provider request. Before each provider request, the context assembler should decide whether to keep evidence exact, compact it, or replace it with a summary plus inspect handles.

When context pressure grows, the context builder should keep:

- Recent final user/assistant dialogue.
- Current project instructions.
- Active task state when task tracking exists.
- Important decisions.
- Recent failures and blockers.
- Relevant conversation summaries and turn summaries from `trace_documents`.
- Verbatim anchor references for exact source material that must not be summarized away.
- Retrieved trace evidence only when explicitly relevant.

The V1 compression trigger is 170,000 estimated model-visible input tokens. Before each provider call, Socrates recounts the assembled request; if it is at or above that trigger, it compacts older model-facing context while preserving raw history in the database.

Compaction summaries are hidden runtime context, not fake user messages. The `messages` table must remain a record of real visible conversation messages. Context summaries should point back to exact source handles so `trace_retrieve` can inspect the raw message, turn, tool result, or verbatim anchor when precision matters.

Recent visible messages must remain represented as real role-typed chat messages in the provider request. Hidden compacted context is an additional runtime context layer for older same-conversation material, bulky current-turn tool evidence, important decisions, and trace handles. Previous conversations should not be automatically inserted into every prompt; they should enter through `trace_retrieve` or explicit project-level summaries when relevant.

Compressor model selection:

```text
built-in default worker setting: OpenRouter deepseek/deepseek-v4-flash, thinking off
ChatGPT Codex effective default when connected and the saved setting is built-in/default unavailable:
  OpenAI chatgpt_subscription gpt-5.4-mini, low reasoning
fallback:
  credential-aware available default model only
```

Hard-coded OpenRouter compressor fallbacks must not run when OpenRouter is unavailable. The evaluation should store enough metadata to compare faithfulness, preserved decisions/rules, anchor quality, output length, latency, and cost. Compression outputs remain structured summaries and turn-numbered anchors over raw rows; they do not replace `messages`, `tool_calls`, `events`, or trace source rows.

## Context Window Tracking

Before each model call, Socrates estimates the assembled provider request size. When model metadata is available, Socrates persists a context usage snapshot tied to that model call.

The current chat header shows:

```text
23,433 tokens
```

This data comes from:

- `turn_runtime_configs.context_window_tokens`
- `model_usage`
- `context_usage_snapshots`
- provider-exact context counting where available near thresholds
- local provider-aware tokenizer counts, with a safety margin for fallback/unknown tokenizers
- `model_calls.request_json.estimatedTokens` / `contextBudgetTokens` as a fallback for older rows without snapshots

## Replay Query

To replay one turn:

```sql
SELECT *
FROM events
WHERE turn_id = ?
ORDER BY sequence ASC;
```

To inspect all model calls for a turn:

```sql
SELECT *
FROM model_calls
WHERE turn_id = ?
ORDER BY started_at ASC;
```

To inspect all tool calls for a turn:

```sql
SELECT *
FROM tool_calls
WHERE turn_id = ?
ORDER BY started_at ASC;
```

To inspect token usage for a turn:

```sql
SELECT *
FROM model_usage
WHERE turn_id = ?;
```

## Current Created Schema

The current server schema creates the full table set below. Earlier planning split these into minimum and follow-up groups; that split is no longer accurate for the current repo state.

```text
users
projects
project_workspaces
project_resources
project_instructions
conversations
sessions
turns
turn_runtime_configs
messages
events
model_calls
model_stream_chunks
model_usage
context_usage_snapshots
context_compaction_snapshots
tool_calls
approvals
shell_commands
shell_output_chunks
file_operations
patches
errors
artifacts
voice_inputs
audio_outputs
message_feedback
session_state
schema_migrations
```

Implemented trace retrieval schema additions:

```text
trace_documents
trace_index_jobs
trace_documents_fts
trace_embeddings
project_embedding_configs
```
