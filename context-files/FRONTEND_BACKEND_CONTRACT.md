# Socrates Frontend Backend Contract

This document is the handshake between the frontend and backend workstreams.

Both sides must build against this contract. The backend owns persistence, agent execution, providers, tools, approvals, and WebSocket event emission. The frontend owns routes, screens, user interactions, rendering, local view state, and event presentation.

The executable source of truth for shared TypeScript types and schemas lives in `packages/contracts`. This document explains the V1 Classic frontend/backend contract in human-readable form and records the implemented V2 Seamless Flow boundary. The complete V2 schemas live in the standalone `packages/contracts/src/v2Flow.ts` module; lifecycle policy lives in `V2_FLOW_ARCHITECTURE.md`.

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

## V1/V2 Contract Boundary

Everything below remains the V1 Classic contract unless a section explicitly says otherwise.

V2 does not add goal ids, Flow state, context dispositions, or V2 routing semantics to V1 payloads and events. It has a namespaced contract family, separate handlers/subscriptions, a feature-gated UI entry, and V2-owned persistence. Existing V1 clients continue to function without knowing V2 exists.

`SOCRATES_V2_FLOW_ENABLED` is false for a directly constructed source server unless its value is exactly `true`. Direct source-server development must set it explicitly. The ordinary NPM/runtime-archive `scripts/runtime/launcher.mjs` passes the explicit environment value or defaults it to `true`, so the normal packaged web/backend product exposes the Seamless welcome choice and retains an explicit rollback override.

The implemented V2 families include:

```text
v2.flow.*
v2.goal.*
v2.turn.*
v2.routing.*
v2.context.*
v2.evidence.*
v2.speech.*
```

The exact entities, HTTP bodies, socket commands, socket events, and speech unions are in `packages/contracts/src/v2Flow.ts`. That module is not merged into the V1 command or event unions, so a V2 payload cannot be accidentally accepted by a Classic handler.

V2 reuses the same normalized provider, tool semantics, approvals, Terminal supervisor, artifacts, usage normalization, errors, workspace `.socrates/`, global `~/.Socrates/`, MCP/skills, Memory Router implementation, and global Memory Agent. Conversation-owned records are persisted through V2 contracts and 29 `v2_*` tables. Ordinary V2 execution never creates a shadow Classic runtime merely to reuse an endpoint. The explicit bridge alone maps each focus to at most one Classic conversation/session and mirrors visible Q&A idempotently; tools, evidence, usage, and events remain V2-owned. Canonical V2 Q&A parents enter the shared retrieval index with `runtimeKind = "v2_flow"` and `flowId`; lexical/semantic/combined searches use that shared index, while queryless/inspect/audit resolve through V2-owned raw evidence.

The implemented V2 Voice V1 configuration is:

```ts
type V2SpeechToTextProviderId = "local_whisper" | "openrouter"

type V2LocalWhisperModelId = "small.en" | "base.en"

type V2OpenRouterTranscriptionModelId =
  | "nvidia/parakeet-tdt-0.6b-v3"
  | "microsoft/mai-transcribe-1.5"
  | "mistralai/voxtral-mini-transcribe"

type V2TextToSpeechProviderId = "local_kokoro"
type V2LocalTtsModelId = "kokoro-82m"
```

These are V2-only payloads, not V1 payload changes. The contracts carry engine/model ids, language, duration, status, errors, artifact references, transcript text, voice/speed, and hosted usage/cost metadata where available. Backend schema checks and route validation accept only the three hosted model ids above. There is no automatic cloud fallback after a local failure. Granite Speech and Ollama speech ids are invalid for this contract.

### V2 HTTP And WebSocket Surface

`GET /api/v2/capabilities` is always mounted so the frontend can render a truthful disabled state. Every mutating/read Flow and speech route plus `/v2/ws` is mounted only when V2 is enabled.

```text
POST /api/v2/projects/:projectId/flow
GET  /api/v2/projects/:projectId/flow
POST /api/v2/projects/:projectId/flows/:flowId/goals/:goalId/open-in-classic
POST /api/v2/projects/:projectId/bridge/classic/:conversationId/continue
GET  /api/v2/projects/:projectId/flows/:flowId/events
GET  /api/v2/projects/:projectId/flows/:flowId/messages
GET  /api/v2/projects/:projectId/flows/:flowId/context
POST /api/v2/projects/:projectId/flows/:flowId/evidence/retrieve
POST /api/v2/projects/:projectId/flows/:flowId/attachments/upload
GET  /api/v2/projects/:projectId/flows/:flowId/attachments/:attachmentId/content

GET    /api/v2/speech/packs
GET    /api/v2/speech/packs/:packId
POST   /api/v2/speech/packs/:packId/install
DELETE /api/v2/speech/packs/:packId
POST   /api/v2/projects/:projectId/flows/:flowId/speech/artifacts
POST   /api/v2/projects/:projectId/flows/:flowId/speech/jobs
GET    /api/v2/projects/:projectId/flows/:flowId/speech/jobs/:jobId
GET    /api/v2/projects/:projectId/flows/:flowId/speech/artifacts/:artifactId/content

WS /v2/ws
```

V2 client commands are `v2.flow.subscribe`, `v2.flow.unsubscribe`, `v2.message.send`, `v2.routing.clarification.respond`, `v2.focus.update`, `v2.turn.cancel`, `v2.approval.decide`, `v2.feedback.submit`, `v2.credential.input.submit`, and the `v2.terminal.stop/input/resize/rename` family. Focus actions are `switch`, `pause`, `finish`, `reopen`, `archive`, `pin`, and `unpin`. The live server emits connection/snapshot hydration, turns/messages, goal routing/clarification/capsules/transitions, context dispositions/compaction, tool/approval/credential/Terminal/error lifecycle, feedback, and Frontier handover. The contract also reserves typed `v2.artifact.created` and `v2.speech.job.updated` events; artifact/speech jobs are currently handled through HTTP. All envelopes carry schema version 2 plus project/Flow scope; runtime events use a `v2.` prefix.

The V2 frontend routes are `/seamless` and `/seamless/projects/:projectId`. The Classic route family below is unchanged. V2 does not call the Classic conversation-title endpoint/service or a separate capsule-writing model; deterministic goal titles and materiality-gated rich capsule versions are its navigation/resume contract. The V2 Goal Router may reuse the configured fast structured `title_generator` worker model selection, but it calls the strict V2 routing schema and is not a title rewrite.

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
| `/welcome` | Entry/onboarding gate; Classic/Seamless chooser for an onboarded user | `GET /api/me`, `GET /api/v2/capabilities` |
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
  status: "starting" | "running" | "exited" | "stopped" | "detached" | "stale" | "awaiting_input" | "missing"
  platform?: string
  shellKind?: "posix" | "powershell" | "cmd"
  shellExecutable?: string
  processId?: string
  exitCode?: number | null
  signal?: string | null
  autoDetached: boolean
  awaitingInput: boolean
  stateVersion?: number
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
POST   /api/provider-credentials/openai/chatgpt/oauth/start
DELETE /api/provider-credentials/openai/chatgpt

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

The onboarding page should require at least one chat-capable provider auth source before continuing. The name-only HTTP onboarding contract remains unchanged; provider credentials are handled by the provider credential endpoints plus CLI/browser local-file persistence or the ChatGPT Codex OAuth flow.

### Provider Credential Endpoints

Provider credential APIs expose only presence, source, and validation status. They must never return API key values.

```ts
type ProviderCredentialSource = "keychain" | "local_file" | "session" | "env" | "missing"

type ProviderAuthMode = "api_key" | "chatgpt_subscription"

type ProviderAuthCredentialStatus = {
  authMode: ProviderAuthMode
  label: string
  configured: boolean
  source: ProviderCredentialSource
  message?: string
}

type ProviderCredentialStatus = {
  providerId: "openai" | "google" | "openrouter" | "deepseek"
  providerLabel: string
  required: boolean
  configured: boolean
  source: ProviderCredentialSource
  authModes?: ProviderAuthCredentialStatus[]
  message?: string
}

type GetProviderCredentialsStatusResponse = {
  providers: ProviderCredentialStatus[]
  openRouterRequired: true
  openAiRequiredForHostedEmbeddings: true
  googleOptional: true
  deepSeekOptional: true
}

type SetProviderCredentialSessionRequest = {
  providerId: "openai" | "google" | "openrouter" | "deepseek"
  apiKey: string
  source?: "keychain" | "local_file" | "manual" | "env_import"
}
```

`POST /api/provider-credentials/session` stores a secret in the running backend process so newly saved credentials are immediately usable. With `source = "local_file"`, the backend also writes the key to `~/.Socrates/.env`. It does not persist secrets to SQLite. Dev mode may use environment variables as fallback.

