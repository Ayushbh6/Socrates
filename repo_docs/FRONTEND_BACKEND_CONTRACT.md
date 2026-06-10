# Socrates Frontend Backend Contract

This document is the handshake between the frontend and backend workstreams.

Both sides must build against this contract. The backend owns persistence, agent execution, providers, tools, approvals, and WebSocket event emission. The frontend owns routes, screens, user interactions, rendering, local view state, and event presentation.

The executable source of truth for shared TypeScript types and schemas lives in `packages/contracts`. This document explains the V1 frontend/backend contract in human-readable form and must stay aligned with those schemas.

## Contract Goals

The contract must keep both sides aligned:

```text
frontend renders only documented responses and events
backend emits only contract-validated responses and events
both sides evolve by updating this document and packages/contracts together
```

The contract must also stay expandable for later:

- Planner and worker split.
- Sub-agents.
- More tools.
- Richer artifacts.
- Voice and read-aloud flows.
- More detailed usage and cost reporting.

## Non-Negotiable Rules

1. The frontend must not invent API response shapes locally.
2. The backend must not emit untyped WebSocket events.
3. Every WebSocket event must have a stable `type`.
4. Every WebSocket event must include enough ids to attach it to project, conversation, session, and turn state when applicable.
5. Tool calls must emit lifecycle events so the frontend can show live progress.
6. V1 should keep events small, but event envelopes must be future-proof.
7. Future planner, worker, and sub-agent events should extend this event model, not replace it.
8. Only one active turn may run per conversation at a time in V1. Different conversations may run active turns concurrently.

## Route Contract

Frontend routes:

```text
/welcome
/onboarding
/projects
/projects/new
/projects/:projectId
/projects/:projectId/chats/:conversationId
```

Route meanings:

| Route | Purpose | Primary data |
| --- | --- | --- |
| `/welcome` | Entry screen and onboarding redirect | `GET /api/me` |
| `/onboarding` | Create local user profile | `POST /api/onboarding` |
| `/projects` | List projects | `GET /api/projects` |
| `/projects/new` | Create project and attach required workspace folder | `POST /api/projects` |
| `/projects/:projectId` | Project dashboard | `GET /api/projects/:projectId` |
| `/projects/:projectId/chats/:conversationId` | Chat workspace | HTTP load plus WebSocket stream |

There is no dashboard id in V1. The project page is the dashboard.

## HTTP Envelope

All HTTP responses should use one envelope.

```ts
type ApiResponse<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: ApiError
    }
```

Error shape:

```ts
type ApiError = {
  code: string
  message: string
  details?: unknown
  requestId?: string
  recoverable?: boolean
}
```

Frontend rule:

```text
Never parse provider/tool/internal errors from plain strings.
Always use ApiError.
```

## Core Entities

These names and fields should be shared through `packages/contracts`.

```ts
type User = {
  id: string
  displayName: string
  onboardingCompleted: boolean
}

type Project = {
  id: string
  userId: string
  name: string
  description?: string
  status: "active" | "archived" | "deleted"
  updatedAt: string
}

type ProjectWorkspace = {
  id: string
  projectId: string
  kind: "existing_folder" | "created_folder" | "none"
  path?: string
  gitRepoRoot?: string
  gitBranch?: string
  isPrimary: boolean
  status: "active" | "missing" | "detached" | "archived"
}

type ProjectResource = {
  id: string
  projectId: string
  name: string
  kind: "pdf" | "document" | "text" | "image" | "url" | "local_file" | "note" | "other"
  source: "uploaded" | "linked_file" | "created_note" | "url" | "generated"
  uri?: string
  sizeBytes?: number
  mimeType?: string
  status: "active" | "processing" | "failed" | "archived" | "deleted"
}

type ProjectInstructions = {
  id: string
  projectId: string
  content: string
  updatedAt: string
}

type Conversation = {
  id: string
  projectId: string
  title?: string
  status: "active" | "archived" | "deleted"
  updatedAt: string
}

type Message = {
  id: string
  conversationId: string
  sessionId: string
  turnId?: string
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string
  partial?: boolean
  cancelled?: boolean
  cancellationReason?: string
  status: "streaming" | "completed" | "failed" | "cancelled"
  createdAt: string
}

type ConversationTerminal = {
  terminalId: string
  projectId: string
  conversationId: string
  name: string
  command: string
  cwd: string
  workspacePath: string
  status: "running" | "exited" | "stopped" | "detached" | "stale" | "awaiting_input" | "missing"
  platform?: string
  shellKind?: "posix" | "powershell" | "cmd"
  shellExecutable?: string
  processId?: string
  exitCode?: number | null
  signal?: string | null
  autoDetached: boolean
  awaitingInput: boolean
  lastPrompt?: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  output: {
    stdout: string
    stderr: string
    pty?: string
    nextOutputSequence: number
  }
}
```

V1 project/workspace invariant:

```text
Every active project must have one primary workspace folder.
The project row is Socrates metadata.
The project_workspaces row points to the real local folder.
```

`ProjectWorkspace.kind = "none"` is reserved for migration, recovery, or future non-filesystem modes. Normal V1 project creation must use `existing_folder` or `created_folder`.

## HTTP Endpoints

V1 endpoints:

```text
GET    /api/me
POST   /api/onboarding

GET    /api/models

GET    /api/provider-credentials/status
POST   /api/provider-credentials/check
POST   /api/provider-credentials/session
DELETE /api/provider-credentials/:providerId

POST   /api/workspaces/pick-folder
POST   /api/workspaces/inspect

GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId
PATCH  /api/projects/:projectId/workspace

GET    /api/projects/:projectId/resources
POST   /api/projects/:projectId/resources
POST   /api/projects/:projectId/resources/upload
DELETE /api/projects/:projectId/resources/:resourceId

PUT    /api/projects/:projectId/instructions

GET    /api/projects/:projectId/conversations
POST   /api/projects/:projectId/conversations
GET    /api/projects/:projectId/conversations/:conversationId
PATCH  /api/projects/:projectId/conversations/:conversationId
DELETE /api/projects/:projectId/conversations/:conversationId
POST   /api/projects/:projectId/conversations/:conversationId/messages

GET    /api/notifications
POST   /api/notifications/:notificationId/read
POST   /api/notifications/read-all
```

`POST /api/projects/:projectId/conversations/:conversationId/messages` remains available as a simple no-AI persistence endpoint, but the chat UI now uses the WebSocket `chat.message.send` command for real agent turns.

### `GET /api/me`

Returns the local user and onboarding state.

```ts
type GetMeResponse = {
  user: User | null
}
```

Routing rule:

```text
if user is null or user.onboardingCompleted is false:
  route to /onboarding
else:
  route to /projects
```

### `POST /api/onboarding`

Creates or updates the local user.

Request:

```ts
type CompleteOnboardingRequest = {
  displayName: string
}
```

Response:

```ts
type CompleteOnboardingResponse = {
  user: User
}
```

The onboarding page must also require OpenRouter provider setup before continuing. The name-only HTTP onboarding contract remains unchanged; provider credentials are handled by the provider credential endpoints plus either CLI local-file persistence or Tauri keychain commands.

### Provider Credential Endpoints

Provider credential APIs expose only presence, source, and validation status. They must never return API key values.

```ts
type ProviderCredentialSource = "keychain" | "local_file" | "session" | "env" | "missing"

type ProviderCredentialStatus = {
  providerId: "openai" | "google" | "openrouter"
  providerLabel: string
  required: boolean
  configured: boolean
  source: ProviderCredentialSource
  message?: string
}

type GetProviderCredentialsStatusResponse = {
  providers: ProviderCredentialStatus[]
  openRouterRequired: true
  openAiRequiredForHostedEmbeddings: true
  googleOptional: true
}

type SetProviderCredentialSessionRequest = {
  providerId: "openai" | "google" | "openrouter"
  apiKey: string
  source?: "keychain" | "local_file" | "manual" | "env_import"
}
```

`POST /api/provider-credentials/session` stores a secret in the running backend process so newly saved credentials are immediately usable. With `source = "local_file"`, the backend also writes the key to `~/.Socrates/.env`; with `source = "keychain"`, Tauri owns OS keychain persistence. It does not persist secrets to SQLite. Dev mode may use environment variables as fallback.

OpenRouter is required for the default chat/compression path. OpenAI is required only for hosted embeddings when local Ollama is not used. Google is optional.

### `GET /api/models`

Returns the backend-owned provider/model/thinking catalog.

```ts
type ProviderId = "openai" | "google" | "openrouter"

type ThinkingEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

type ModelThinkingOption = {
  id: string
  label: string
  enabled: boolean
  effort?: ThinkingEffort
}

type ModelOption = {
  providerId: ProviderId
  providerLabel: string
  modelId: string
  label: string
  thinkingOptions: ModelThinkingOption[]
  defaultThinkingOptionId: string
  capabilities?: {
    vision: boolean
  }
  contextWindowTokens?: number
  isDefault: boolean
}

type ListModelsResponse = {
  models: ModelOption[]
  defaultModel: {
    providerId: ProviderId
    modelId: string
    thinkingOptionId: string
  }
}
```

Frontend rule:

```text
render model and thinking controls from this response
do not hardcode selectable model ids in the composer
use capabilities.vision === false to warn users and avoid sending image bytes to non-vision models
```

### `GET /api/projects`

Returns projects for the local user.

```ts
type ListProjectsResponse = {
  projects: Array<{
    project: Project
    primaryWorkspace: ProjectWorkspace
    conversationCount: number
    lastActivityAt?: string
  }>
}
```

### `POST /api/workspaces/pick-folder`

