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
8. Only one active turn may run per conversation at a time in V1.

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
  status: "streaming" | "completed" | "failed" | "cancelled"
  createdAt: string
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

POST   /api/workspaces/pick-folder

GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId

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

### `POST /api/projects`

Creates a project and attaches a required local workspace folder.

```ts
type CreateProjectRequest = {
  name: string
  description?: string
  creationMode: "start_from_scratch" | "existing_folder"
  workspacePath: string
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
  -> create workspacePath/.socrates/resources/

start_from_scratch
  -> create workspacePath if missing
  -> create workspacePath/.socrates/resources/
```

The backend must not edit the workspace root `.gitignore` in V1.

Response:

```ts
type CreateProjectResponse = {
  project: Project
  primaryWorkspace: ProjectWorkspace
}
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
}
```

Frontend display behavior:

```text
project.description is stored in full but shown as a bounded dashboard preview
instructions.content is stored in full but shown as a bounded panel preview
resource previews are shown in a bounded scrollable panel
dashboard start-chat action creates a conversation before routing to chat
conversation rows show an actions menu with rename and delete
```

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
  tokenUsage: {
    totalTokens: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
  }
}
```

`toolRuns` contains persisted, bounded tool activity for completed turns in this conversation. It is for frontend replay/audit UI only; it is not automatically fed back into later model prompts.

Frontend behavior:

```text
if messages is empty:
  show centered empty-chat composer
else:
  render transcript, historical inline tool timeline, and pin composer to the bottom
show tokenUsage.totalTokens next to the conversation title
update the displayed total after completed assistant turns
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
delete conversations row
emit conversation.deleted event before the final conversation row delete or as a project-scoped event
```

This endpoint must not archive the conversation and must not set `conversations.status = "deleted"` in the current V1 flow. It must not delete project resources, project instructions, or the owning project.

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
  update the title from the first word of the message
```

Title derivation:

```text
first word length <= 10 -> title = first word
first word length > 10 -> title = first 10 characters + "..."
```

Frontend behavior:

```text
normal chat send uses WebSocket chat.message.send, not this endpoint
after the first message is saved, move composer from centered state to bottom state
append the returned user message to the transcript
refresh local conversation title from the response
```

## WebSocket Connection

The chat page opens one WebSocket connection for live agent events.

The current chat UI sends user messages through `chat.message.send`. The backend creates/reuses the session, stores the user message, creates the running turn, persists the runtime config, loads model-facing history from prior user messages and final assistant answers, injects backend-owned Socrates prompt context, and calls `packages/core`.

Suggested URL:

```text
/ws
```

The frontend should identify the active project and conversation in the first command.

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
chat.message.send
chat.turn.cancel
approval.decide
feedback.submit
```

### `chat.message.send`

Starts a new turn from a user message.

If the conversation already has an active turn, the backend must reject the command with error code:

```text
turn_already_active
```

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
  toolName: "read" | "search" | "edit" | "bash" | "trace_retrieve" | "list_project_resources"
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
bash
trace_retrieve
list_project_resources
```

Do not expose separate `glob`, `grep`, `write`, `patch`, `git`, `todo`, `skill`, `question`, `webfetch`, or sub-agent/task tools in the initial tooling phase. Internal implementation helpers may be more granular, but the model-visible surface should remain the six tools above.

All tool schemas live in `packages/contracts`. `packages/core/tools` owns the model-visible tool wrappers and registry. `packages/workspace` owns filesystem, document parsing, image extraction, shell, git, patch, and trace implementation details.

### `read`

Reads local workspace content.

Input:

```ts
type ReadToolInput = {
  targets: Array<{
    path: string
    startLine?: number
    endLine?: number
    page?: number
    charLimit?: number
    recursive?: boolean
    depth?: number
  }>
}
```

Output:

```ts
type ReadToolOutput = {
  entries: Array<{
    path: string
    kind: "file" | "directory" | "image" | "pdf" | "document" | "presentation" | "data" | "other"
    mimeType?: string
    sizeBytes?: number
    content?: string
    children?: Array<{ path: string; kind: "file" | "directory"; sizeBytes?: number }>
    page?: number
    startLine?: number
    endLine?: number
    image?: { width: number; height: number; description?: string; text?: string }
    truncated: boolean
  }>
}
```

Rules:

- Default `charLimit` is 20,000 characters.
- Normal backend per-call cap is 80,000 characters.
- Output must include `truncated = true` when content is cut.
- PDFs, documents, slide decks, structured data, and images must be extracted into bounded text or visual descriptions with metadata.
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
- Search respects `.gitignore` by default.
- Search ignores `.git`, dependency folders, generated outputs, binary files, and large nuisance files by default unless explicitly included.
- Results must be bounded with clear truncation metadata.

### `edit`

Creates or changes files.

Input:

```ts
type EditToolInput = {
  operations: Array<
    | { kind: "create"; path: string; content: string; createDirs?: boolean; ifExists?: "error" | "overwrite" }
    | { kind: "overwrite"; path: string; content: string }
    | {
        kind: "replace"
        path: string
        oldText: string
        newText: string
        expectedOccurrences?: number
        replaceAll?: boolean
      }
    | { kind: "patch"; diff: string }
  >
  reason?: string
}
```