`POST /api/provider-credentials/openai/chatgpt/oauth/start` starts the experimental ChatGPT Codex subscription auth flow and returns an authorization URL, state, redirect URI, and expiry. The local callback server completes the PKCE code exchange and stores token metadata under local credential storage. `DELETE /api/provider-credentials/openai/chatgpt` removes the stored ChatGPT Codex token metadata. OpenAI API keys and ChatGPT Codex tokens are separate auth modes.

OpenRouter is no longer universally required for chat/compression. It is one available auth source. OpenAI API is required for hosted embeddings when local Ollama is not used. Google and direct DeepSeek API are optional chat/worker auth sources. Chat send and worker saves should be disabled only when no credentialed model is available.

### `GET /api/models`

Returns the backend-owned credential-filtered provider/model/thinking catalog.

```ts
type ProviderId = "openai" | "google" | "openrouter" | "deepseek" | "ollama"

type ProviderAuthMode = "api_key" | "chatgpt_subscription"

type ThinkingEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

type ModelThinkingOption = {
  id: string
  label: string
  enabled: boolean
  effort?: ThinkingEffort
}

type ModelOption = {
  providerId: ProviderId
  authMode: ProviderAuthMode
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
    authMode: ProviderAuthMode
    modelId: string
    thinkingOptionId: string
  } | null
}
```

Frontend rule:

```text
render model and thinking controls from this response
do not hardcode selectable model ids in the composer
group OpenAI API and ChatGPT Codex separately when both are configured
group OpenRouter DeepSeek and direct DeepSeek API separately when both are configured
group discovered local models under Ollama Local when Ollama is reachable
use capabilities.vision === false to warn users and avoid sending image bytes to non-vision models
```

Ollama chat model discovery is backend-owned and read-only. The backend may call local Ollama metadata endpoints such as `/api/tags` and `/api/show`, filters out embedding-only models, adds discovered chat-capable models to the returned catalog, and never pulls, installs, or deletes models from `/api/models`.

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
- The backend must not install Ollama or pull local models from discovery/check/setup flows. If setup is missing, return explicit install guidance and commands such as `ollama pull embeddinggemma:latest`.
- Configuring a project with a new embedding provider/model/dimensions tuple marks older configs inactive and builds a clean LanceDB replacement table. The previous table is retired only after the replacement is ready; in-flight work for a deactivated fingerprint must not publish late rows.

### `GET /api/embeddings/ollama/models`

Discovers the local Ollama runtime and recommended embedding models. This endpoint is read-only: it may call Ollama metadata endpoints such as `/api/tags` and `/api/show`, but it must not pull, install, or delete models.

```ts
type ListOllamaEmbeddingModelsResponse = {
  reachable: boolean
  baseUrl: string
  installedModels: Array<{
    modelId: string
    name: string
    installed: boolean
    status: "embedding" | "not_embedding" | "unknown"
    embeddingCapable: boolean
    sizeBytes?: number
    sizeLabel?: string
    capabilities?: string[]
    pullCommand?: string
    recommendedForThisSystem?: boolean
  }>
  embeddingModels: OllamaEmbeddingModel[]
  recommendedModels: OllamaEmbeddingModel[]
  suggestedModelId?: string
  hardware: {
    platform: string
    arch: string
    cpuCount: number
    totalMemoryBytes: number
    freeMemoryBytes: number
    memoryTier: "compact" | "balanced" | "large"
    recommendationReason: string
  }
  message: string
  warnings?: string[]
}
```

The backend should prefer explicit Ollama `embedding` capability metadata when available. If capability metadata is missing, the selected model still must pass `embeddings/check` before it can be saved as ready. The frontend should not expose in-app model pulls yet; recommended cards display exact manual commands and instruct the user to recheck Ollama after installing or pulling models outside Socrates.

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

`toolRuns` contains persisted, bounded tool activity for completed or cancelled turns in this conversation. It is for frontend replay/audit UI only; it is not automatically fed back into later model prompts. `activitySteps` supplies model-call chronology but is not an exhaustive replacement for `toolRuns`: during hydration, the frontend must render every unique turn-level tool run. A run claimed by an activity step stays with that model step; an unclaimed pre-model/context run is grouped into the quiet intent-discovery disclosure and remains individually expandable.

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
delete active LanceDB Q&A parents and conversation-owned retrieval runs/diagnostics; clean legacy trace rows for compatibility
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
title model: resolved Title Generator worker model setting
OpenRouter built-in default: openrouter meta-llama/llama-4-maverick with thinking off
ChatGPT Codex effective default, when connected and the saved setting is built-in/default unavailable: openai chatgpt_subscription gpt-5.4-mini with low reasoning
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