Asks the local backend to open the native folder picker.

Request:

```ts
type PickWorkspaceFolderRequest = {
  mode: "start_from_scratch" | "existing_folder"
}
```

Response:

```ts
type PickWorkspaceFolderResponse = {
  path: string
  folderName: string
}
```

V1 behavior:

```text
macOS -> osascript folder picker
Windows -> PowerShell folder browser
Linux -> zenity or kdialog when available
unsupported/cancelled -> structured ApiError; frontend shows manual absolute path fallback
```

Frontend V1 should call this endpoint directly on the local backend origin rather than through the Next dev rewrite. Native picker requests can stay open while the OS dialog is active, and the rewrite layer may convert failures into plain text.

### `POST /api/workspaces/inspect`

Checks a folder before attaching it to a project.

```ts
type InspectWorkspaceRequest = {
  workspacePath: string
}

type InspectWorkspaceResponse = {
  workspacePath: string
  folderName: string
  exists: boolean
  isDirectory: boolean
  hasSocratesDir: boolean
  hasResourcesDir: boolean
}
```

This endpoint must not create, delete, or modify files. It exists so the frontend can show a confirmation when a selected folder already contains `.socrates`.

### `POST /api/projects`

Creates a project and attaches a required local workspace folder.

```ts
type CreateProjectRequest = {
  name: string
  description?: string
  creationMode: "start_from_scratch" | "existing_folder"
  workspacePath: string
  scaffoldAction?: "use_existing" | "reset"
}
```

Frontend behavior:

```text
user enters required project name
user optionally enters description
user connects a folder through native picker or manual absolute path input
frontend does not infer or rewrite the project name from the folder name
frontend sends creationMode = "existing_folder" for the simplified V1 project form
```

Backend behavior:

```text
existing_folder
  -> verify workspacePath exists and is a directory
  -> if workspacePath/.socrates exists and scaffoldAction is missing, return workspace_scaffold_action_required
  -> if scaffoldAction = "use_existing", keep workspacePath/.socrates and ensure resources exists
  -> if scaffoldAction = "reset", delete only workspacePath/.socrates and recreate resources

start_from_scratch
  -> create workspacePath if missing
  -> use the same .socrates handling when the path already exists
```

The backend must not edit the workspace root `.gitignore` in V1.

Response:

```ts
type CreateProjectResponse = {
  project: Project
  primaryWorkspace: ProjectWorkspace
}
```

### `PATCH /api/projects/:projectId/workspace`

Updates a project's active workspace connection.

```ts
type UpdateProjectWorkspaceRequest = {
  workspacePath: string
  creationMode: "existing_folder"
  scaffoldAction?: "use_existing" | "reset"
}

type UpdateProjectWorkspaceResponse = {
  primaryWorkspace: ProjectWorkspace
  resources: ProjectResource[]
}
```

Backend behavior:

```text
block if any turn in the project is queued, running, or awaiting approval
require scaffoldAction when the new folder already has .socrates
keep exactly one active primary workspace row
mark the old primary workspace detached and insert a new active primary row
copy active uploaded resources from old .socrates/resources to the new .socrates/resources
update copied uploaded resource URIs and artifact paths
leave linked/external resources unchanged
emit project.workspace.detached and project.workspace.attached
```

### `GET /api/projects/:projectId`

Loads the project dashboard.

```ts
type GetProjectResponse = {
  project: Project
  primaryWorkspace: ProjectWorkspace
  resources: ProjectResource[]
  conversations: Conversation[]
  instructions?: ProjectInstructions
  embeddingStatus?: ProjectEmbeddingStatus
}
```

Frontend display behavior:

```text
project.description is stored in full but shown as a bounded dashboard preview
instructions.content is stored in full but shown as a bounded panel preview
resource previews are shown in a bounded scrollable panel
dashboard start-chat action creates a conversation before routing to chat
conversation rows show an actions menu with rename and delete
semantic search action reflects embeddingStatus when available
```

### Project Embeddings

Implemented contract for project-scoped semantic search setup. The frontend renders setup and progress, but the backend owns provider diagnostics, API key detection, local Ollama probing, provider calls, and job creation.

```ts
type ProjectEmbeddingProvider = "openai" | "ollama"
type ProjectEmbeddingCredentialSource = "server_env" | "workspace_env" | "none"

type ProjectEmbeddingStatus = {
  configured: boolean
  ready: boolean
  providerId?: ProjectEmbeddingProvider
  modelId?: string
  configId?: string
  dimensions?: number
  credentialSource?: ProjectEmbeddingCredentialSource
  workspaceEnvFile?: string
  ollamaBaseUrl?: string
  status?: "ready" | "failed" | "disabled"
  totalDocuments: number
  indexedDocuments: number
  pendingDocuments: number
  failedDocuments: number
  activeJob?: {
    id: string
    status: "queued" | "running" | "completed" | "failed"
    createdAt: string
    startedAt?: string
    completedAt?: string
  }
  lastError?: string
  updatedAt?: string
  warnings?: string[]
}
```

Dashboard action labels should be state-aware:

```text
not configured -> Enable semantic search
queued/running job -> Embedding index running
ready and indexed -> Semantic search enabled
failed or lastError -> Fix embeddings
```

### `GET /api/projects/:projectId/embeddings/status`

Returns project embedding configuration and indexing progress.

```ts
type GetProjectEmbeddingStatusResponse = {
  status: ProjectEmbeddingStatus
}
```

### `POST /api/projects/:projectId/embeddings/check`

Runs setup diagnostics before enabling embeddings.

```ts
type CheckProjectEmbeddingsRequest =
  {
    providerId: "openai" | "ollama"
    modelId?: string
    credentialSource?: "server_env" | "workspace_env" | "none"
    workspaceEnvFile?: string
    ollamaBaseUrl?: string
  }

type CheckProjectEmbeddingsResponse = {
  providerId: "openai" | "ollama"
  modelId: string
  ok: boolean
  dimensions?: number
  serverEnvAvailable?: boolean
  workspaceEnvCandidates?: Array<{ fileName: string; hasOpenAiApiKey: boolean }>
  selectedWorkspaceEnvFile?: string
  message: string
  warnings?: string[]
}
```

Rules:

- Online checks verify server `OPENAI_API_KEY` and user-triggered workspace `.env*` key presence. The backend returns only filenames and booleans, never key values.
- Offline checks verify Ollama server reachability and selected model availability through the local Ollama HTTP API.
- The backend must not install Ollama or pull local models silently. If setup is missing, return explicit commands such as `ollama pull embeddinggemma`.

### `POST /api/projects/:projectId/embeddings/configure`

Saves the project embedding configuration and optionally enqueues indexing.

```ts
type ConfigureProjectEmbeddingsRequest =
  {
    providerId: "openai" | "ollama"
    modelId?: string
    credentialSource: "server_env" | "workspace_env" | "none"
    workspaceEnvFile?: string
    ollamaBaseUrl?: string
  }

type ConfigureProjectEmbeddingsResponse = {
  status: ProjectEmbeddingStatus
}
```

### `POST /api/projects/:projectId/embeddings/reindex`

Enqueues embedding jobs for trace documents missing embeddings for the configured provider/model/content hash.

```ts
type ReindexProjectEmbeddingsResponse = {
  status: ProjectEmbeddingStatus
}
```

Frontend modal flow:

```text
Project dashboard -> Enable semantic search
  -> choose Online or Offline
  -> run embeddings/check
  -> show setup guidance or continue
  -> configure embeddings
  -> show status/progress from embeddings/status
```

The frontend must never call OpenAI, Ollama, Hugging Face, or sentence-transformers directly.

Chat sidebar behavior:

```text
sidebar lists existing projects from GET /api/projects
expanded project sections list conversations from GET /api/projects/:projectId/conversations
project + action calls POST /api/projects/:projectId/conversations
conversation click routes to /projects/:projectId/chats/:conversationId
whole sidebar collapse is frontend local UI state
collapsed sidebar leaves no rail and shows only the reopen button
project sections can be collapsed in frontend local state
long conversation lists are bounded and scrollable in the UI
```

### `POST /api/projects/:projectId/resources/upload`

Uploads one or more files into the primary workspace scaffold.

Request:

```text
multipart/form-data
field: files
max files per request: 10
```

Backend behavior:

```text
load project primary workspace
ensure <workspace>/.socrates/resources/
reject requests with more than 10 files
for each uploaded file:
  sanitize filename
  copy uploaded file into <workspace>/.socrates/resources/
  create project_resources row with source = "uploaded" and uri = stored file path
```

Resource list/dashboard behavior:

```text
before returning project resources:
  scan direct files in <workspace>/.socrates/resources/
  create/reactivate project_resources rows for files that are present on disk
  mark uploaded resource rows deleted when their Socrates-owned file is gone
do not scan <workspace>/.socrates/attachments/ into project resources
```

Response:

```ts
type UploadProjectResourcesResponse = {
  resources: ProjectResource[]
}
```

Frontend behavior:

```text
file add action opens a file picker/input
frontend allows selecting multiple files, up to 10 at once
after upload succeeds, append/refresh resources from the backend response
file preview list shows filename, type/kind, and size when known
file preview list is bounded and scrollable instead of stretching indefinitely
```

### `DELETE /api/projects/:projectId/resources/:resourceId`

Removes a resource from the project context.

Backend behavior:

```text
verify the resource belongs to the project
if it is an uploaded Socrates-owned file under <workspace>/.socrates/resources/:
  delete the copied file
mark project_resources.status = "deleted"
append project.resource.deleted
exclude deleted resources from project dashboard and resource list responses
```

Response:

```ts
type DeleteProjectResourceResponse = {
  deletedResourceId: string
}
```

Frontend behavior:

```text
show a remove control on file-card hover/focus
ask for confirmation before deletion
remove the card after the backend confirms success
show the backend error if deletion fails
```

### `PUT /api/projects/:projectId/instructions`

Creates or updates the active project instructions.

```ts
type UpsertProjectInstructionsRequest = {
  content: string
}

type UpsertProjectInstructionsResponse = {
  instructions: ProjectInstructions
}
```

Backend behavior:

```text
load project
if active project_instructions row exists:
  update content and updated_at
else:
  create active project_instructions row
emit project.instructions.updated event
```

Frontend behavior:

```text
instructions add/edit action opens a modal with a large textarea
save calls PUT /api/projects/:projectId/instructions
dashboard shows a bounded preview of saved instructions
empty instructions show the add-instructions prompt
```

### `POST /api/projects/:projectId/conversations`

Creates a conversation inside a project.

```ts
type CreateConversationRequest = {
  title?: string
}

type CreateConversationResponse = {
  conversation: Conversation
}
```

Backend behavior:

```text
load project
create conversations row with project_id and user_id
if title is omitted, set title = "New conversation"
do not create a session yet
emit conversation.created event
```

Frontend behavior:

```text
start new chat on dashboard or sidebar calls this endpoint
route to /projects/:projectId/chats/:conversationId
empty conversation screen centers the composer
```

### `GET /api/projects/:projectId/conversations/:conversationId`

Loads one conversation and its persisted visible messages.

```ts
type GetConversationResponse = {
  conversation: Conversation
  messages: Message[]
  toolRuns: ConversationToolRun[]
  terminals?: ConversationTerminal[]
  partialTurns?: Array<{
    turnId: string
    status: "running" | "failed" | "cancelled"
    answer?: string
    reasoning?: string
  }>
  tokenUsage: {
    totalTokens: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
  }
  costUsage: {
    totalCostUsd?: number
    totalTokens: number
    cachedInputTokens: number
    cacheWriteTokens: number
    turnCount: number
    costSource: "provider_reported" | "computed" | "unknown" | "mixed"
    hasComputedCost: boolean
    hasUnknownCost: boolean
  }
  turnUsageReports?: TurnUsageReport[]
  contextUsage?: {
    providerId: string
    modelId: string
    contextWindowTokens: number
    contextUsedTokens: number
    contextLeftTokens: number
    contextUsedPercent: number
  }
}
```

`toolRuns` contains persisted, bounded tool activity for completed or cancelled turns in this conversation. It is for frontend replay/audit UI only; it is not automatically fed back into later model prompts.

`terminals` contains active and recent conversation-scoped Terminal sessions for the Terminal shell. It includes bounded stdout/stderr tails, optional raw PTY replay text, and metadata needed to hydrate the desktop right rail, bottom dock, and mobile full-screen sheet after reload. Full logs remain in terminal output persistence and can be polled or retrieved; the frontend must not treat this bounded response as the complete log archive.

Cancelled turns may include a cancelled partial assistant message when user-visible answer text streamed before cancellation. That partial assistant message is displayed in the transcript and included in later semantic prompt history as normal visible conversation text.

`partialTurns` contains incomplete turn text recovered from persisted `model_stream_chunks` for running, failed, or cancelled turns that do not have a completed assistant message row. It lets the frontend show recovered answer text, reasoning, and historical tool runs after reload instead of making the last user query look unanswered. A returned `partialTurns` item with `status = "running"` should restore the active stop-button state.

`tokenUsage` remains cumulative provider-reported usage for compatibility diagnostics. `costUsage` is the source for conversation cost/cache reporting and is materialized from completed `turnUsageReports`. The chat header shows `contextUsage.contextUsedTokens` when available and a small cumulative `costUsage.totalCostUsd` label beside it; computed or unknown costs should be marked subtly. `contextUsage` is the model-facing context budget count for the latest provider call, not cumulative spend.

OpenRouter cost reports should prefer exact `providerMetadata.openrouter.usage.cost` when available. If provider cost is absent, the backend may return a computed cost from its versioned OpenRouter endpoint-pricing snapshot and mark the report `computed`; if neither exact nor computed cost is possible, `hasUnknownCost` remains true. OpenRouter routed-provider metadata and generation response metadata are persisted for audit and are not sent to the frontend as raw prompt/request dumps.

The backend computes `contextUsage.contextUsedTokens` from the assembled provider-call payload: system prompt, visible messages, hidden compaction summaries, current-turn tool calls/results, and the tool definitions/schemas available for that call. Completed previous turns still contribute only visible user queries and final assistant answers; historical tool evidence stays in audit/tool tables unless it is part of the active turn or a hidden compaction summary.

Frontend behavior:

```text
if messages is empty:
  show centered empty-chat composer
else:
  render transcript, historical inline tool timeline, and pin composer to the bottom
show contextUsage.contextUsedTokens next to the conversation title as "<n> tokens"
do not show the context hard cap or cumulative token spend in the chat header
render partialTurns after their matching user message when no assistant message exists
```

### `PATCH /api/projects/:projectId/conversations/:conversationId`

Renames a conversation.

```ts
type UpdateConversationRequest = {
  title: string
}

type UpdateConversationResponse = {
  conversation: Conversation
}
```

Validation:

```text
title is trimmed
empty title is rejected with conversation_title_required
```

Backend behavior:

```text
load conversation within project
update conversations.title
update conversations.updated_at
emit conversation.updated event
```

### `DELETE /api/projects/:projectId/conversations/:conversationId`

Hard-deletes a conversation.

```ts
type DeleteConversationResponse = {
  deletedConversationId: string
}
```

Backend behavior:

```text
load conversation within project
delete conversation-scoped rows in one transaction
delete trace_documents, trace_documents_fts, trace_embeddings, and trace_index_jobs for the conversation
delete conversations row
emit conversation.deleted event before the final conversation row delete or as a project-scoped event
```

This endpoint must not archive the conversation and must not set `conversations.status = "deleted"` in the current V1 flow. It must not delete project resources, project instructions, the owning project, or retained chat attachment files under `.socrates/attachments`.

### `POST /api/projects/:projectId/conversations/:conversationId/messages`

Persists a user message in a conversation without calling a model provider. This endpoint remains available for backend tests, simple persistence flows, and fallback development utilities. It is no longer the primary chat UI send path.

```ts
type CreateConversationMessageRequest = {
  content: string
}

type CreateConversationMessageResponse = {
  conversation: Conversation
  message: Message
}
```

Backend behavior:

```text
load conversation within project
reject empty trimmed content with message_content_required
create or reuse the active session for this conversation
create a turns row for the user message lifecycle
create messages row with role = "user" and status = "completed"
complete the turn immediately in the no-AI UI slice so the conversation can accept another message
update conversations.updated_at
if the conversation title is "New conversation" and this is the first user message:
  update the title to the immediate 15-character placeholder
```

Title derivation:

```text
non-empty text length <= 15 -> title = normalized first-message text
non-empty text length > 15 -> title = first 15 normalized characters + "..."
image-only first message -> title = "Image chat..."
```

WebSocket chat title generation:

```text
normal chat send uses WebSocket chat.message.send
after the first user message is saved, emit conversation.updated with the placeholder title
generate a personalized title from the first text/image message
primary title model: openrouter meta-llama/llama-4-maverick, pinned to DeepInfra
fallback title model: openrouter qwen/qwen3.5-flash-02-23, pinned to Alibaba
if a generated title is returned and the title is still the placeholder, update the conversation and emit conversation.updated
record title-generation usage into ai_usage_events with source_kind = conversation_title when provider usage is available
```

Frontend behavior:

```text
normal chat send uses WebSocket chat.message.send, not this endpoint
after the first message is saved, move composer from centered state to bottom state
append the returned user message to the transcript
refresh local conversation title from conversation.updated or the response
```

### Notification Endpoints

Notifications are durable UI state for backend-owned notices such as applied soul updates. They are stored in SQLite, not as transient toasts.

```ts
type ListNotificationsResponse = {
  notifications: Notification[]
  unreadCount: number
}

type MarkNotificationReadResponse = {
  notification: Notification
  unreadCount: number
}

type MarkAllNotificationsReadResponse = {
  notifications: Notification[]
  unreadCount: number
}
```

Routes:

```text
GET  /api/notifications?unreadOnly=true&limit=20
POST /api/notifications/:notificationId/read
POST /api/notifications/read-all
```

Frontend behavior:

```text
show a top-right notification center with unread count
open a detail drawer for notification payloads such as soul-update diffs
mark individual or all notifications read through these endpoints
```

## WebSocket Connection

The chat page opens one WebSocket connection for live agent events and subscribes that socket to the active conversation with `chat.conversation.subscribe`.

Active turns are conversation-owned, not browser-socket-owned. The backend must keep the provider/tool stream running across browser refreshes, route changes, tab switches, temporary tab sleep, or reconnects while the local backend process is still alive. Events are persisted first, then broadcast to currently subscribed sockets for that conversation. If no browser is currently subscribed, the turn still continues and future subscribers recover through replay plus HTTP hydration.

The current chat UI sends user messages through `chat.message.send`. The backend creates/reuses the session, stores the user message, creates the running turn, persists the runtime config, loads model-facing history from prior user messages and final assistant answers, injects backend-owned Socrates prompt context, and calls `packages/core`.

Suggested URL:

```text
/ws
```

The frontend should identify the active project and conversation in the first command. A chat page should subscribe on initial connect and every reconnect. Returning to a conversation with an active turn should request active-turn replay before relying only on fresh deltas.