Output:

```ts
type EditToolOutput = {
  changedFiles: Array<{ path: string; operation: "created" | "overwritten" | "edited" | "patched" }>
  diff: string
}
```

Rules:

- Requires approval unless the user explicitly runs a full-access mode.
- Must show a diff or equivalent preview before applying.
- For requests to write code, create scripts, build small programs, implement files, or build a small app/tool, the agent should treat the request as a workspace file creation/edit request. It should use `edit` by default, choose a sensible path when obvious, ask one concise question only when destination/language/intent is genuinely ambiguous, and avoid pasting a full runnable file into chat. Inline code is appropriate only when the user explicitly asks for a snippet or when no write-capable workspace is available.
- Precise replacements must fail with helpful errors when `oldText` matches zero times or more times than expected.
- File mutations are serialized: only one mutation tool call may execute at a time per project workspace.
- Writes outside the active project workspace are denied by default.
- Sensitive paths such as `.env`, private keys, credentials, and secrets require explicit high-risk approval or are denied by policy.

### `bash`

Runs shell commands from the project workspace.

Input:

```ts
type BashToolInput = {
  command: string
  cwd?: string
  timeoutMs?: number
  charLimit?: number
}
```

Output:

```ts
type BashToolOutput = {
  command: string
  cwd: string
  exitCode: number | null
  signal?: string
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncation: TruncationMetadata
}
```

Rules:

- Default timeout is 120,000 milliseconds.
- Bash uses one non-interactive shell process per active turn. The shell keeps `cwd` and exported environment between bash calls in that turn and is disposed when the turn completes, fails, or is cancelled.
- Commands run one at a time. Obvious interactive/TTY commands are rejected or time out; stdin prompt UI is not part of V1.
- If a bash command times out, the active shell session is reset before later bash calls.
- Command output must stream through `tool.call.output`.
- Returned stdout/stderr must be truncated when large, with full output persisted for later retrieval.
- `cwd` must stay inside the active project workspace unless explicitly approved.
- Read-only commands can be auto-allowed by policy.
- Package installation, dev servers, Docker, network commands, git mutations, deletes, migrations, and commands with side effects require approval by default.
- Destructive or credential-exfiltration patterns are denied by default.
- `read`, `search`, and `edit` are preferred for structured file work, but `bash` is allowed as an approved fallback when those tools fail or are insufficient.
- Commands such as `cat`, `find`, `grep`, `pdftotext`, or other local extractors should not be denied solely because an equivalent Socrates tool exists. The backend should rely on approval, workspace scoping, timeout, command policy, and output truncation to keep them controlled.

### `trace_retrieve`

Retrieves old tool traces and execution evidence only when useful.

Input:

```ts
type TraceRetrieveToolInput = {
  query?: string
  since?: string
  until?: string
  turnIds?: string[]
  toolNames?: Array<"read" | "search" | "edit" | "bash" | "trace_retrieve" | "list_project_resources">
  paths?: string[]
  includeInputs?: boolean
  includeOutputs?: boolean
  charLimit?: number
}
```

Output:

```ts
type TraceRetrieveToolOutput = {
  traces: Array<{
    turnId: string
    toolCallId: string
    toolName: string
    summary: string
    paths?: string[]
    command?: string
    inputs?: unknown
    outputs?: unknown
    createdAt: string
    truncated: boolean
  }>
}
```

Rules:

- Retrieval is project-scoped by backend code, not by model-provided ids.
- Use structured filters first: project, conversation, turn, tool name, file path, and date/time.
- Keyword search over commands, paths, errors, and summaries is part of V1.
- Semantic search over trace summaries and diary entries can be added later.
- Raw tool inputs/outputs are returned only when requested and bounded by `charLimit`.

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
- It must use backend project resource records, not shell directory scanning.
- Deleted resources are always excluded from the model-visible tool.
- `limit` defaults to 25 and has a backend/schema cap of 100.
- The model should prefer this tool before probing `.socrates/resources/` with shell commands.
- Returned resource `uri` values should be sufficient for a follow-up `read` call when the resource is file-backed.

## Context Carry-Forward Rule

Within one turn, Socrates may pass current-turn tool calls and tool results back to the model until the final answer is reached.

Across later user queries, Socrates should not pass the full historical tool-call dump by default. The normal model context should carry forward:

```text
previous user query
previous final assistant answer
new user query
current-turn tool calls only
```

If older tool evidence is needed, the agent should call `trace_retrieve` explicitly. Full traces remain persisted in SQLite for audit and replay.

Provider-exposed thinking or reasoning text is stored for UI/replay when exposed, but it is not carried forward as semantic context between later user queries. Reasoning token counts belong in usage and context accounting, not prompt history.

Provider-specific opaque tool-call metadata needed to continue the current tool loop, such as Gemini thought signatures, may be carried only inside the active turn's in-memory model messages. It must not be loaded into later user turns as semantic history.

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