Notifications are durable UI state for backend-owned notices such as applied soul updates. They are stored in SQLite, not as transient toasts. Routine memory-agent notifications should render as a quiet activity log: concise formatted summaries first, raw diffs or traces only in details. Skill proposals are the main action-needed case because they require an explicit user approve/reject verdict before the Skill Writer Agent writes a final skill.

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
show memory-agent run summaries with changed docs plus memory-note counts and outcomes
visually distinguish pending skill proposals from routine applied/already-represented/skipped activity
```

## WebSocket Connection

The chat page opens one WebSocket connection for live agent events and subscribes that socket to the active conversation with `chat.conversation.subscribe`.

Active turns are conversation-owned, not browser-socket-owned. The backend must keep the provider/tool stream running across browser refreshes, route changes, tab switches, temporary tab sleep, or reconnects while the local backend process is still alive. Events are persisted first, then broadcast to currently subscribed sockets for that conversation. If no browser is currently subscribed, the turn still continues and future subscribers recover through replay plus HTTP hydration.

The current chat UI sends user messages through `chat.message.send`. The backend creates/reuses the session, stores the user message, creates the running turn, persists the runtime config, loads model-facing history from prior user messages and final assistant answers, injects stable backend-owned Socrates prompt context such as user/project/instructions, and calls `packages/core`. Changing date/time is not injected into the system prompt; date-sensitive work should use `current_time` or docs-tool `runtime` metadata instead of stale dates from prior docs or conversations.

Suggested URL:

```text
/ws
```

The frontend should identify the active project and conversation in the first command. A chat page should subscribe on initial connect and every reconnect. Returning to a conversation with an active turn should request active-turn replay before relying only on fresh deltas.

Closing the app/backend cannot transparently resume an arbitrary model invocation from its exact instruction pointer. Startup reconciliation therefore cancels a stale `running` turn so the UI never shows a fake live stop button. Durable agent tasks are a separate lifecycle: a Terminal-waiting task survives through persisted task/turn/wait rows, active supervisor-owned Terminals are reconciled, and an interrupted claimed continuation is safely requeued for one fresh continuation attempt. Completed or failed continuations finalize the task instead of being duplicated.

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
credential.input.submit
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

### `credential.input.submit`

Submits or cancels exactly one pending MCP credential request. The frontend must keep the input masked by default, clear its component state immediately after submit/cancel, and must not copy the value into chat messages, URL state, browser storage, analytics, or persisted UI events. The backend consumes the value only through the active in-memory turn waiter.

```ts
type CredentialInputSubmitPayload = {
  credentialRequestId: string
  turnId: string
  decision: "submitted" | "cancelled"
  value?: string // required only for submitted; forbidden for cancelled
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
credential.input.requested
credential.input.resolved
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
- Inline masked credential handoffs attached to their MCP tool row.
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
    | "url_fetch"
    | "edit"
    | "apply_patch"
    | "bash"
    | "current_time"
    | "trace_retrieve"
    | "tool_docs"
    | "skills"
    | "projects"
    | "edit_files"
    | "project_docs"
    | "repo_docs"
    | "soul"
    | "user_profile"
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
  sizeClass?: "excellent" | "preferred" | "acceptable" // present on new events; optional for historical replay
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

The backend Global Memory Agent runs on schedule or manual request when cumulative completed-turn evidence after the durable watermark reaches its signal thresholds. It packs completed-turn manifest entries one by one up to 80 turns or the 60k estimated-token cap, then runs through `SocratesAgent` with the same V1 170k context-compression trigger used by normal chat calls. It also consumes Socrates-authored memory notes as high-signal leads for profile, identity, and skill freshness. Memory-agent context compression must use the memory compressor prompt and `memoryCompactionSchema`, not the chat compressor prompt/schema. It must never block or fail the user's chat turn. Its lifecycle and user-visible notice events are contract-validated:

```text
memory.agent.started
memory.agent.completed
memory.agent.failed
memory.primary.updated
memory.note.created
memory.note.completed
memory.skill.proposed
memory.skill.approved
memory.skill.updated
memory.soul.confirmation.requested
memory.soul.confirmation.resolved
memory.soul.updated
notification.created
notification.read
```

Rules:

- Memory-agent events are audit/runtime events for background synthesis, primary doc updates, memory-note processing, skill-freshness proposals, Skill Writer Agent results, and soul confirmation.
- Skill proposal notifications should show a concise human summary and default to per-skill manual approval. A future setting may allow auto-approval, but the Skill Writer Agent still receives only approved create/update tasks.
- Routine memory notifications should summarize what was updated, which primary docs changed, how many memory notes were created/processed, and how many ended as `applied`, `already_represented`, `skipped`, or `proposed_skill`. They should not expose raw agent traces as the default notification body.
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
url_fetch
edit
apply_patch
bash
handover_to_frontier
current_time
trace_retrieve
tool_docs
skills
project_docs
repo_docs
soul
user_profile
list_project_resources
mcp_registry
```

The main-agent `memory_note` tool uses only `note` and optional `importance` as model-authored input. The backend attaches current-turn lookup refs, source project/workspace metadata, and default project-local skill-scope hint automatically.

Do not expose separate `glob`, `grep`, `write`, `git`, `todo`, `question`, broad web-search, consult-agent, or sub-agent/task tools in the initial tooling phase. Internal implementation helpers may be more granular, but the main Socrates model-visible surface should remain the tools above plus `memory_note` and dynamic MCP tools returned by `mcp_registry`. `handover_to_frontier` is conditionally visible only before a configured one-way Frontier transfer and accepts only optional compact `focus`; it is not a consultation or returnable delegation loop. It always uses the typed approval flow, even in approve-all/full-access mode. Rejection removes it for the rest of the turn and returns control to the default Socrates model. `url_fetch` is exact-URL reading only, not search or crawling. `projects`, `edit_files`, `memory_notes`, and `skill_write` are base/specialized contract tools for backend agent workflows, not normal main-agent tools. Dynamic MCP tools are not included in the system prompt or first provider-call schemas; the MCP runtime may expose `mcp__...` tools only after `mcp_registry` returns them during the same turn. Current date/time is exposed through `current_time`, not through changing system-prompt context. Main chat must not inject per-turn wake-context blocks or hidden skill/MCP matches based on user-query wording. The Memory Router may attach a tiny always-apply rules pack and route Socrates to curated docs, but it must not become raw conversation recall or hidden skill/MCP prompt matching. That always-apply pack is rendered as `<socrates_stable_cache_prelude>` before conversation/user text; dynamic routed docs, tool results, and ledgers stay after the current user message. Patch application is exposed as `apply_patch`, not as a hidden mode inside `edit`.

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
- Generic `edit` writes to `<workspace>/.socrates/MEMORY.md` or `<workspace>/.socrates/PROJECT_NOTES.md` are rejected with recoverable dedicated-tool errors; those files remain readable through normal read/search, but mutations must use `project_docs`.
- Generic `edit` writes to `<workspace>/.socrates/repo_docs/*.md` are rejected with recoverable dedicated-tool errors; those files remain readable through normal read/search, but mutations must use `repo_docs`.
- Before `edit`, `apply_patch`, or approval-required mutation tools can run, Socrates must have read, searched, or edited `repo_docs` in the same turn. Missing preflight returns recoverable `repo_docs_preflight_required` and should not request approval first.
- After meaningful work, if `project_docs memory` has not been updated, the runtime may inject one bounded `runtime_docs_sync_checkpoint` before final. A `project_docs notes` edit alone does not satisfy the durable memory checkpoint.

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
- Any `apply_patch` create, update, delete, or rename whose source or destination is `<workspace>/.socrates/MEMORY.md` or `<workspace>/.socrates/PROJECT_NOTES.md` is rejected with a recoverable dedicated-tool error; the model should retry with `project_docs`.
- Any `apply_patch` create, update, delete, or rename whose source or destination is `<workspace>/.socrates/repo_docs/*.md` is rejected with a recoverable dedicated-tool error; the model should retry with `repo_docs`.
- File mutations are serialized with `edit`.
- Writes outside the active project workspace are denied by default.
- Sensitive paths such as `.env`, private keys, credentials, and secrets require explicit high-risk approval or are denied by policy.

### `url_fetch`

Fetches one exact HTTP(S) URL as bounded text or metadata. It is not broad web search and does not crawl links, persist remote files, or return binary bodies.

Input:

```ts
type UrlFetchToolInput = {
  url: string
  charLimit?: number
  timeoutMs?: number
}
```

Output:

```ts
type UrlFetchToolOutput = {
  url: string
  finalUrl: string
  status: number
  ok: boolean
  redirected: boolean
  contentType?: string
  contentLength?: number
  sizeBytes: number
  text?: string
  title?: string
  truncation: TruncationMetadata
  warnings?: string[]
}
```

Rules:

- Only `http` and `https` URLs are accepted.
- Normal remote text fetches are read-only and can be automatic; obvious localhost/private-network URLs require approval.
- Text output is bounded by character and byte caps. Non-text responses return metadata and a warning instead of a body.
- Use configured search/MCP/provider capabilities for broad web research.

### `bash` / Terminal

Runs Terminal commands from the project workspace. The compatibility model-visible tool id remains `bash`; product/UI copy should call this Terminal.

Input:

```ts
type BashToolInput = {
  operation?: "run" | "start" | "status" | "output" | "stop" | "list"
  command?: string
  argv?: string[]
  name?: string
  target?: string
  cwd?: string
  timeoutMs?: number
  charLimit?: number
  inputMode?: "none" | "user"
}
```

`operation` defaults to `"run"`. `run` and `start` require `command`; `list` requires neither and returns at most 12 compact rows. An intentionally user-interactive program must use `operation: "start"` with `inputMode: "user"`; this explicit intent is the primary input-state signal, while conservative rolling PTY protocol evidence is only supporting evidence. `status`, `output`, and `stop` are model-facing runtime-owned operations: Socrates should omit the target when exactly one active Terminal exists, or use the human Terminal `name`/`target` shown in prompt context. Model-authored inputs do not include `terminalId`, `processId`, or output sequence cursors; those remain internal for UI, persistence, supervisor control, and backwards-compatible server paths. Model-requested `charLimit` is capped at 16,000.

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
    kind: "posix" | "powershell" | "cmd" | "direct"
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
    status: "starting" | "running" | "exited" | "stopped" | "detached" | "stale" | "awaiting_input" | "missing"
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

- Raw PTY `run` lifetime is task-aware rather than governed by the old blocking-run timeout: after the foreground window it remains a Terminal until normal task/lifecycle cleanup. The restricted direct `argv` diagnostic lane remains bounded by its executor timeout.
- `argv` is a foreground `run`-only direct-exec lane: its first item is the executable and the remaining items are literal arguments. It does not invoke a shell, so redirects, pipes, substitutions, environment assignment, and other shell syntax are unavailable. A deliberately small diagnostic allowlist—such as `pwd`, tightly constrained Git inspection, ripgrep discovery, and version checks—can be auto-allowed. Any other argv command remains approval-gated outside full-access mode.
- Raw `command` remains the full Terminal capability for shell syntax, scripts, tests, builds, package commands, servers, REPLs, and TUI work. It is approval-gated outside full-access mode rather than classified as read-only by a prefix regex. Package scripts and builds are never assumed read-only.
- The model-visible compatibility tool id remains `bash`, but execution is PTY-backed and platform-native: POSIX on macOS/Linux; on Windows, ConPTY uses `powershell.exe` first, then `pwsh`, then `cmd.exe` as fallback. User-facing copy should say Terminal.
- `run` executes a fresh PTY command and returns a lightly normalized terminal transcript in `stdout` plus exit/status metadata. Separate `run` calls do not preserve exported environment or cwd; combine dependent shell state into one command or use `start` for durable interactive state.
- `start` launches a conversation-scoped PTY Terminal and returns quickly with shell metadata, status, and any early persisted output such as dev-server URLs. The backend first persists `starting`, then commits `running` only after supervisor ownership and process metadata are recorded; the UI treats `starting` as active. If a matching human Terminal name is already active, `start` reuses that Terminal and returns its status/output with `reusedTerminal: true` instead of spawning a duplicate. `status`, `output`, and `stop` inspect or terminate a Terminal without rerunning the command. `status` and `output` return recent DB-backed Terminal output after draining supervisor output internally, so model-visible output is not tied to process cursors. Terminals are scoped by `projectId + conversationId + workspacePath` and can be accessed by later turns in the same conversation. If more than one active Terminal exists and no natural target is supplied, the backend returns `terminal_ambiguous` with readable candidate names, statuses, commands, and cwd values.
- A short-lived foreground `run` that exits while `start` performs its initial drain returns that already-captured model-visible output directly. It must not immediately perform a second cursor read that replaces real output with `No new Terminal output`.
- Foreground mutating `run` commands are serialized per workspace across concurrent conversations using the same queue as file mutations. This covers Git branch changes/commits/pushes, package installs, migrations, and file-generating scripts. Read-only commands and background Terminals such as dev servers/watchers must not hold the mutation queue forever.
- Every raw shell `run` shares the same foreground-to-background path. It returns a normal result when it finishes inside `SOCRATES_TERMINAL_AUTO_DETACH_MS` (default 15 seconds), otherwise returns the same still-running PTY as a named conversation Terminal.
- Healthy committed Terminals are not stopped merely because two hours elapsed or the main server restarts. Coordinated server close rejects new Terminal operations, aborts and drains active turns, waits for in-flight starts, and leaves only committed sessions owned by the independent Terminal supervisor; interrupted starts are physically stopped and persisted. Startup reconciles `starting`, `running`, and `awaiting_input` rows and resumes polling. Cleanup is explicit stop, conversation deletion, workspace switch, confirmed process loss, completed-output retention, or explicit supervisor shutdown. A Terminal referenced by a durable waiting task remains alive.
- Long-running Terminals are independent conversation runtime state so the agent can continue working and inspect/stop them later. If a claimed continuation is interrupted by server shutdown, startup requeues the same durable task and the atomic continuation claim allows one retry.
- Terminal supervisors are isolated per Socrates home and expose an internal health handshake. They serialize shutdown behind in-flight starts, reject new starts once shutdown begins, support targeted host shutdown, remove a host from ownership when its endpoint is confirmed unreachable, and self-expire after a bounded genuinely idle period. A single request timeout must not replace or kill a potentially healthy supervisor. Runtime polling tolerates two consecutive transport failures and marks the Terminal `missing` on the third; startup distinguishes a missing process from an unavailable supervisor and distinguishes recovered from missing incomplete starts. Either unrecoverable state wakes a matching durable wait as `failed` with bounded persisted recovery evidence. If normal and targeted host shutdown both fail, the session is persisted as `detached` with error evidence rather than falsely marked `stopped`.
- `wait` is a separate model tool, not a terminal polling parameter. It accepts one to eight unique human Terminal names, one to three unique events from `completed`, `failed`, and `input_required`, and a required reason limited to 7 words and 64 characters. On success it persists the task dependencies and ends the current model execution without a final assistant message. The coordinator resumes the same task on a requested event with bounded new output plus a bounded authoritative overview of prior task tools, commands, Terminal final states, and waits; the fresh invocation must not recreate already-attempted work merely because it is absent from the active Terminal list. No elapsed timer wakes the model.
- Explicit `inputMode: "user"` is the primary signal that a started program will require the user; bounded rolling PTY protocol evidence can additionally recognize structurally anchored confirmation, selector, and hidden-input frames without broad question-word matching. Either path can mark a Terminal `awaiting_input` and emit `terminal.input.requested`. User stdin is sent only by the frontend through `terminal.input`; xterm sends raw data, quick-key compatibility remains accepted, and raw stdin is redacted from persistence and model context. `awaiting_input` is a hard human-handoff state: the model must stop and wait for the user, and model-authored `stop` is rejected until the user has interacted or cancelled from the Terminal shell.
- For a user-interactive `start` result that is already `awaiting_input`, the runtime deterministically performs any mandatory project-memory review and registers a `completed`/`failed` wait if the provider tries to answer instead. Completion resumes the same task and the transcript represents the suspended phase as a successful continuation, not a stopped or failed turn. Current runtime tool capabilities are authoritative over stale memory or prior-chat claims that interactive Terminal is unavailable.
- Command wrapping, cwd markers, exit-code capture, quoting, and output streaming are shell-specific for `run`. Socrates must not rewrite Unix commands into PowerShell automatically; prompt guidance tells the agent to use PowerShell-compatible syntax on Windows.
- If a Terminal command times out or hits a shell start/protocol failure, the PTY command is stopped before later Terminal calls. Recoverable shell errors include platform, shell kind, executable, cwd, and the underlying process error details when available.
- Commands that begin by changing into a guessed absolute path outside the active workspace are rejected. Terminal already starts in the active workspace; use relative paths from there. For subfolder commands, pass `cwd` instead of prefixing the command with `cd`. Before Terminal commands create files or directories, verify the intended parent directory exists and use an explicit relative path or `cwd`.
- Command output must stream through `tool.call.output`.
- Long-running Terminal output streams through `terminal.data` so the xterm-backed Terminal shell updates even when the chat turn is idle or another turn is active. `terminal.output` is legacy-compatible event language.
- Terminal lifecycle snapshots carry a monotonic `stateVersion`. Creation commits `starting` before launching and a later `running` only after supervisor/process ownership is durable. Input first commits `running`, then writes to the PTY; any newly detected prompt commits a later `awaiting_input` version. Prompt timers are tied to that exact input/output generation, unchanged polling does not emit duplicate lifecycle events, and the frontend ignores any late snapshot older than its current version.
- Returned stdout/stderr must be truncated when large, with full output persisted for later retrieval.
- `cwd` must stay inside the active project workspace unless explicitly approved.
- Only structured allowlisted argv diagnostics can be auto-allowed by policy; raw shell text is approval-gated outside full-access mode.
- Windows read-only diagnostics such as `Get-Location`, `Get-ChildItem`, `Get-Content`, `Select-String`, `Get-Command`, `where`, Python version checks, and safe git inspection can be auto-allowed by policy. Package installation, dev servers, Docker, network commands, git mutations, deletes, migrations, and commands with side effects require approval by default.
- Destructive or credential-exfiltration patterns are denied by default.
- Safe env template filenames such as `.env.example`, `.env.sample`, `.env.template`, and `.env.local.example` are allowed by sensitive-path policy; real `.env`, private keys, credentials, and secret-like paths remain blocked or high-risk approval-gated.
- `read`, `search`, `url_fetch`, and `edit` are preferred for structured local/remote reads and file work, but `bash` is allowed as an approved fallback when those tools fail or are insufficient.
- Commands such as `cat`, `find`, `grep`, `pdftotext`, or other local extractors should not be denied solely because an equivalent Socrates tool exists. The backend should rely on approval, workspace scoping, timeout, command policy, and output truncation to keep them controlled.
- Terminal may also run bounded one-off scripts when no exact tool exists, such as document rendering/OCR, data parsing, local CLI calls, or hypothesis checks. Installs, broad crawls, large downloads, secret-bearing external requests, and risky mutations remain approval-gated.
- Terminal lifecycle events are emitted only to sockets subscribed to the validated owning conversation. User terminal controls must carry that same project/conversation scope and are rejected from an unsubscribed socket.

Before Python installs/runs, Socrates should read project notes when workspace runtime facts matter. The backend maintains a protected `runtime_context` section in `.socrates/PROJECT_NOTES.md` with compact generated workspace scan facts such as detected stack, package manager, and virtual-environment hints. It refreshes lazily when `project_docs` touches notes and is rewritten only when the generated signature changes. Existing project-local venvs and package managers should be preferred; if none are detected and dependencies are needed, Socrates should ask before creating an environment unless the user already requested setup. Terminal output, live terminal state, dependency dumps, package lists, and root-script inventories must not be written into that persisted section.

First-turn project recall is mandatory for light greetings, "continue", "where were we", and broad project-status openers. Socrates must read `project_docs` notes `active_context` before answering so project-local open loops can surface naturally without global user-profile pollution.

### `current_time`

Read-only access to the backend-owned current local date, ISO timestamp, and resolved time zone. This tool has no input and exists so changing date/time does not sit at the front of the cache-sensitive system prompt.

Input:

```ts
type CurrentTimeToolInput = {}
```

Output:

```ts
type RuntimeTimeMetadata = {
  currentDate: string
  currentDateTime: string
  timeZone: string
  source: "system"
}
```

Rules:

- Use `current_time({})` for date-sensitive answers, filenames, logs, and document prose that truly needs today's date or exact time.
- Do not infer today's date from project docs, older conversations, state ledgers, or prior tool outputs.
- The system prompt must not include changing current date/time fields.

### `trace_retrieve`

Accepted replacement contract: main Socrates retrieval is active-project scoped and defaults to the full project. Search modes are `lexical`, `semantic`, `combined`, and `audit`; `exact` and main-agent cross-project selectors are retired. Lexical queries accept at most 128 characters and search all supplied terms. Semantic/combined queries accept at most 1,000 characters. Normal rows return only `resultNumber`, `content`, `turnId`, `conversationTitle`, `turnNumber`, `matchedRole`, `status`, and `occurredAt`; inspect resolves the numbered result to its full parent. Scores and storage/vector/message/chunk ids remain backend-only.

Memory retrieval rows return only `resultNumber`, `content`, `surface`, `fileName`, `sectionId`, `sectionHeading`, and `scope`. The pre-turn `MemoryRouterAgent` receives automatic hybrid candidates, may call `memory_search` three times, and must finish with Zod-validated exact `readTargets` only. It has no write field or write path.

Normal retrieval searches visible active/archived conversation turns in the active project. The main-agent contract never accepts a project selector; the WebSocket executor supplies the active `projectId`. The Global Memory Agent has a separate explicit cross-project contract.

```ts
type TraceRetrieveToolInput =
  | {
      operation?: "search"
      mode?: "lexical"
      query?: string // max 128 characters
      scope?: "current_conversation" | "recent_conversations" | "project"
      conversationTitle?: string
      role?: "user" | "assistant" | "any"
      createdAfter?: string
      createdBefore?: string
      limit?: number
      turnNo?: number
    }
  | {
      operation?: "search"
      mode: "semantic" | "combined"
      query: string // max 1,000 characters
      scope?: "current_conversation" | "recent_conversations" | "project"
      conversationTitle?: string
      role?: "user" | "assistant" | "any"
      createdAfter?: string
      createdBefore?: string
      limit?: number
    }
  | {
      operation?: "search"
      mode: "audit"
      query: string // max 1,000 characters
      scope?: "current_conversation" | "recent_conversations" | "project"
      include?: Array<"tool_calls" | "shell" | "files" | "errors">
      toolNames?: string[]
      paths?: string[]
      command?: string
      conversationTitle?: string
      limit?: number
    }
  | {
      operation: "inspect"
      resultNumber?: number
      turnId?: string
      conversationTitle?: string
      turnNo?: number
      charLimit?: number
    }

type TraceRetrieveToolOutput = {
  results: Array<{
    resultNumber: number
    content: string
    turnId: string
    conversationTitle: string
    turnNumber: number
    matchedRole: "user" | "assistant"
    status: "complete" | "cancelled_partial" | "failed_user_only" | "cancelled_user_only"
    occurredAt: string
  }>
  totalMatches: number
  warnings?: string[]
}

type GlobalTraceRetrieveToolInput =
  | (Omit<Exclude<TraceRetrieveToolInput, { operation: "inspect" }>, "scope"> & {
      scope?: "project" | "all_projects"
      projectId?: string | string[]
      projectTitle?: string | string[]
      conversationId?: string
    })
  | {
      operation: "inspect"
      resultNumber?: number
      turnId?: string
      projectId?: string
      projectTitle?: string
      conversationTitle?: string
      turnNo?: number
      charLimit?: number
    }

type GlobalTraceRetrieveToolOutput = {
  results: Array<TraceRetrieveToolOutput["results"][number] & { projectTitle: string }>
  totalMatches: number
  warnings?: string[]
}
```

Rules:

- `lexical` uses LanceDB FTS, searches the entire supplied query, and rejects queries above 128 characters. There is no term-count slicing or silent truncation.
- `semantic` runs vector search across the complete selected project corpus; it is not bounded to recent candidates.
- `combined` fuses lexical and vector ranks with reciprocal-rank fusion.
- `audit` searches authoritative raw runtime evidence without embeddings.
- User and assistant text are chunked independently under one canonical Q&A parent. Normal semantic indexing excludes summaries, tool calls, shell output, patches, files, errors, and provider reasoning.
- Ranking returns at most eight distinct parents. Relevance wins; recency may reorder only within a 0.05 normalized-score band.
- Normal results expose only the clean fields above. Scores, chunk ids, message ids, vector ids, and storage references remain internal diagnostics.
- Lexical mode may omit `query` only for structured `turnNo` lookup. `inspect` resolves `resultNumber`, `turnId`, or `conversationTitle` plus `turnNo` to the full canonical parent. Audit mode remains the exact path for raw execution evidence.
- Deleted conversations and projects remove their LanceDB rows and SQLite diagnostics. No project can retrieve another project's turns through the main contract.
- The Global Memory Agent and Skill Writer use the same modes, limits, LanceDB search, raw audit/inspect paths, parent deduplication, and clean fields. Their only model-facing difference is cross-project selection plus `projectTitle`; `exact`, handles, and old broad trace-document selectors are rejected.
- Global search re-normalizes raw relevance across selected project tables before applying the shared 0.05 recency band. Per-project normalized winners are never merged as artificial ties.

### `tool_docs`

Read-only access to Socrates tool-usage guidance under `~/.Socrates/tool_usage`. Socrates should call this before retrying failed tools, when tool behavior is unfamiliar, or before complex/edge-case use of trace retrieval, Terminal, edit/apply_patch, docs, skills, MCP, or resources.

Input:

```ts
type ToolDocsToolInput = {
  operation: "search" | "read"
  area?: "tool_usage"
  path?: string
  query?: string
  searchMode?: "exact_phrase" | "keyword_all" | "keyword_any" | "whole_word" | "regex"
  limit?: number
  offset?: number
  charLimit?: number
}
```

Rules:

- Search results are bounded snippets. Exact guidance should be read with `operation: "read"` and a returned path.
- The main agent cannot edit tool docs. Backend memory workflows may update tool docs through scoped `edit_files`.

### `memory_note`

Accepted next main-agent tool for sending a simple lead to the Global Memory Agent. This is an agent-to-agent notepad entry, not a complex A2A envelope.

Input:

```ts
type MemoryNoteToolInput = {
  note: string
  importance?: "normal" | "high"
}
```

Output:

```ts
type MemoryNoteToolOutput = {
  noteNumber: number
  status: "open" | "processing" | "done"
  attachedSource: "current_user_message"
  result: "created" | "already_recorded"
}
```

Rules:

- Socrates writes the note in human language and keeps it short.
- Socrates should prefer one clean note per user-turn and may create at most two. The tool description must make this limit explicit so duplicate facts are consolidated before a tool call.
- Socrates should not manually include conversation id, message id, or turn id. The backend attaches those refs from the current turn.
- Socrates should not request a skill, provide a skill name, choose project/global scope, or name the target memory file/section. The Memory Agent owns classification and routing.
- The note is only a lead. The Memory Agent must use `memory_notes.read` and `trace_retrieve` when exact evidence matters.
- The backend normalizes and deduplicates before insert. Equivalent normalized notes return the existing note with `result: "already_recorded"`; a third non-duplicate same-turn note should fail with a recoverable `memory_note_turn_limit_reached` tool error rather than creating a row.
- After a note is accepted, the runtime can expose a compact same-turn save ledger to later continuation calls. This ledger must be appended near the tail of dynamic turn context so the stable system prompt, stable always-apply prelude, and early prompt prefix remain cache-friendly.

Specialized Memory Agent inbox:

```ts
type MemoryNotesToolInput = {
  operation: "list" | "read" | "mark_done"
  limit?: number // list only; capped at 10
  noteNumber?: number
  outcome?: "applied" | "already_represented" | "skipped" | "proposed_skill" // mark_done only
  resolution?: string // mark_done only; one-line closure reason
}
```

`list` returns at most 10 numbered rows with importance, a short note slice, source project/workspace metadata when available, and a default skill-scope hint. `read` returns the full note, source user-message excerpt, and backend lookup refs (`conversationId`, `messageId`, `turnId`) so the Memory Agent can chain into `trace_retrieve`. `mark_done` requires an `outcome` plus a compact human-readable `resolution`. `already_represented` means the durable memory or skill already covers the evidence; `skipped` means the note is weak, project-local, stale, or not durable. These refs are backend-produced lookup values, not fields the sending model authored.

The Memory Agent must classify each note before acting: durable user facts/preferences and global active user context go to `user_profile.md`, rare identity/behavior updates use the identity confirmation flow, reusable procedures may become skill proposals, and weak leads are skipped. Project-specific active context does not belong in global user profile; the Memory Agent should close those notes with a skip resolution because Socrates owns project notes. Mixed turns must be split strictly: global user facts may be profiled, but project-local implementation order, feature sequencing, workspace todos, and active project reminders stay out of `user_profile`. Profile corrections must update both the content section and evidence anchors so stale evidence does not keep supporting the old claim. Socrates-originated notes default to project-local skill scope; the Memory Agent may keep that scope or upgrade a procedural skill proposal to global when it is clearly reusable across projects.

### `skills`

Discovery, inspection, and approval-backed exact-URL installation for reusable workflows from builtin, global, and project skill roots. The normal usage path is `list` then `describe`; `read` opens referenced supporting files. Chat import uses `preview_import` then `commit_import` and shares the dashboard's secure staging and atomic installer.

Input:

```ts
type SkillsToolInput = {
  operation: "list" | "describe" | "read" | "preview_import" | "commit_import"
  scope?: "builtin" | "global" | "project"
  id?: string
  name?: string
  path?: string
  n?: number
  charLimit?: number
  url?: string // preview_import; exact public HTTPS ZIP, max 2,048 chars; mutually exclusive with attachmentPath
  attachmentPath?: string // preview_import; exact current-message .socrates/attachments/*.zip path
  previewId?: string // commit_import; exact staged id
  conflictStrategy?: "reject" | "replace" // commit_import; defaults reject
}
```

Output:

```ts
type SkillsToolOutput = {
  operation: "list" | "describe" | "read" | "preview_import" | "commit_import"
  skills: Array<{
    id?: string
    name: string
    description: string
    scope: "builtin" | "global" | "project"
    path: string
    updatedAt?: string
  }>
  content?: string
  path?: string
  totalMatches: number
  truncation: TruncationMetadata
  usageHint?: string
  warnings?: string[]
  importPreview?: {
    previewId: string
    scope: "global" | "project"
    skill: SkillSummary
    package: { filename: string; fileCount: number; totalBytes: number; sha256: string; files: string[]; filesTruncated: boolean }
    metadata: { license?: string; compatibility?: string; author?: string; version?: string; allowedTools?: string }
    conflict: { exists: boolean; existing?: SkillSummary }
    warnings: Array<{ code: string; severity: "info" | "warning"; message: string; path?: string }>
    warningsTruncated: boolean
    expiresAt: string
  }
  replaced?: boolean
}
```

Rules:

- `list` returns compact current rows with exact ids/names/scopes/descriptions. It should default to a bounded count and allow `n` up to the schema cap.
- `describe` requires either an exact `id` copied from `list` or an exact listed `name`. Prefer canonical `id`.
- Do not copy a display name into `id`, and do not pass both `id` and `name` unless both values come from the same listed skill row.
- The runtime must not inject hidden matched skill ids/descriptions by grepping the user prompt.
- The main Socrates agent cannot author, edit, or delete skills through this tool. It may install a pre-authored package only through `preview_import` followed by approval-required `commit_import`; authored skills and Memory Agent proposals still route through the Skill Writer Agent.
- `read` requires an exact listed skill id/name plus a normalized relative supporting-file path. The backend resolves it inside that skill directory and never exposes the internal `.socrates-skill.json` provenance file.
- The Memory Agent and Skill Writer Agent must be able to inspect full existing `SKILL.md` content before making or applying exact updates. If output is truncated, they should request the full content before deciding the edit. The backend classifies the proposal as `update` whenever the canonical scoped target exists, even if the model supplied a create-style edit verb.
- Global skills are visible to every project. Project skills are visible only in that project's active workspace.
- `preview_import` accepts exactly one exact user-supplied public HTTPS ZIP URL or exact current-message `.socrates/attachments/*.zip` path. It is not web search. URL downloads have a 30-second timeout, five-redirect limit, 30 MB cap, and public-address validation on every hop. Attached skill ZIPs are allowed by the chat attachment pipeline up to the 20 MB per-message cap and must be attached to the current conversation turn. Both use the existing no-execution ZIP inspection. Model output exposes at most 30 file paths and 10 warnings with explicit truncation flags.
- `commit_import` defaults to project scope and reject-on-conflict, requires normal approval, and can install only its exact unexpired scope/project/workspace-bound preview. `replace` is valid only when the user explicitly requested replacement. Socrates must verify with list/describe before claiming success.
- Memory Agent skill proposal notifications include `scope` and, for project skills, the project id/name. Skill names should be human-facing slugs, not random ids or test suffixes.

### Skill Writer Agent Internal Write Path

The Skill Writer Agent is a specialized agent, not a UI helper and not a hidden fourth model behind a tool. It receives approved create/update tasks from the user flow or Memory Agent, reads the relevant context, authors the final markdown, and calls `skill_write`.

Both direct dashboard creation flows use this same production path. Project `Skills +` resolves the project's primary workspace and writes only to `<workspace>/.socrates/skills/<name>/SKILL.md`; Memory Center `Skills +` writes only to `~/.Socrates/skills/<name>/SKILL.md`. Neither flow may bypass the configured `skill_writer` worker model with a one-off provider stream or hand-authored backend fallback.

The same `Skills +` dialogs expose `Import ZIP`, which deliberately bypasses the Skill Writer because it preserves a pre-authored portable package rather than generating instructions. Preview endpoints accept one multipart ZIP and return `SkillImportPreview`; commit endpoints accept `{ previewId, conflictStrategy: "reject" | "replace" }`. Global routes are `/api/memory-agent/skills/import/preview|commit`; project routes are `/api/projects/:projectId/skills/import/preview|commit`. State routes PATCH `.../skills/:skillName/state` with `{ enabled }`. Preview ids are destination-bound, expire after 24 hours, and cannot be committed into another scope/project/workspace. The UI must show conflicts, package metadata, bounded file inventory, and every security warning before install.

```ts
type SkillWriteInput = {
  scope: "global" | "project"
  operation: "create" | "update"
  name: string
  content: string
  changeSummary: string
  evidenceTurnIds?: string[] // max 12; exact approved evidence
  files?: Array<{ path: string; content: string }> // references/, scripts/, assets/ only
}
```

Rules:

- `skill_write` validates and saves a substantive procedural `SKILL.md`; it does not interpret product intent. Supporting files are optional and confined to normalized relative paths under `references/`, `scripts/`, or `assets/`; traversal, duplicates, and unresolved relative Markdown links are rejected.
- Memory-originated jobs must inspect every approved source turn and cite the exact ids in `evidenceTurnIds`. Updates must read the exact canonical `<scope>:<name>` skill first. No-op updates are rejected.
- Skill summaries use canonical scoped ids (`builtin:<name>`, `global:<name>`, or `project:<name>`). Exact-name lookup remains backward compatible, but callers should use listed canonical ids to avoid cross-scope collisions.
- The Skill Writer Agent should always perform approved tasks unless validation, read, or write tooling fails.
- If an approved attempt ends without calling `skill_write`, the job runner performs one bounded repair attempt with the same enforcement. It never generates fallback skill content in backend code.
- It should have narrow read tools only: `trace_retrieve`, `skills`, read-only `user_profile`, read-only `soul`, and read-only project/repo docs for project skills.
- It must not receive Terminal, arbitrary filesystem writes, identity/profile writes, project/repo docs writes, or raw path mutation tools.

### Worker Model Settings

Skill Writer, Context Compactor, Title Generator, Memory Router, and Frontier model settings are user-configurable through `/api/worker-model-settings`. The Settings page should show polished registry-backed model/thinking selectors for these workers while preserving the default models already used by the app. Memory Router controls the structured pre-turn and post-evidence routing calls. Frontier controls the one-way same-task takeover target.

All model settings are auth-mode-aware. `authMode = "api_key"` means normal provider API credentials or a local direct provider path such as Ollama. `authMode = "chatgpt_subscription"` is currently valid only for OpenAI ChatGPT Codex subscription auth. Saved unavailable settings are preserved, and runtime/UI resolution returns an effective fallback without overwriting the saved row. Ollama settings are valid when the exact discovered local model is still available; Ollama thinking options are intentionally just Off and On.

```ts
type WorkerModelRole = "skill_writer" | "context_compactor" | "title_generator" | "memory_router" | "frontier"

type WorkerModelSettings = {
  workerId: WorkerModelRole
  providerId: "openai" | "google" | "openrouter" | "ollama"
  authMode?: "api_key" | "chatgpt_subscription"
  modelId: string
  thinkingEnabled: boolean
  thinkingEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  updatedAt: string
}

GET /api/worker-model-settings
  -> { settings: WorkerModelSettings[] }

PATCH /api/worker-model-settings/:workerId
  body { providerId, authMode?, modelId, thinkingEnabled, thinkingEffort? }
  -> { settings: WorkerModelSettings }
```

The built-in Memory Router default is OpenRouter `deepseek/deepseek-v4-flash` with thinking off. When ChatGPT Codex is connected and the saved router setting is the built-in default or unavailable, the effective runtime default is ChatGPT Codex `gpt-5.4-mini` with low reasoning. Its token/cost usage should be counted in normal turn/conversation totals through `ai_usage_events`; the frontend does not need a separate router-cost display.

The built-in Frontier default is OpenRouter `x-ai/grok-4.5` with low reasoning. OpenRouter marks this model's reasoning as mandatory and rejects disabled/none requests, so the registry exposes only Low, Medium, and High and normalizes a stale unsupported saved choice to Low. `handover_to_frontier` accepts `{ focus?: string }`, where focus is at most 20 words and 160 characters. Every call emits a normal `approval.requested` event with the user-facing title `Call Frontier model`, target-model description, and compact focus preview. Approval persists the accepted tool call and `agent.model.handover`; the driver and Frontier use separate `model_calls` under the same turn, driver answer text from the transfer step is discarded, and Frontier's answer is the only final answer. Rejection persists the rejected approval/tool call, exposes no `agent.model.handover`, removes the tool from later calls in that turn, and adds a developer instruction for the driver to continue itself. A later user-authored turn uses the main selected chat model again.

Memory Router contract:

```ts
type MemoryReadTarget = {
  surface: "project_notes" | "project_memory" | "repo_docs" | "user_profile" | "identity"
  fileName: MemoryRetrievalFile
  sectionId: MemoryRetrievalSection
  reason: string
}

type MemoryRouterPreTurnResult = {
  readTargets: MemoryReadTarget[] // max 8
  reason: string
}

type MemoryReconciliationAction = {
  operation: "upsert" | "replace" | "remove" | "archive" | "condense"
  surface: "project_notes" | "project_memory" | "repo_docs"
  fileName: MemoryRetrievalFile
  sectionId: MemoryRetrievalSection
  instruction: string // max 1,200 characters
  reason: string // max 500 characters
  evidenceReferences: string[] // max 5 backend-created evd_ ids
  capabilityId?: string
  verifiedRuntime?: string
  verifiedAt?: string
}

type MemoryRouterPostTurnResult = {
  actions: MemoryReconciliationAction[] // max 5
  reason: string
}
```

The behavior stays simple and human-facing:

- Pre-turn routing returns exact valid file/section read targets, not boolean surfaces or loose doc hints.
- Pre-turn runtime loads bounded identity sections (`core_identity`, `voice_and_presence`, `relationship_to_user`) plus global/project always-apply sections into one backend-owned per-project snapshot and renders it with the registry-generated surface map into a provider-agnostic stable cache prelude before conversation/user text. A stat fast path avoids re-reading unchanged files; changed files are content-hashed and parsed, but same-content rewrites or changes outside these standing sections retain the cached snapshot. Only a changed standing-section hash replaces it. The bounded cache uses least-recently-used eviction. This path emits no standing-section tool calls and does not depend on successful structured Memory Router generation. Router targets matching standing sections and exact repeated dynamic targets are hard-deduplicated; only dynamic docs remain in the later visible context tail.
- Before router reasoning, the complete user prompt is shared-chunked and automatically hybrid-prefetched against eligible memory sections. Up to 12 prompt segments are merged into at most eight section parents; this does not consume the router's tool budget.
- The pre-turn router has `memory_search` only for routing and is strictly read-only. The final router may also use `turn_evidence` to inspect backend-created references, with at most three total drill-down calls before strict Zod output. Malformed structured output gets one bounded validation-feedback repair attempt. `project_notes/runtime_context` and `project_notes/state_ledger` are backend-owned and rejected as reconciliation actions.
- If either router phase still fails, the backend persists a `memory_router` error plus every usage item already observed as failed `ai_usage_events` with phase/error metadata, then lets the ordinary task continue. Socrates is told not to claim routed recall or reconciliation succeeded. No durable retry/pending-reconciliation subsystem is created.
- The Global Memory Agent follows the same tool-loop then structured-final pattern. Its final Zod journal has bounded `summary`, `patternsObserved`, `skillsAffected`, `decisions`, `openInvestigations`, and `nextRunFocus`; scoped file/proposal work remains normal internal tool calls. A valid successful run creates one `memory_agent_journal` row and refreshes the generated Memory Agent Ledger file exposed by Memory Center.
- The Memory Agent-only `read_memory_journal` tool is read-only. `list` defaults to 5 and caps at 10 compact previews; `read` accepts one run id. Character limits default to 8,000 for list serialization and 12,000 for a run, with a 20,000 hard maximum and explicit truncation metadata. It cannot write, delete, search, or embed journal history.
- The router never authors `oldText`, `newText`, patches, hashes, or evidence ids. `evd_` ids are created and task-bound by backend code.
- Every user request creates one durable task. Automatic Terminal wait/resume turns stay inside that task; a user-authored follow-up starts a new task.
- The first no-tool answer is held as a proposed draft. The final router runs only there, with bounded lifecycle evidence and that draft.
- Socrates opens exact planned targets and uses `project_docs` or `repo_docs` for mutations. The runtime blocks the final answer until every planned target has a successful mutation followed by a successful read of that same section.
- Stale claims are replaced, removed, archived, or condensed rather than contradicted by append-only prose. Verified runtime capability entries may include stable `capability`, `verified_runtime`, and `verified_at` anchors.

### `project_docs`

Constrained read/search/edit access to the active workspace's `.socrates/MEMORY.md` and `.socrates/PROJECT_NOTES.md`.

Input:

```ts
type ProjectDocsToolInput = {
  operation: "read" | "search" | "edit" | "read_index" | "read_section" | "patch_section"
  area: "memory" | "notes"
  sectionId?: string
  editMode?: "append" | "replace"
  oldText?: string
  newText?: string
  text?: string
  replaceAll?: boolean
  charLimit?: number
}
```

Every `project_docs` output may include `runtime?: RuntimeTimeMetadata` with backend-owned current date/time metadata.

Rules:

- `area: "memory"` is durable cross-conversation project state: goals, decisions, constraints, blockers, durable preferences, changed workflow facts, and handoff facts.
- Project memory should include a human-readable `Project Always-Apply Rules` section capped at 10 rules. Together with `user_profile`'s `Global Always-Apply Rules`, this forms the centralized always-apply rules list attached to every applicable turn through the stable cache prelude. The project section is for short hard project rules only; fuller repo doctrine still belongs in `repo_docs`.
- `area: "notes"` is the active assistant notebook: active project context, current todos, checked files, partial progress, next commands, and short-term restart points. `runtime_context` and `state_ledger` are backend-owned protected sections; the state ledger is rewritten from structured turn data and deduplicated to one bounded block.
- Runtime docs are structured markdown with YAML frontmatter and `socrates:section` markers. `read_index` returns the parsed section map; `read_section` returns one section; `patch_section` limits an exact oldText/newText replacement to one section.
- `runtime_context` is system-owned. `project_docs` rejects attempts to patch or change it. It may contain compact workspace scan facts, but must not persist terminal output, live terminal state, dependency dumps, package lists, or root-script inventories.
- Successful `project_docs` edits stamp YAML frontmatter with backend-owned `updated_at`, `updated_by`, and `last_edited_section`.
- Generic `edit` and `apply_patch` writes to these files are rejected; use `project_docs`.
- After meaningful workspace work, the runtime may inject a docs checkpoint requiring a `project_docs` memory update before final when no durable memory update happened.

### `soul`

Read-only access to the core agent identity document. This tool exists because identity, voice, operating principles, safety boundaries, and tool/memory discipline are special runtime context, not ordinary searchable memory pages.

Input:

```ts
type SoulToolInput = {
  operation: "read" | "read_index" | "read_section"
  sectionId?: string
  charLimit?: number
}
```

Output:

```ts
type SoulToolOutput = {
  operation: "read" | "read_index" | "read_section"
  path: "identity.md"
  content?: string
  index?: MemoryDocIndex
  section?: MemoryDocSection
  truncation: TruncationMetadata
  warnings?: string[]
}
```

Rules:

- `soul` can only read `~/.Socrates/identity.md`.
- Socrates should prefer `read_index` before full `read`, then use `read_section` for focused context. Full `read` is capped at 8,000 chars and `read_index`/`read_section` are capped at 10,000 chars even if the caller requests a larger `charLimit`.
- The main agent cannot edit this file through model-visible tools. Identity updates are proposed and applied only by the backend memory agent through verified patches.
- A proposed soul update must create a confirmation record and run the exact prompt `You are about to make changes to the soul. Are you sure?` followed by `Reply exactly yes or no.` Only an exact normalized `yes` applies the patch.
- Applied soul updates create durable notifications with rationale and compact diff payloads.

### `user_profile`

Read-only access to `~/.Socrates/user_profile.md`, which stores durable cross-project user profile facts and stable user preferences. It supports `read`, `read_index`, and `read_section` with the same focused section output shape, index-first guidance, and char-limit caps as `soul`. The main Socrates agent should call this before answering user-profile/preference questions. Only the backend memory agent can update this file through scoped `edit_files`.

`user_profile` should include a `Global Always-Apply Rules` section capped at 10 rules. This is the global lane of the centralized always-apply rules list and should contain only hard cross-project user preferences or constraints that Socrates must attach every turn through the stable cache prelude. It is not for ordinary profile facts, temporary user-life context, or project-specific workflow instructions.

Primary `identity.md` and `user_profile.md` migrations are special-cased: unlike ordinary structured markdown migrations, they must not preserve a generic `legacy_content` section. Startup normalization routes legacy headings into the canonical primary sections, removes old scaffolding placeholders, strips duplicate inner markdown headings, and compacts obvious duplicate migrated bullets before Memory Center exposes the files. `user_profile.evidence_index` is a compact source-anchor section for important profile claims, using dates, project/conversation titles or ids, turn/message/event ids when available, the supported claim, and the profile section using that claim.

### `repo_docs`

Constrained read/search/edit access to durable workspace doctrine under `.socrates/repo_docs/`. Generic `edit` and `apply_patch` writes to these files are rejected; normal read/search may still inspect them.

Input:

```ts
type RepoDocsToolInput = {
  operation: "read" | "search" | "edit" | "read_index" | "read_section" | "patch_section"
  path?: "CORE_IDEA.md" | "REPO_NAVIGATION.md" | "REPO_RULES.md" | "CONTRACTS.md"
  sectionId?: string
  query?: string
  oldText?: string
  newText?: string
  replaceAll?: boolean
  charLimit?: number
}
```

Every `repo_docs` output may include `runtime?: RuntimeTimeMetadata` with backend-owned current date/time metadata.

Rules:

- Project access creates missing template files only; existing user-edited repo docs are preserved.
- Runtime repo docs are structured markdown with YAML frontmatter and stable section ids.
- Prefer `read_index`, then `read_section` or `patch_section`, for focused doctrine lookup and updates.
- Successful `repo_docs` edits stamp YAML frontmatter with backend-owned `updated_at`, `updated_by`, and `last_edited_section`.
- Whole-file `read`, `search`, and constrained `edit` remain fallback operations.
- `read` with no path returns a bounded index of the four docs.
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

### `mcp_registry`

Model-facing discovery, validation, and approval-backed lifecycle management for MCP servers available to Socrates. `list`/`describe`/`check` are automatic; `configure`/`delete` require user approval. The UI/API also owns JSON/TOML parsing, manual setup, edit, enable/disable, persistent status, config-file open, and delete.

Input:

```ts
type McpRegistryToolInput =
  | {
      operation: "list"
      n?: number
    }
  | {
      operation: "describe"
      id?: string
      name?: string
      n?: number
    }
  | { operation: "check"; id: string; enableOnSuccess?: boolean }
  | {
      operation: "configure"
      scope?: "project" | "global"
      server: {
        id: string
        label?: string
        command: string
        args?: string[]
        env?: Record<string, string>
        secretBindings?: Array<{
          envKey: string
          source: "user_input" | "workspace_env"
        }>
      }
    }
  | { operation: "delete"; scope?: "project" | "global"; id: string }
```

Output:

```ts
type McpRegistryServer = {
  id: string
  name?: string
  label: string
  description?: string
  scope?: "global" | "project"
  configured: boolean
  enabled: boolean
  bundled?: boolean
  requiresSecrets: boolean
  status: "available" | "missing" | "failed" | "unknown"
  toolCount?: number
  lastCheckedAt?: string
  lastError?: string
  toolPreview?: string[]
  moreToolsAvailable?: boolean
  warnings?: string[]
}

type McpRegistryToolOutput = {
  operation: "list" | "describe" | "check" | "configure" | "delete"
  configPath: string
  envPath: string
  servers?: McpRegistryServer[]
  server?: McpRegistryServer
  tools?: Array<{
    name: string
    dynamicName: string
    description?: string
    inputSchema?: unknown
  }>
  docs?: string
  summary: string
  usageHint?: string
  warnings?: string[]
}
```

`unknown` is a valid backend state meaning that no persistent health-check result exists yet; it does not imply that a server or its cached tools are broken. The MCP panel intentionally renders no badge for `unknown`. It renders badges only for `available`, `failed`, or `missing`, while independently showing a known `toolCount`.

Rules:

- `list` returns compact global plus project-visible servers with canonical ids, names/labels, descriptions, scopes, and only a short tool preview.
- `describe` requires an exact listed `id` or exact listed `name`; prefer canonical `id`.
- If both `id` and `name` are provided, they must resolve to the same listed server. Otherwise the tool returns a constructive recoverable error.
- Describing a server loads only that server's docs and exposes its dynamic `mcp__...` tool definitions for later provider calls in the same turn.
- Configure/delete always use the mutation lane and normal approval surface. Configure accepts only exact user-supplied or trusted stdio commands. The model may declare secret key names and a semantic source through `secretBindings`, but its strict schema rejects `secretEnv` and every plaintext secret value. After approval, the UI receives one `credential.input.requested` event at a time and replies with `credential.input.submit`; the server emits only safe requested/resolved metadata, keeps the value in the active waiter, and passes it privately to the MCP runtime. Multiple bindings and multiple configure calls remain sequential through the mutation lane. `workspace_env` is permitted only when the user explicitly requested reuse of that exact key; if it is absent, the flow falls back to user input. Configure forces the initial save disabled, performs initialize plus tools/list inside the approved call, and enables only on success.
- Check launches project servers from the project workspace and persists health/tool-count metadata without changing enablement. The HTTP dashboard flow may explicitly request enable-on-success after its own user-initiated save.
- UI import accepts common JSON `mcpServers`/`servers` and Codex TOML `mcp_servers`; remote HTTP/SSE entries receive a clear unsupported-transport error until those transports are implemented.
- Secret values are written with private permissions to the scope's `.env`; `mcp.json` stores only `secretKeys`. GET config responses expose existing key names with blank values, and blank dashboard updates preserve the existing private value. Generic workspace `read`, `search`, and Terminal calls reject real env/private-key material; safe env templates remain readable. Persisted events, approvals, tool arguments/results, trace rows, provider requests, and `mcp.json` must never contain the value. Deleting a server removes only secret keys not referenced by another server.
- `GET /api/mcp` returns the selected scope's config/env paths. The panel provides copy/open actions, manual editing with immutable ids, and add/check/enable/delete controls.
- MCP server tool lists and schemas must not be dumped into the system prompt or first provider-call schemas.
- Global MCP servers are inherited by all projects. Project MCP servers are visible only in that workspace. Bundled Playwright is protected from deletion and should be discoverable for browser/web/page/screenshot tasks.

## Context Carry-Forward Rule

Within one turn, Socrates may pass current-turn tool calls and tool results back to the model until the final answer is reached.

Across later user queries, Socrates should not pass the full historical tool-call dump by default. The normal model context should carry forward:

```text
previous user query
previous final assistant answer
new user query
current-turn tool calls only
```

When the context grows too large, compression happens before a provider request is sent. The V1 trigger is 170k estimated model-visible input tokens. The rebuilt request has an 80k preferred soft target, with at most 60k classified `excellent`, 60-80k `preferred`, 80-120k `acceptable`, and anything above the 120k post-compaction ceiling rejected. The 180k limit remains the hard pre-provider ceiling. Tail selection keeps recent whole turns only within the remaining preferred budget after reserving fixed prompt/tool context, the active turn, and the maximum summary allowance; it does not spend another model call solely to improve the size class. This includes long conversations, long single-turn tasks, and backend Global Memory Agent runs. Recent visible conversation turns should still be sent as normal role-typed messages. Older same-conversation history, bulky current-turn tool evidence, and important decisions may be represented in hidden compacted context with validated source-turn handles and targeted lexical/semantic/audit retrieval hints. Active snapshots replace represented raw turns in the model request without deleting SQLite history. Bounded deterministic carryover writes exact `.socrates/attachments/...` paths to `relevantFiles`, exact shell commands to `toolState`, and explicit unresolved/do-not-complete user instructions to `blocked`. Global Memory Agent runs use the memory-specific structured compaction schema and prompt. The compressor model comes from the resolved Context Compactor worker setting; built-in OpenRouter defaults must resolve away from OpenRouter when only ChatGPT Codex or another provider auth source is available.

Inline `chat.message.send.content` is capped at 10,000 characters and one message may contain at most 15 attachment ids. Oversized pasted text is uploaded as a `text/plain` attachment under `.socrates/attachments/`; the provider sees a compact name/path/hash/size provenance manifest, not the full bytes, until Socrates explicitly reads or searches that source. Image and text attachments are each capped at 5 MB and the combined message attachment payload is capped at 20 MB.

If older conversation memory is needed, the agent should call normal `trace_retrieve` explicitly. If older runtime evidence is needed, it should retry with `mode = "audit"`. Full raw history remains persisted in SQLite for audit and replay.

`trace_retrieve` is also the source fallback for compacted context. Context summaries should point to a turn id for full Q&A inspection or provide a focused audit query for tool/shell/file/patch/error evidence.

Provider-exposed thinking or reasoning text is stored for UI/replay when exposed, but it is not carried forward as semantic context between later user queries. Reasoning token counts belong in usage and context accounting, not prompt history.

Provider-specific opaque tool-call metadata needed to continue the current tool loop, such as Gemini thought signatures, may be carried only inside the active turn's in-memory model messages. It must not be loaded into later user turns as semantic history.

Compression outputs must not be written as visible `messages`. If the frontend loads conversation history through HTTP, it should continue to receive real user and assistant messages plus persisted tool runs, not hidden compaction summaries as fake chat turns. New compaction snapshots must validate against the shared structured schemas before activation; malformed parseable JSON or old legacy snapshot shapes must not become active context.

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

V2 work follows the same contract-first rule inside its namespace. It must also add a V1 regression assertion: with the V2 feature flag disabled, existing V1 HTTP responses, WebSocket commands/events, persistence writes, and frontend behavior remain unchanged.

When a field, endpoint, command, or event changes:

1. Update this document.
2. Update `packages/contracts`.
3. Update backend validation/emission.
4. Update frontend consumers.
5. Add or update focused tests for the changed contract.