Closing the app/backend process is the boundary for V1. Since V1 has no true pause/resume, startup reconciliation marks any previously active turn as stopped/cancelled so the UI does not show a fake live stop button for work that cannot still be running.

WebSocket payloads use JSON.

## WebSocket Envelope

All client commands and server events use a common envelope.

```ts
type SocketEnvelope<TType extends string, TPayload> = {
  id: string
  type: TType
  schemaVersion: 1
  timestamp: string
  projectId?: string
  conversationId?: string
  sessionId?: string
  turnId?: string
  actor?: ActorRef
  payload: TPayload
}
```

Actor reference:

```ts
type ActorRef = {
  type: "user" | "main_agent" | "planner" | "worker" | "sub_agent" | "tool" | "system"
  id?: string
  parentId?: string
  label?: string
}
```

V1 will mostly use:

```text
user
main_agent
tool
system
```

Later, planner/worker/sub-agent events can use the same envelope.

## Client Commands

The frontend sends commands to the backend.

V1 command set:

```text
chat.conversation.subscribe
chat.conversation.unsubscribe
chat.message.send
chat.turn.cancel
approval.decide
feedback.submit
terminal.stop
terminal.input
terminal.resize
terminal.rename
```

### `chat.conversation.subscribe`

Subscribes the current WebSocket to a project conversation and optionally replays the persisted active-turn event stream.

```ts
type ChatConversationSubscribePayload = {
  replayActiveTurn?: boolean
}
```

Default frontend behavior should send `replayActiveTurn: true` on initial connect and reconnect. The backend should replay persisted active-turn server events only to the subscribing socket, then broadcast future live events to every socket currently subscribed to that conversation.

### `chat.conversation.unsubscribe`

Unsubscribes the current WebSocket from a conversation. Socket close also removes all subscriptions for that socket.

```ts
type ChatConversationUnsubscribePayload = {}
```

### `chat.message.send`

Starts a new turn from a user message.

If the conversation already has an active turn, the backend must reject the command with error code:

```text
turn_already_active
```

This guard is scoped to the target conversation. It must not reject a user message in conversation B merely because conversation A is already streaming.

```ts
type ChatMessageSendPayload = {
  clientMessageId: string
  content: string
  runtimeConfig: {
    providerId: string
    modelId: string
    thinkingEnabled: boolean
    thinkingEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
    approvalMode: "manual" | "approve_all" | "read_only_auto"
    sandboxMode: "read_only" | "workspace_write" | "danger_full_access"
  }
}
```

Runtime settings are per turn. A user may switch provider, model, or thinking mode inside one conversation; the next `chat.message.send` uses the selected runtime config while earlier turns keep their persisted settings.

### `chat.turn.cancel`

Cancels a running turn.

```ts
type ChatTurnCancelPayload = {
  turnId: string
  reason?: string
}
```

### `approval.decide`

Approves or rejects a requested action.

```ts
type ApprovalDecidePayload = {
  approvalId: string
  decision: "approved" | "rejected"
  reason?: string
}
```

### `feedback.submit`

Creates or updates feedback for a message.

```ts
type FeedbackSubmitPayload = {
  messageId: string
  turnId?: string
  modelCallId?: string
  rating: "thumbs_up" | "thumbs_down"
  reasonCode?: string
  note?: string
}
```

### `terminal.stop`

Stops a running conversation-scoped Terminal.

```ts
type TerminalStopPayload = {
  terminalId: string
  reason?: string
}
```

### `terminal.input`

Sends user-only stdin to a running Terminal. The xterm frontend should use `data` for raw keyboard and paste bytes. Older text/key fields remain accepted for compatibility. The agent cannot send this command in the current design. The backend persists only a redacted marker such as `[user input sent]`; raw stdin must not be exposed to the model or event history.

```ts
type TerminalInputPayload = {
  terminalId: string
  data?: string
  text?: string
  key?: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Escape" | "Ctrl-C"
  submit?: boolean
}
```

### `terminal.resize`

Resizes a running conversation Terminal's backend PTY to match the xterm viewport.

```ts
type TerminalResizePayload = {
  terminalId: string
  cols: number
  rows: number
}
```

### `terminal.rename`

Renames a conversation Terminal in the UI and persistence.

```ts
type TerminalRenamePayload = {
  terminalId: string
  name: string
}
```

## Server Events

V1 should stay small but sufficient.

Core event set:

```text
connection.ready
turn.started
agent.thinking.delta
agent.answer.delta
tool.call.started
tool.call.output
tool.call.completed
tool.call.failed
approval.requested
approval.resolved
context.usage.snapshot
context.compaction.started
context.compaction.completed
context.compaction.failed
terminal.started
terminal.data
terminal.output
terminal.status
terminal.input.requested
terminal.completed
terminal.stopped
terminal.stale
message.completed
turn.completed
turn.failed
turn.cancelled
error.created
```

This is enough to render:

- User query.
- Agent run status.
- Thinking stream.
- Final answer stream.
- Tool calls as they happen.
- Approval prompts.
- Tool results and failures.
- Context usage widget.
- Subtle compaction status.
- Final answer.
- Errors.

The frontend shows a small waiting indicator after send while a turn is active and before the first `agent.thinking.delta` or `agent.answer.delta` arrives.

Composer rule:

```text
no active turn -> show send arrow
active turn -> show stop button
stop button -> send chat.turn.cancel
turn.completed / turn.failed / turn.cancelled -> return to send arrow
```

## Server Event Payloads

### `connection.ready`

Sent after WebSocket connection is accepted.

```ts
type ConnectionReadyPayload = {
  connectionId: string
  serverTime: string
}
```

### `turn.started`

Sent when the backend accepts a user message and creates a turn.

```ts
type TurnStartedPayload = {
  turnId: string
  userMessage: Message
}
```

### `agent.thinking.delta`

Streams provider-exposed reasoning or reasoning summary.

```ts
type AgentThinkingDeltaPayload = {
  text: string
}
```

Only emit this when the provider exposes reasoning/thinking content. Token counts alone should go into usage/context events, not fake thinking text.

### `agent.answer.delta`

Streams visible assistant answer text.

```ts
type AgentAnswerDeltaPayload = {
  messageId: string
  text: string
}
```

### `tool.call.started`

Sent when a tool call begins or is registered.

```ts
type ToolCallStartedPayload = {
  toolCallId: string
  toolName:
    | "read"
    | "search"
    | "edit"
    | "apply_patch"
    | "bash"
    | "trace_retrieve"
    | "socrates_memory"
    | "project_notes"
    | "repo_docs"
    | "soul"
    | "list_project_resources"
    | "mcp_registry"
  category: "file" | "search" | "shell" | "git" | "patch" | "resource" | "trace" | "other"
  displayName: string
  argsPreview?: string
  requiresApproval: boolean
}
```

Frontend display examples:

```text
Reading REPO_RULES.md
Searching files
Running npm test
Applying patch
```

### `tool.call.output`

Streams useful tool output or progress.

```ts
type ToolCallOutputPayload = {
  toolCallId: string
  stream: "stdout" | "stderr" | "log" | "result"
  text?: string
  data?: unknown
}
```

For shell commands, `stdout` and `stderr` chunks should use this event in V1.

### `tool.call.completed`

Sent when a tool call succeeds.

```ts
type ToolCallCompletedPayload = {
  toolCallId: string
  summary: string
  resultPreview?: string
  durationMs?: number
  metrics?: {
    filesRead?: number
    filesEdited?: number
    commandsRun?: number
    searchesRun?: number
  }
}
```

The frontend can use these events to display compact activity summaries like:

```text
Explored 2 files, ran 1 command
```

For V1, the frontend may derive this summary from completed tool calls. The backend may also provide `metrics` to avoid duplicated counting logic.

### `tool.call.failed`

Sent when a tool call fails.

```ts
type ToolCallFailedPayload = {
  toolCallId: string
  error: ApiError
}
```

### `approval.requested`

Sent when a tool needs user approval.

```ts
type ApprovalRequestedPayload = {
  approvalId: string
  toolCallId?: string
  actionKind: "shell_command" | "file_write" | "patch_apply" | "git_commit" | "git_push" | "other"
  title: string
  description?: string
  actionPreview: string
  risk: "low" | "medium" | "high"
}
```

### `approval.resolved`

Sent after approval or rejection.

```ts
type ApprovalResolvedPayload = {
  approvalId: string
  toolCallId?: string
  decision: "approved" | "rejected"
}
```

### `context.usage.snapshot`

Sent when context usage changes.

```ts
type ContextUsageSnapshotPayload = {
  providerId: string
  modelId: string
  contextWindowTokens: number
  contextUsedTokens: number
  contextLeftTokens: number
  contextUsedPercent: number
}
```

The server should use the effective Socrates prompt budget for `contextWindowTokens`, capped by the compression hard cap. The frontend may show the used estimate in the header and can reserve richer widgets for later.

The event shape is intentionally unchanged. Richer counting metadata, such as tokenizer method, base count, safety margin, provider-exact attempt status, and warnings, is stored in backend metadata rather than exposed in the V1 frontend contract.

### `context.compaction.started`

Sent when Socrates starts compacting model-facing context before or after a provider call boundary. For blocking active-turn compaction, this event is emitted before the backend awaits the compressor model so the existing inline compaction state can render during the wait. Post-turn `reason = "precompute"` work may be persisted without being forwarded to the live UI.

```ts
type ContextCompactionStartedPayload = {
  snapshotId: string
  reason: "precompute" | "threshold" | "emergency" | "manual"
  contextUsedTokensEstimate: number
  targetTokens: number
}
```

### `context.compaction.completed`

