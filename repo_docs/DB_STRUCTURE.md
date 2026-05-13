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

## Design Principle

The database should be event-log first.

Structured tables like `messages`, `model_calls`, `tool_calls`, and `errors` make querying easy. The `events` table is the chronological audit log that allows full replay.

```text
events = complete timeline
other tables = indexed structured views of important entities
```

## Entity Hierarchy

```text
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

### Conversation

A conversation is the full chat thread shown in the sidebar.

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

## Tables

## `conversations`

Stores top-level chat threads.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `conv_...`. |
| `title` | `TEXT` | no | Display title for sidebar. |
| `status` | `TEXT` | yes | `active`, `archived`, `deleted`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |
| `updated_at` | `TEXT` | yes | ISO timestamp. |
| `archived_at` | `TEXT` | no | Set when archived. |
| `metadata_json` | `TEXT` | no | JSON for future non-critical metadata. |

## `sessions`

Stores runtime/workspace execution contexts.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `sess_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `workspace_path` | `TEXT` | yes | Absolute path to active workspace/repo. |
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
| `metadata_json` | `TEXT` | no | Message metadata. |

## `events`

Stores the complete chronological audit trail.

This table is append-only except for rare maintenance/migration work.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | yes | Primary key, stable id like `evt_...`. |
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
| `turn_id` | `TEXT` | no | FK to `turns.id` when event belongs to a turn. |
| `sequence` | `INTEGER` | yes | Strictly increasing per session. |
| `type` | `TEXT` | yes | Stable event name like `model.answer.delta`. |
| `source` | `TEXT` | yes | `web`, `server`, `core`, `provider`, `workspace`, `tool`, `system`. |
| `payload_json` | `TEXT` | yes | Event payload JSON matching `packages/contracts`. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

Suggested indexes:

```sql
CREATE UNIQUE INDEX events_session_sequence_idx ON events(session_id, sequence);
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
| `request_json` | `TEXT` | yes | Full normalized request sent through `ModelProvider`. |
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
| `tool_call_tokens` | `INTEGER` | no | Tool-call-related tokens if separately reported. |
| `total_tokens` | `INTEGER` | no | Total tokens reported or calculated. |
| `cost_usd` | `REAL` | no | Estimated or provider-reported cost. |
| `raw_usage_json` | `TEXT` | no | Raw usage object from provider. |
| `created_at` | `TEXT` | yes | ISO timestamp. |

## `context_usage_snapshots`

Stores live context-window usage snapshots for the UI.

This supports a Codex-like context widget showing used tokens, remaining tokens, and percent used.

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
| `metadata_json` | `TEXT` | no | Extra process metadata. |

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
| `conversation_id` | `TEXT` | yes | FK to `conversations.id`. |
| `session_id` | `TEXT` | yes | FK to `sessions.id`. |
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

## Required Event Types

The concrete schemas should live in `packages/contracts`.

Initial event families:

```text
conversation.created
conversation.updated

session.created
session.updated
session.closed

turn.started
turn.awaiting_approval
turn.completed
turn.failed
turn.cancelled

message.created
message.delta
message.completed

model.call.started
model.reasoning.delta
model.reasoning.completed
model.answer.delta
model.answer.completed
model.call.completed
model.call.failed
model.usage.recorded
model.context_usage.snapshot

tool.call.requested
tool.call.started
tool.call.completed
tool.call.failed
tool.call.rejected

approval.requested
approval.approved
approval.rejected
approval.expired

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

error.created
artifact.created
```

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

## Context Window Tracking

After each model call, Socrates should persist a context usage snapshot.

The UI should be able to show:

```text
Context window:
21% used
55k / 258k tokens used
```

This data comes from:

- `turn_runtime_configs.context_window_tokens`
- `model_usage`
- `context_usage_snapshots`
- provider metadata where available
- local token estimation when provider does not return exact values

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

## Minimum V1 Tables

If implementation needs to start smaller, the non-negotiable V1 tables are:

```text
conversations
sessions
turns
turn_runtime_configs
messages
events
model_calls
model_usage
tool_calls
approvals
errors
voice_inputs
audio_outputs
message_feedback
schema_migrations
```

The following can be added immediately after the first working flow:

```text
model_stream_chunks
context_usage_snapshots
shell_commands
shell_output_chunks
file_operations
patches
artifacts
session_state
```
