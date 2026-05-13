# Socrates Frontend Backend Contract

This document is the handshake between the frontend and backend workstreams.

Both sides must build against this contract. The backend owns persistence, agent execution, providers, tools, approvals, and WebSocket event emission. The frontend owns routes, screens, user interactions, rendering, local view state, and event presentation.

The shared source of truth should eventually live in `packages/contracts` as TypeScript types and schemas. This document defines the V1 contract before implementation begins.

## Contract Goals

The contract must make parallel work possible:

```text
frontend can build against mocked responses and events
backend can implement real endpoints and event streams
both sides integrate without inventing new shapes
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
| `/projects/new` | Create project | `POST /api/projects` |
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
  status: "active" | "processing" | "failed" | "archived" | "deleted"
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

## HTTP Endpoints

V1 endpoints:

```text
GET    /api/me
POST   /api/onboarding

GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId

GET    /api/projects/:projectId/resources
POST   /api/projects/:projectId/resources

GET    /api/projects/:projectId/conversations
POST   /api/projects/:projectId/conversations
GET    /api/projects/:projectId/conversations/:conversationId
```

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

### `GET /api/projects`

Returns projects for the local user.

```ts
type ListProjectsResponse = {
  projects: Array<{
    project: Project
    primaryWorkspace?: ProjectWorkspace
    conversationCount: number
    lastActivityAt?: string
  }>
}
```

### `POST /api/projects`

Creates a project.

```ts
type CreateProjectRequest = {
  name: string
  description?: string
  creationMode: "start_from_scratch" | "existing_folder"
  workspacePath?: string
}
```

Response:

```ts
type CreateProjectResponse = {
  project: Project
  primaryWorkspace?: ProjectWorkspace
}
```

### `GET /api/projects/:projectId`

Loads the project dashboard.

```ts
type GetProjectResponse = {
  project: Project
  primaryWorkspace?: ProjectWorkspace
  resources: ProjectResource[]
  conversations: Conversation[]
  instructions?: {
    id: string
    content: string
    updatedAt: string
  }
}
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

## WebSocket Connection

The chat page opens one WebSocket connection for live agent events.

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
    thinkingEffort?: "none" | "low" | "medium" | "high" | "xhigh"
    approvalMode: "manual" | "approve_all" | "read_only_auto"
    sandboxMode: "read_only" | "workspace_write" | "danger_full_access"
  }
}
```

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
  toolName: string
  category: "file" | "search" | "shell" | "git" | "patch" | "resource" | "other"
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

## Mocking Agreement

The frontend may use mocked responses and mocked WebSocket events during early development.

Mocks must match this contract exactly.

If the frontend needs a new field or event, update this document first, then update `packages/contracts` when implementation begins.

## Implementation Order

Recommended order:

1. Create `packages/contracts` with shared schemas and types from this document.
2. Create HTTP route stubs that return contract-shaped responses.
3. Create WebSocket connection with `connection.ready`.
4. Create frontend pages against mocked or stubbed data.
5. Implement project/onboarding persistence.
6. Implement conversation creation.
7. Implement V1 chat WebSocket events.
8. Implement tool-call events and approval events.