Sent when a compaction snapshot has been written and the hidden runtime summary is available for future context assembly and `trace_retrieve`.

```ts
type ContextCompactionCompletedPayload = {
  snapshotId: string
  inputTokensEstimate: number
  outputTokensEstimate: number
  contextUsedTokensEstimate: number
}
```

### `context.compaction.failed`

Sent when compression fails. During an active turn, the backend fails the turn with a structured error rather than silently sending an over-budget provider request.

```ts
type ContextCompactionFailedPayload = {
  snapshotId?: string
  error: ApiError
}
```

### Memory And Notification Events

The backend memory agent buffers completed-turn evidence until the project batch reaches about 60k estimated tokens or the 5-minute idle flush runs. It must never block or fail the user's chat turn. Its lifecycle and user-visible notice events are contract-validated:

```text
memory.agent.started
memory.agent.completed
memory.agent.failed
memory.diary.appended
memory.primary.updated
memory.soul.confirmation.requested
memory.soul.confirmation.resolved
memory.soul.updated
notification.created
notification.read
```

Rules:

- Memory-agent events are audit/runtime events for background synthesis, diary writes, primary doc updates, and soul confirmation.
- `memory.soul.confirmation.requested` and `memory.soul.confirmation.resolved` persist the internal yes/no confirmation flow before a soul patch can apply.
- `notification.created` carries the full notification row. `notification.read` carries the notification id plus updated unread count.
- The frontend should update the notification badge from `notification.created` and `notification.read`, while HTTP remains the reload/source-of-truth path.

### `message.completed`

Sent when an assistant message is finalized.

```ts
type MessageCompletedPayload = {
  message: Message
  usage?: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
  }
}
```

### `turn.completed`

Sent when the turn is fully complete.

```ts
type TurnCompletedPayload = {
  turnId: string
  assistantMessageId?: string
  summary?: string
}
```

### `turn.failed`

Sent when a turn fails.

```ts
type TurnFailedPayload = {
  turnId: string
  error: ApiError
}
```

### `turn.cancelled`

Sent when a running turn is cancelled.

```ts
type TurnCancelledPayload = {
  turnId: string
  reason?: string
  partialAssistantMessage?: Message
}
```

### `error.created`

Sent for errors that should be visible in the frontend event timeline.

```ts
type ErrorCreatedPayload = {
  error: ApiError
  recoverable: boolean
}
```

## Tool Call Display Contract

Tool calls are not hidden backend details. They are part of the user experience.

The frontend should render:

- Tool started.
- Tool waiting for approval.
- Tool approved/rejected.
- Tool output when useful.
- Tool completed or failed.
- Compact aggregate summary.

Assistant markdown rendering must distinguish inline code from fenced code blocks. Inline code can use compact inline styling. Fenced code blocks must render in their own readable block with stable foreground/background colors, a language label when provided, horizontal scrolling for long lines, and a copy button.

V1 aggregate summary can be derived from tool events:

```text
file/search tools -> explored N files
shell tools -> ran N commands
patch tools -> edited N files
```

Future versions can add a dedicated summary event:

```text
turn.activity.summary
```

Do not add that in V1 unless the derived summary becomes messy.

## V1 Agent Tool Contract

The initial Socrates tool surface should be broad enough for real coding work but small enough to keep model behavior predictable.

Model-visible V1 tools:

```text
read
search
edit
apply_patch
bash
trace_retrieve
socrates_memory
project_notes
repo_docs
soul
list_project_resources
mcp_registry
```

Do not expose separate `glob`, `grep`, `write`, `git`, `todo`, `skill`, `question`, `webfetch`, or sub-agent/task tools in the initial tooling phase. Internal implementation helpers may be more granular, but the base model-visible surface should remain the tools above plus `mcp_registry`. Dynamic MCP tools are not included in the system prompt or first provider-call schemas; the MCP runtime may expose `mcp__...` tools only after `mcp_registry` returns them during the same turn. Patch application is exposed as `apply_patch`, not as a hidden mode inside `edit`.

All tool schemas live in `packages/contracts`. `packages/core/tools` owns the model-visible tool wrappers and registry. `packages/workspace` owns filesystem, document parsing, image extraction, shell, git, patch, and trace implementation details.

### `read`

Reads local workspace content.

Input:

```ts
type ReadToolInput = {
  path: string
  offset?: number
  charLimit?: number
}
```

Output:

```ts
type ReadToolOutput = {
  path: string
  kind: "file" | "directory" | "pdf" | "document" | "presentation" | "spreadsheet" | "image" | "binary" | "missing"
  content?: string
  entries?: Array<{ name: string; path: string; kind: "file" | "directory"; sizeBytes?: number }>
  mimeType?: string
  sizeBytes?: number
  mtimeMs?: number
  contentHash?: string
  lineEnding?: "lf" | "crlf" | "cr" | "mixed" | "none"
  image?: { mediaType?: string; nativeVisionSupported: boolean; description?: string }
  truncation: TruncationMetadata
  warnings?: string[]
}
```

Rules:

- Default model-visible output cap is an estimated 4,000 tokens.
- `tokenLimit` may request up to 6,000 estimated tokens. `charLimit` may request up to 80,000 characters for compatibility and offset paging, but effective returned text is bounded by both limits.
- Output must include `truncation.truncated = true` when content is cut.
- File reads include `contentHash` for the full file bytes, plus `mtimeMs`, `sizeBytes`, and text `lineEnding` when applicable. Hashes are freshness markers for later verified edits and must represent the full file on disk, not only the truncated text returned to the model.
- PDFs, documents, slide decks, structured data, and images must be extracted into bounded text or visual descriptions with metadata. Text extraction through `read` is bounded by an estimated default 4,000-token cap and a hard 6,000-token `tokenLimit` cap, in addition to any `charLimit`/offset paging.
- The tool must never dump a full large PDF, document, slide deck, generated file, lockfile, or binary blob into context by accident.
- Reader implementations may use local extractors or lightweight parsing libraries. The first version should prefer practical bounded extraction over deep document-processing infrastructure.
- For providers with native vision support, image reads may produce an image reference or attachment that the provider layer can include natively. For non-vision models, Socrates should provide OCR text, image metadata, or a generated visual description when available. If no image understanding path is available, return metadata plus a clear warning.

### `search`

Finds files and searches text.

Input:

```ts
type SearchToolInput = {
  mode: "files" | "text"
  pattern: string
  path?: string
  include?: string
  exclude?: string
  fixedStrings?: boolean
  caseSensitive?: boolean
  before?: number
  after?: number
  maxResults?: number
  maxMatchesPerFile?: number
  respectGitIgnore?: boolean
}
```

Output:

```ts
type SearchToolOutput = {
  matches: Array<
    | { kind: "path"; path: string; itemKind: "file" | "directory"; sizeBytes?: number; modifiedAt?: string }
    | { kind: "text"; path: string; line: number; column?: number; text: string; before?: string[]; after?: string[] }
  >
  truncated: boolean
}
```

Rules:

- `mode = "files"` covers glob/path/name search.
- `mode = "text"` covers grep-style regex or fixed-string search.
- Text search treats regex-looking queries such as `a|b`, `.*`, `\bword`, character classes, anchors, or other regex operators as regex unless `regex: false` is explicitly set. Literal searches with regex-looking syntax that return no matches should include a warning suggesting `regex: true` or simpler literal terms.
- File search matches case-insensitively against both the full relative path and basename. Glob-style queries should work for nested paths and basename matches.
- Search respects `.gitignore` by default.
- Search ignores `.git`, dependency folders, generated outputs, binary files, and large nuisance files by default unless explicitly included.
- Results must be bounded with clear truncation metadata.

### `edit`

Creates or changes a single file per call.

Input:

```ts
type EditToolInput = {
  path: string
  content?: string // new-file content, or full-file content with overwrite: true
  oldString?: string // targeted multiline replace
  newString?: string
  replaceAll?: boolean // default false => oldString must match exactly once
  overwrite?: true // explicit existing-file full rewrite intent; valid only with content
  dryRun?: boolean
}
```

Exactly one mode per call: provide `content` for a new file or explicit full-file rewrite, or `oldString`/`newString` for a targeted replace. Model-facing inputs do not carry content hashes. Existing-file `content` without `overwrite: true` is rejected with recoverable `edit_use_targeted_replace` so the model retries with targeted replacement for localized edits.

Output:

```ts
type EditToolOutput = {
  changedFiles: Array<{
    path: string
	    operation: "created" | "overwritten" | "edited" | "patched" | "deleted" | "renamed"
	    previousPath?: string
    verification?: "verified"
    contentHashBefore?: string
    contentHashAfter?: string
    sizeBytesBefore?: number
    sizeBytesAfter?: number
    lineDelta?: number
  }>
  diff: string
  dryRun: boolean
  truncation: TruncationMetadata
  warnings?: string[]
}
```

Rules:

- Requires approval unless the user explicitly runs a full-access mode.
- Must show a diff or equivalent preview before applying.
- For requests to write code, create scripts, build small programs, implement files, or build a small app/tool, the agent should treat the request as a workspace file creation/edit request. It should use `edit` by default, write generated code into the attached workspace/repo rather than `.socrates/`, choose a sensible path when obvious, ask one concise question only when destination/language/intent is genuinely ambiguous, and avoid pasting a full runnable file into chat. If the work is based on files in a subfolder, generated outputs should stay in that subfolder or the nearest relevant existing folder unless the user says otherwise. If the user lets Socrates decide, use that nearest relevant folder when one is known; use the repo root only for genuinely project-level or standalone workspace-level work, or a small well-named folder when natural. Inline code is appropriate only when the user explicitly asks for a snippet or when no write-capable workspace is available.
- Targeted replacements must fail with helpful errors when `oldString` matches zero times or more than once unless `replaceAll` is true.
- Existing-file targeted replacements and explicit whole-file overwrites require a prior `read` of the same path in the active turn. The harness records the returned `contentHash` and rejects stale or unread edits with recoverable `edit_stale_content`.
	- Non-dry-run edits must read/stat/hash before writing, write through a same-directory temp file, immediately read/stat/hash after writing, and return verified metadata. If disk does not match the planned result, the tool must fail loudly with recoverable errors such as `edit_write_failed` or `edit_verification_failed`.
	- After a successful edit, another mutation to the same existing file must re-read first rather than relying on the previous read snapshot.
- File mutations are serialized: only one mutation tool call may execute at a time per project workspace.
- Writes outside the active project workspace are denied by default.
- Sensitive paths such as `.env`, private keys, credentials, and secrets require explicit high-risk approval or are denied by policy.
- Generic `edit` writes to `<workspace>/.socrates/PROJECT_NOTES.md` are rejected with recoverable `project_notes_dedicated_tool_required`; that file remains readable through normal read/search, but mutations must use the dedicated `project_notes` tool.
- Generic `edit` writes to `<workspace>/.socrates/repo_docs/*.md` are rejected with recoverable `repo_docs_dedicated_tool_required`; those files remain readable through normal read/search, but mutations must use the dedicated `repo_docs` tool.

### `apply_patch`

Applies a patch to one or more workspace files. The preferred model-facing input is `patchText` containing a structured `*** Begin Patch` envelope with file-operation sections; standard unified diffs are also accepted for compatibility when already valid.

Input:

```ts
type ApplyPatchToolInput = {
  patch: string
  dryRun?: boolean
}
```

Output reuses `EditToolOutput`. `changedFiles` may report `patched`, `created`, `deleted`, or `renamed`; rename entries include `previousPath`.

Rules:

- Requires approval unless the user explicitly runs a full-access mode.
- Must show a diff or equivalent preview before applying.
- Structured patches are normalized before preview/apply. `@@` labels are optional hints; old lines inside each hunk are the real match target. Standard unified diffs use git apply context matching against current disk; model-facing inputs do not carry content hashes.
- Existing-file update, delete, and rename operations require a prior active-turn `read` of the source path. New-file creation does not require a prior read. After a successful patch, another mutation to the same existing path must re-read first.
- Common structured patch prefix mistakes may be normalized with warnings, but malformed unified diff hunk counts and unsafe structured patch grammar errors must fail before applying with recoverable, corrective messages that steer the model back to structured `patchText`.
- Non-dry-run patches must verify disk after applying and return the same verified metadata shape as `edit`. Deleted files verify by being absent; renamed files verify that the old path is absent and the new path exists.
- Any `apply_patch` create, update, delete, or rename whose source or destination is `<workspace>/.socrates/PROJECT_NOTES.md` is rejected with recoverable `project_notes_dedicated_tool_required`; the model should retry with `project_notes.patch`.
- Any `apply_patch` create, update, delete, or rename whose source or destination is `<workspace>/.socrates/repo_docs/*.md` is rejected with recoverable `repo_docs_dedicated_tool_required`; the model should retry with `repo_docs.patch`.
- File mutations are serialized with `edit`.
- Writes outside the active project workspace are denied by default.
- Sensitive paths such as `.env`, private keys, credentials, and secrets require explicit high-risk approval or are denied by policy.

### `bash` / Terminal

Runs Terminal commands from the project workspace. The compatibility model-visible tool id remains `bash`; product/UI copy should call this Terminal.

Input:

```ts
type BashToolInput = {
  operation?: "run" | "start" | "status" | "output" | "stop"
  command?: string
  name?: string
  target?: string
  cwd?: string
  timeoutMs?: number
  charLimit?: number
}
```

`operation` defaults to `"run"`. `run` and `start` require `command`. `status`, `output`, and `stop` are model-facing runtime-owned operations: Socrates should omit the target when exactly one active Terminal exists, or use the human Terminal `name`/`target` shown in prompt context. Model-authored inputs do not include `terminalId`, `processId`, or output sequence cursors; those remain internal for UI, persistence, supervisor control, and backwards-compatible server paths.

Output:

```ts
type BashToolOutput = {
  operation?: "run" | "start" | "status" | "output" | "stop"
  command?: string
  cwd: string
  exitCode: number | null
  signal?: string
  stdout: string
  stderr: string
  message?: string
  reusedTerminal?: boolean
  durationMs: number
  timedOut: boolean
  truncation: TruncationMetadata
  shell: {
    platform: string
    kind: "posix" | "powershell" | "cmd"
    executable: string
  }
  process?: {
    processId: string
    status: "running" | "exited" | "stopped" | "missing"
    exitCode?: number | null
    signal?: string
    startedAt?: string
    exitedAt?: string
    nextOutputSequence?: number
  }
  terminal?: {
    terminalId: string
    name: string
    status: "running" | "exited" | "stopped" | "detached" | "stale" | "awaiting_input" | "missing"
    autoDetached?: boolean
    awaitingInput?: boolean
    lastPrompt?: string
    nextOutputSequence?: number
    startedAt?: string
    updatedAt?: string
  }
}
```

Rules:

- Default timeout is 120,000 milliseconds.
- The model-visible compatibility tool id remains `bash`, but execution is PTY-backed and platform-native: POSIX on macOS/Linux; on Windows, ConPTY uses `powershell.exe` first, then `pwsh`, then `cmd.exe` as fallback. User-facing copy should say Terminal.
- `run` executes a fresh PTY command and returns a lightly normalized terminal transcript in `stdout` plus exit/status metadata. Separate `run` calls do not preserve exported environment or cwd; combine dependent shell state into one command or use `start` for durable interactive state.
- `start` launches a conversation-scoped PTY Terminal and returns quickly with shell metadata, status, and any early persisted output such as dev-server URLs. If a matching human Terminal name is already running, `start` reuses that Terminal and returns its status/output with `reusedTerminal: true` instead of spawning a duplicate. `status`, `output`, and `stop` inspect or terminate a Terminal without rerunning the command. `status` and `output` return recent DB-backed Terminal output after draining supervisor output internally, so model-visible output is not tied to process cursors. Terminals are scoped by `projectId + conversationId + workspacePath` and can be accessed by later turns in the same conversation. If more than one active Terminal exists and no natural target is supplied, the backend returns `terminal_ambiguous` with readable candidate names, statuses, commands, and cwd values.
- Foreground mutating `run` commands are serialized per workspace across concurrent conversations using the same queue as file mutations. This covers Git branch changes/commits/pushes, package installs, migrations, and file-generating scripts. Read-only commands and background Terminals such as dev servers/watchers must not hold the mutation queue forever.
- `run` remains blocking for normal commands. Commands that are likely long-running or interactive, or commands still running past `SOCRATES_TERMINAL_AUTO_DETACH_MS` (default 15 seconds), should detach into a conversation Terminal and return a running terminal result.
- Conversation terminals are cleaned up on explicit stop, user stop button, conversation delete, workspace switch, server/app shutdown, or idle TTL (`SOCRATES_TERMINAL_IDLE_TTL_MS`, default 2 hours). On server startup, persisted running terminals are reconciled with the local supervisor where possible; uncontrollable entries become `detached` or `missing`.
- Long-running Terminals are independent conversation runtime state so the agent can continue working and poll/stop them later.
- Conservative prompt detection can mark a Terminal `awaiting_input` and emit `terminal.input.requested`. User stdin is sent only by the frontend through `terminal.input`; xterm sends raw data, quick-key compatibility remains accepted, and raw stdin is redacted from persistence and model context. `awaiting_input` is a hard human-handoff state: the model must stop and wait for the user, and model-authored `stop` is rejected until the user has interacted or cancelled from the Terminal shell.
- Command wrapping, cwd markers, exit-code capture, quoting, and output streaming are shell-specific for `run`. Socrates must not rewrite Unix commands into PowerShell automatically; prompt guidance tells the agent to use PowerShell-compatible syntax on Windows.
- If a Terminal command times out or hits a shell start/protocol failure, the PTY command is stopped before later Terminal calls. Recoverable shell errors include platform, shell kind, executable, cwd, and the underlying process error details when available.
- Commands that begin by changing into a guessed absolute path outside the active workspace are rejected. Terminal already starts in the active workspace; use relative paths from there. For subfolder commands, pass `cwd` instead of prefixing the command with `cd`. Before Terminal commands create files or directories, verify the intended parent directory exists and use an explicit relative path or `cwd`.
- Command output must stream through `tool.call.output`.
- Long-running Terminal output streams through `terminal.data` so the xterm-backed Terminal shell updates even when the chat turn is idle or another turn is active. `terminal.output` is legacy-compatible event language.
- Returned stdout/stderr must be truncated when large, with full output persisted for later retrieval.
- `cwd` must stay inside the active project workspace unless explicitly approved.
- Read-only commands can be auto-allowed by policy.
- Windows read-only diagnostics such as `Get-Location`, `Get-ChildItem`, `Get-Content`, `Select-String`, `Get-Command`, `where`, Python version checks, and safe git inspection can be auto-allowed by policy. Package installation, dev servers, Docker, network commands, git mutations, deletes, migrations, and commands with side effects require approval by default.
- Destructive or credential-exfiltration patterns are denied by default.
- Safe env template filenames such as `.env.example`, `.env.sample`, `.env.template`, and `.env.local.example` are allowed by sensitive-path policy; real `.env`, private keys, credentials, and secret-like paths remain blocked or high-risk approval-gated.
- `read`, `search`, and `edit` are preferred for structured file work, but `bash` is allowed as an approved fallback when those tools fail or are insufficient.
- Commands such as `cat`, `find`, `grep`, `pdftotext`, or other local extractors should not be denied solely because an equivalent Socrates tool exists. The backend should rely on approval, workspace scoping, timeout, command policy, and output truncation to keep them controlled.

Before Python installs/runs, the backend injects compact workspace environment hints into the agent prompt. Existing project-local venvs and package managers should be preferred; if none are detected and dependencies are needed, Socrates should ask before creating an environment unless the user already requested setup.

### `trace_retrieve`

Retrieves older Socrates conversation memory and, only in explicit audit mode, execution evidence. Normal search is a conversation-memory tool over visible non-deleted project history, not a raw database id lookup and not a recursive search over prior tool output. Hard-deleted conversations must not appear in search or exact inspect results.

The model-visible interface should stay high-level and flat. Socrates should normally start with `operation="search"`, choose a retrieval `mode`, and provide the smallest useful input. Returned `resultNumber`, `conversationId`, `messageId`, and audit `toolId` may be used for follow-up inspection after search; they must not be required from the model before retrieval.

`trace_retrieve` supports two conceptual operations:

```text
search
  broad retrieval over indexed history
  returns compact numbered message-first evidence rows
  uses either query text search or turnNo ordinal lookup; mixed query plus turnNo runs query and warns

inspect
  exact bounded retrieval by returned resultNumber or natural filters
  returns bounded raw source text or exact tool evidence when precision matters
```

Input:

```ts
type TraceRetrieveToolInput =
  | {
      operation?: "search"
      mode?: "exact" | "semantic" | "combined" | "audit"
      query: string
      scope?: "current_conversation" | "recent_conversations" | "project"
      conversationTitle?: string
      conversationId?: string
      conversationLimit?: number
      role?: "user" | "assistant" | "any"
      entryType?: "user_query" | "assistant_response" | "continuation_summary" | "tool_call" | "shell" | "file" | "patch" | "error"
      hasAttachment?: boolean
      include?: Array<"messages" | "summaries" | "tool_calls" | "shell" | "files" | "errors" | "decisions">
      toolNames?: Array<"read" | "search" | "edit" | "bash" | "trace_retrieve" | "list_project_resources">
      paths?: string[]
      command?: string
      messageId?: string
      toolId?: string
      limit?: number
      includeRaw?: boolean
      charLimit?: number
    }
  | {
      operation?: "search"
      mode?: "exact"
      turnNo: number
      role?: "user" | "assistant" | "any"
      scope?: "current_conversation" | "recent_conversations" | "project"
      conversationTitle?: string
      conversationId?: string
      conversationLimit?: number
      limit?: number
      includeRaw?: boolean
      charLimit?: number
    }
  | {
      operation: "inspect"
      resultNumber?: number
      query?: string
      turnNo?: number
      role?: "user" | "assistant" | "any"
      paths?: string[]
      command?: string
      handle?: string
      conversationId?: string
      turnId?: string
      messageId?: string
      toolId?: string
      toolCallId?: string
      startTurnNo?: number
      turnLimit?: number
      include?: Array<"messages" | "summaries" | "tool_calls" | "shell" | "files" | "errors" | "decisions">
      includeRaw?: boolean
      charLimit?: number
    }
}
```

The model-facing schema exposes `resultNumber`, natural inspect filters, and exact ids returned by prior retrieval results. The primary workflow remains search first, then inspect by `resultNumber`; id-first lookup is for precise follow-up, not guessing.

Output:

```ts
type TraceRetrieveToolOutput = {
  results: Array<
    | {
        resultNumber: number
        text: string
        entryType:
          | "user_query"
          | "assistant_response"
          | "continuation_summary"
          | "tool_call"
          | "shell"
          | "file"
          | "patch"
          | "error"
        conversationTitle: string
        conversationId: string
        messageId?: string
        toolId?: string
        messageNo?: number
        provenanceKind?: "original_turn" | "attachment_origin" | "secondary_mention" | "continuation_summary" | "audit_event"
        pairedUserMessageNo?: number
        pairedUserPreview?: string
      }
    | {
        resultNumber?: number
        content: string
        entryType:
          | "user_query"
          | "assistant_response"
          | "continuation_summary"
          | "tool_call"
          | "shell"
          | "file"
          | "patch"
          | "error"
        conversationId?: string
        conversationTitle?: string
        messageId?: string
        toolId?: string
        messageNo?: number
        provenanceKind?: "original_turn" | "attachment_origin" | "secondary_mention" | "continuation_summary" | "audit_event"
        pairedUserMessageNo?: number
        pairedUserPreview?: string
        truncation?: TruncationMetadata
      }
  >
  totalMatches: number
  truncation: TruncationMetadata
  warnings?: string[]
}
```

The current output shape uses `results`. The older `traces` array shape has been removed.

Normal search results are deliberately bounded but investigation-friendly. `text` is a broad verbatim excerpt centered on the best match, with line context around matched wording and a wider minimum window for sparse word queries. When a preserved verbatim anchor matches a message, the displayed excerpt should come from the raw source message so the model sees surrounding context, not only the anchor line. `entryType` tells Socrates whether the evidence is a `user_query`, `assistant_response`, `continuation_summary`, or audit/runtime row. `provenanceKind` separates original turns and original attachment-bearing messages from secondary mentions, summaries, and audit evidence. `messageId` and `messageNo` are present only when the row is an exact user or assistant message. Assistant rows may include `pairedUserMessageNo` and `pairedUserPreview` so Socrates can report `user_query x / assistant_response y` without guessing. `conversationTitle` is the preferred human-readable location; `conversationId` is returned for disambiguating same-title conversations.

Rules:

- Retrieval is project-scoped by backend code, not by model-provided ids, and is limited to `active` plus `archived` conversations. Existing orphan trace docs from deleted conversations must be cleaned up and excluded by query joins even before cleanup runs.
- The default search mode is `exact`: lexical matching for precise words, names, paths, dates, ids, commands, and quoted text. `mode = "semantic"` uses vector search for fuzzy conceptual recall. `mode = "combined"` merges and dedupes exact plus semantic evidence when either route may help. `mode = "audit"` is required for tool calls, shell output, file operations, patches, and errors.
- Normal `exact`, `semantic`, and `combined` searches return message-first evidence rows by default, scoped to the last 10 visible conversations and top 5 results unless the model asks for a wider bounded `conversationLimit` or `limit`. Query search can be narrowed with `role`, `entryType`, `hasAttachment`, `createdAfter`, `createdBefore`, `conversationTitle`, and `conversationId` when those filters are known.
- Normal search excludes previous `trace_retrieve` outputs, read/bash/tool output, shell logs, file operations, patches, and errors. Runtime evidence remains inspectable through `mode = "audit"`.
- Image provenance may be claimed only from original message attachments or native message image parts. A later file read, shell listing, or assistant recap is secondary evidence and must not be treated as the origin conversation.
- The embedding implementation supports OpenAI hosted embeddings and offline Ollama embeddings. Embedding configuration is backend-owned; the frontend must not call embedding providers or know provider SDK details.
- If `messageId` is present, it returns that exact full message with metadata and takes precedence over search fields. If `toolId` is present with `mode = "audit"`, it returns that exact full tool call with metadata and takes precedence over search fields.
- `conversationTitle` narrows exact/audit search to matching visible conversation titles. Matching is normalized for case, punctuation, diacritics, and repeated/extra spaces.
- `mode = "exact"` should prefer literal message text, file paths, command strings, titles, and verbatim anchors.
- `mode = "semantic"` ranks by vector similarity when the project has a ready active embedding config, and otherwise returns a warning while preserving lexical/exact retrieval behavior.
- `conversationLimit` bounds project-wide or recent-conversation searches; default should be modest.
- For ordinal recall, Socrates must pass structured `turnNo` and optional `role`, without `query`. `turnNo` counts user/Q&A turns from the start of the resolved conversation; `turnNo: 2, role: "user"` means the user message in the second turn, and omitted role returns both user and assistant messages for that turn.
- The backend must not infer ordinal intent from query text. If the query says "second user message" but `turnNo` is omitted, the call is a normal lexical/exact search.
- If the model sends `query` combined with `turnNo`, the backend must run query search, ignore `turnNo`, keep `role` as a query sub-filter, and include a warning telling Socrates to select either query search or one exact turn. `turnNo` remains an ordinal selector, not a text-search hint.
- `turnNo` with `recent_conversations` or `project` may return multiple visible conversation matches, and it takes precedence over `conversationLimit`. If the turn is out of range, return an empty result with a warning rather than falling back.
- If search results contain only `secondary_mention`, `continuation_summary`, or `audit_event` provenance, the tool should warn that no visible original source was found. If an image/attachment query lacks `attachment_origin`, Socrates must not invent a deleted conversation title from later recaps or retained files.
- Search results must include `resultNumber`, `entryType`, `text`, `conversationTitle`, `conversationId`, and exact ids when available so the model can perform follow-up inspection without guessing. Do not expose trace handles, storage source tables, source ids, turn ids, scores, metadata, or inspect argument blobs in normal search output.
- If the same normalized `trace_retrieve` input is repeated within one agent turn, the agent may return the cached result with a warning instead of re-executing the same retrieval. Socrates should inspect a returned `resultNumber` or change query/filter/scope after that warning.
- Inspect results must be exact and bounded. They may return raw user messages, assistant messages, shell output, tool arguments/results, patches, errors, or summary documents, depending on `include`.
- `conversationId` inspect returns a bounded ordered conversation bundle. Use `startTurnNo` and `turnLimit` to page by turns.
- Large outputs must be paged or truncated with `TruncationMetadata`.
- Search results are compact snippets only. Exact raw content requires `operation: "inspect"` with a returned `resultNumber` or natural inspect filters.
- Raw messages, tool calls, model calls, events, shell output, patches, and errors remain the source of truth. Trace index rows are retrieval documents over that source data, not replacements for it.
- Conversation summaries and verbatim anchors must not be inserted as fake user messages.
- Verbatim anchors preserve exact high-value source chunks such as rubrics, user-provided rules, "use this throughout" instructions, canonical examples, or source-of-truth pasted text.

### `socrates_memory`

Read-only investigation over Socrates-owned memory pages under `~/.Socrates`. This is not conversation retrieval; use `trace_retrieve` for raw chat/tool provenance.

Input:

```ts
type SocratesMemoryToolInput = {
  operation: "search" | "read"
  scope?: "primary" | "project" | "all"
  category?: "learned_patterns" | "tool_usage" | "project_brief" | "project_memory" | "diary"
  path?: string
  query?: string
  searchMode?: "exact_phrase" | "keyword_all" | "keyword_any" | "whole_word" | "regex"
  memoryLimit?: number
  memoryOffset?: number
  limit?: number
  offset?: number
  charLimit?: number
  contextLines?: number
  modifiedAfter?: string
  modifiedBefore?: string
  diaryDateAfter?: string
  diaryDateBefore?: string
  entryAfter?: string
  entryBefore?: string
  year?: number
  month?: number
  day?: number
  includeSections?: boolean
}
```

Rules:

- `scope` is a memory-page scope: `primary` covers learned patterns and tool-usage docs, `project` covers the current project's brief, project memory, and diary pages, and `all` covers both readable sets.
- `memoryLimit` and `memoryOffset` control how many memory pages/files are considered. `limit` and `offset` control final returned result units.
- `path` may be full (`project/diary/2026/06/2026-06-01.md`) or category-relative (`diary/2026/06/2026-06-01.md`).
- Search is case-insensitive by default and may be queryless for browsing pages/sections.
- Identity and operating principles are core agent soul context and are not exposed through this tool.
- The server runtime bundles primary tool-usage docs and installs them under `~/.Socrates/primary/tool_usage/`: `trace_retrieve.md`, `edit_tools_and_bash.md`, `read_tools.md`, and `memory_tools.md`.

### `soul`

Read-only access to the core agent soul documents. This tool exists because identity and operating principles are special runtime context, not ordinary searchable memory pages.

Input:

```ts
type SoulToolInput = {
  operation: "read"
  document: "identity" | "operating_principles" | "both"
  charLimit?: number
}
```

Output:

```ts
type SoulToolOutput = {
  operation: "read"
  documents: Array<{
    document: "identity" | "operating_principles"
    path: string
    content: string
    truncation: TruncationMetadata
  }>
  truncation: TruncationMetadata
  warnings?: string[]
}
```

Rules:

- `soul` can only read `~/.Socrates/primary/identity.md` and `~/.Socrates/primary/operating_principles.md`.
- The main agent cannot edit these files through model-visible tools. Soul updates are proposed and applied only by the backend memory agent through verified patches.
- A proposed soul update must create a confirmation record and run the exact prompt `You are about to make changes to the soul. Are you sure?` followed by `Reply exactly yes or no.` Only an exact normalized `yes` applies the patch.
- Applied soul updates create durable notifications with rationale and compact diff payloads.

### `project_notes`

Constrained read/search/patch access to the active workspace's `.socrates/PROJECT_NOTES.md`. Generic `edit` and `apply_patch` writes to this file are rejected; normal read/search may still inspect it.

### `repo_docs`

Constrained read/search/patch access to durable workspace doctrine under `.socrates/repo_docs/`. Generic `edit` and `apply_patch` writes to these files are rejected; normal read/search may still inspect them.

Input:

```ts
type RepoDocsToolInput = {
  operation: "read" | "search" | "patch"
  path?: "REPO_RULES.md" | "APP_FLOW.md" | "FRONTEND_BACKEND_CONTRACT.md" | "DB_STRUCTURE.md" | "PROVIDER_USAGE.md" | "REPO_STRCUTURE.md"
  query?: string
  oldText?: string
  newText?: string
  replaceAll?: boolean
  charLimit?: number
}
```

Rules:

- Project access creates missing template files only; existing user-edited repo docs are preserved.
- `read` with no path returns a bounded index of the six docs.
- `search` requires `query` and searches all docs unless `path` narrows it.
- `patch` requires one allowlisted `path` plus exact `oldText`/`newText`.
- After meaningful code, contract, data, workflow, or architecture changes, the backend quietly reminds Socrates to consider whether these docs need alignment.

### `list_project_resources`

Lists project resources that Socrates already knows about, especially uploaded files stored under `<workspace>/.socrates/resources/`.

Input:

```ts
type ListProjectResourcesToolInput = {
  kind?: ProjectResource["kind"]
  limit?: number
}
```

Output:

```ts
type ListProjectResourcesToolOutput = {
  resources: Array<{
    id: string
    name: string
    kind: ProjectResource["kind"]
    source: ProjectResource["source"]
    uri?: string
    mimeType?: string
    sizeBytes?: number
    status: ProjectResource["status"]
  }>
  summary: string
  totalResources: number
  truncation: TruncationMetadata
  warnings?: string[]
}
```

Rules:

- This is read-only and may execute in parallel with `read`, `search`, and `trace_retrieve`.
- It must use backend project resource records, not model-driven shell directory scanning. The backend may sync direct files from `.socrates/resources/` into those records before returning results.
- Deleted resources are always excluded from the model-visible tool.
- `limit` defaults to 25 and has a backend/schema cap of 100.
- The model should prefer this tool before probing `.socrates/resources/` with shell commands.
- Returned resource `uri` values should be sufficient for a follow-up `read` call when the resource is file-backed.
- Chat image attachments under `.socrates/attachments/` are intentionally excluded from project resources.

## Context Carry-Forward Rule

Within one turn, Socrates may pass current-turn tool calls and tool results back to the model until the final answer is reached.

Across later user queries, Socrates should not pass the full historical tool-call dump by default. The normal model context should carry forward:

```text
previous user query
previous final assistant answer
new user query
current-turn tool calls only
```

When the context grows too large, compression happens before a provider request is sent. This includes both long conversations and long single-turn tasks. Recent visible conversation turns should still be sent as normal role-typed messages. Older same-conversation history, bulky current-turn tool evidence, and important decisions may be represented in hidden compacted context with `trace_retrieve` inspect handles.

If older conversation memory is needed, the agent should call normal `trace_retrieve` explicitly. If older runtime evidence is needed, it should retry with `mode = "audit"`. Full raw history remains persisted in SQLite for audit and replay.

`trace_retrieve` is also the exact-source fallback for compacted context. Context summaries may point to handles such as a prior message, turn, tool call, or verbatim anchor. When exact wording matters, the agent should inspect the handle before answering.

Provider-exposed thinking or reasoning text is stored for UI/replay when exposed, but it is not carried forward as semantic context between later user queries. Reasoning token counts belong in usage and context accounting, not prompt history.

Provider-specific opaque tool-call metadata needed to continue the current tool loop, such as Gemini thought signatures, may be carried only inside the active turn's in-memory model messages. It must not be loaded into later user turns as semantic history.

Compression outputs must not be written as visible `messages`. If the frontend loads conversation history through HTTP, it should continue to receive real user and assistant messages plus persisted tool runs, not hidden compaction summaries as fake chat turns.

## Future Event Expansion

The V1 event set is intentionally small. Future event families should use the same envelope.

Reserved future event families:

```text
planner.*
worker.*
sub_agent.*
artifact.*
resource.*
voice.*
audio.*
git.*
patch.*
memory.*
```

Examples:

```text
planner.plan.created
worker.task.started
sub_agent.spawned
artifact.created
resource.indexed
voice.transcription.completed
audio.output.ready
```

Because every event has `actor`, `projectId`, `conversationId`, `sessionId`, and `turnId`, future multi-agent orchestration can fit without changing the frontend/backend handshake.

## Frontend Responsibilities

Frontend owns:

- Routes and navigation.
- Page layouts.
- Loading, empty, and error states.
- Rendering projects, resources, conversations, and chat.
- Opening WebSocket connection.
- Sending client commands.
- Rendering server events.
- Showing approvals.
- Showing tool-call progress.
- Showing context usage.
- Showing message feedback controls.

Frontend must not:

- Call model providers directly.
- Run tools directly.
- Invent event types.
- Invent API shapes.
- Treat tool calls as plain text only.

## Backend Responsibilities

Backend owns:

- HTTP endpoints.
- WebSocket server.
- API validation.
- Event validation.
- SQLite persistence.
- Agent runtime calls.
- Provider calls through `packages/providers`.
- Tool execution through `packages/workspace`.
- Approval state.
- Event emission.
- Error normalization.

Backend must not:

- Emit undocumented event shapes.
- Return raw provider errors directly to frontend.
- Skip event persistence for important runtime steps.
- Create global unscoped conversations in V1.

## Contract Change Rule

The current frontend is wired to real backend APIs and WebSocket events. Do not reintroduce frontend-only mock shapes or route-specific duplicate payload types.

When a field, endpoint, command, or event changes:

1. Update this document.
2. Update `packages/contracts`.
3. Update backend validation/emission.
4. Update frontend consumers.
5. Add or update focused tests for the changed contract.
