# Socrates Repo Structure

This document is the source of truth for the current Socrates repo structure. Socrates is a local-first coding agent with a web frontend, a backend runtime, a reusable agent core, provider-agnostic model access, and a clean workspace capability layer.

## Current Shape

```text
Socrates/
  apps/
    web/
      src/
        app/
          welcome/
          onboarding/
          projects/
        components/
          chat/
        hooks/
        lib/

    server/
      src/
        index.ts
        app.ts
        config.ts
        db/
        http/
        routes/
          httpRoutes.ts
        services/
          store.ts
          store/
        test/
        ws/
          websocket.ts
          activeTurns.ts
          eventSender.ts
          commandDispatcher.ts
          commandHandlers/

  packages/
    core/
      src/
        agent/
        prompts/
        test/

    workspace/
      src/
        index.ts
        workspacePaths.ts
        workspaceScaffold.ts
        nativeFolderPicker.ts
        resourceStorage.ts

    providers/
      src/
        types.ts
        ProviderRouter.ts
        ai-sdk/
        modelCatalog/
        test/

    contracts/
      src/
        api.ts
        entities.ts
        http.ts
        models.ts
        websocket.ts
        contracts.test.ts

    shared/
      src/
        errors.ts
        ids.ts
        index.ts
        time.ts

  repo_docs/
    APP_FLOW.md
    DB_STRUCTURE.md
    FRONTEND_BACKEND_CONTRACT.md
    PROVIDER_USAGE.md
    REPO_STRCUTURE.md
    REPO_RULES.md
```

## Package Responsibilities

### `apps/web`

The frontend application.

It owns:

- Welcome page.
- Onboarding page.
- Projects page.
- Project dashboard.
- Chat UI.
- Project resource panel.
- Project instructions panel.
- Model and provider selector.
- File tree.
- Diff viewer.
- Terminal output display.
- Voice input controls.
- Read-aloud controls.
- Message feedback controls.
- Approval prompts.
- Task timeline.
- Session views.

It must not own:

- Agent decision logic.
- Direct model provider calls.
- Direct filesystem access.
- Direct shell execution.

The frontend talks to the backend over HTTP and WebSockets.

The frontend should use Socrates-owned hooks around Socrates HTTP and WebSocket contracts. Do not make `@ai-sdk/react` the core chat state engine in V1.

Chat UI structure:

```text
app/projects/[projectId]/chats/[conversationId]/page.tsx
  -> route-level data loading and orchestration only

components/chat/
  ChatWorkspace
  ChatTranscript
  ChatComposer
  EmptyChatState
  ProjectChatSidebar
  SidebarProjectSection
  ConversationNavItem
  ConversationActionsMenu
  RenameConversationDialog
  DeleteConversationDialog
```

Rules for chat UI files:

- The chat route page must not become a god component.
- Whole-sidebar collapse state can be local UI state in the chat workspace. A collapsed sidebar should disappear completely and leave only the reopen control.
- Sidebar project collapse state can be local UI state.
- API calls should go through `apps/web/src/lib/api.ts` or Socrates-owned hooks.
- Shared display helpers belong in `apps/web/src/lib/` only when reused.
- Do not introduce frontend-only API payload types that duplicate `packages/contracts`.
- The composer owns text entry, send/stop controls, and presentation of backend-owned model/thinking choices. It must not own provider SDK mappings or agent runtime decisions.

Initial frontend hooks:

```text
useSocratesSocket()
useCurrentUser()
useOnboardingState()
useProjects()
useProject()
useProjectResources()
useProjectConversations()
useConversation()
useChatTurn()
useApprovals()
useContextUsage()
```

### `apps/server`

The backend application.

It owns:

- HTTP routes.
- WebSocket server.
- Onboarding/user profile endpoints.
- Project and resource endpoints.
- Project workspace creation/attachment orchestration.
- Session lifecycle endpoints.
- Request validation at the API boundary.
- Connecting frontend requests to `packages/core`.
- Streaming agent events back to the frontend.

It should be a thin transport layer. Business logic belongs in packages, not routes.

Server persistence is exposed through `apps/server/src/services/store.ts`, but that file should stay a facade. Store implementation belongs in small domain modules under `apps/server/src/services/store/`:

```text
store/
  userStore.ts
  projectStore.ts
  resourceStore.ts
  instructionStore.ts
  conversationStore.ts
  turnStore.ts
  modelTelemetryStore.ts
  eventStore.ts
  errorStore.ts
  approvalStore.ts
  feedbackStore.ts
  shared.ts
  types.ts
```

Rules for server store files:

- Keep `SocratesStore` as the public facade used by routes and WebSockets.
- Put persistence behavior in the domain store that owns it.
- Keep common row lookups and shared helpers in `shared.ts`.
- Do not add new persistence methods directly into the facade unless they delegate to a domain store.

WebSocket transport is split under `apps/server/src/ws/`:

```text
ws/
  websocket.ts
  activeTurns.ts
  eventSender.ts
  commandDispatcher.ts
  commandHandlers/
    chatMessageSend.ts
    chatTurnCancel.ts
    approvalDecide.ts
    feedbackSubmit.ts
```

Rules for WebSocket files:

- Keep `websocket.ts` focused on Fastify registration, connection setup, `connection.ready`, and shutdown cleanup.
- Put command parsing and dispatch in `commandDispatcher.ts`.
- Put typed event construction, sending, persisted event appending, and WebSocket error emission in `eventSender.ts`.
- Put command-specific behavior in one handler file per command.
- Keep all emitted events contract-validated through `packages/contracts`.

### `packages/core`

The main agent runtime.

It owns:

- Agent loop.
- Tool registry.
- Tool execution flow.
- Context construction.
- Approval flow orchestration.
- Session orchestration.
- Sub-agent orchestration later.
- Event emission from agent execution.

The core package should depend on interfaces and contracts, not hardcoded providers or UI details.

Example responsibility:

```text
User message arrives
  -> load session
  -> build context
  -> call model provider
  -> handle model events
  -> validate tool calls
  -> request approval when needed
  -> execute approved tools
  -> emit events
  -> persist session state
```

### `packages/workspace`

The local workspace capability layer.

It owns the low-level implementation for:

- Creating workspace folders.
- Verifying selected workspace folders.
- Opening native folder pickers through platform adapters.
- Creating the `.socrates/` workspace scaffold.
- Storing project resources under `.socrates/resources/`.
- Reading files.
- Writing files.
- Listing directories.
- Searching with `rg`.
- Running shell commands.
- Streaming stdout/stderr.
- Cancelling commands.
- Reading git status and diffs.
- Applying patches.

Important distinction:

```text
packages/workspace = how local work is done
packages/core/tools = what the agent is allowed to call
```

The model-facing tool definition belongs in `packages/core/tools`. The raw filesystem, shell, git, and patch implementation belongs in `packages/workspace`.

### `packages/providers`

The model provider layer.

It owns:

- The internal `ModelProvider` interface.
- Vercel AI SDK adapter.
- Provider/model registry.
- Provider config loading.
- Future LiteLLM, Ollama, OpenRouter, OpenAI, Anthropic, or Gemini direct adapters if needed.

The agent core should call only the internal provider interface.

Target dependency direction:

```text
packages/core -> ModelProvider interface
packages/providers -> Vercel AI SDK / provider SDKs
```

The agent core must not import provider SDKs directly.

### `packages/contracts`

The shared contract package.

It owns schemas and types that cross package boundaries:

- WebSocket events.
- HTTP request/response schemas.
- User and onboarding schemas.
- Project schemas.
- Project resource schemas.
- Project instruction schemas.
- Tool call schemas.
- Tool result schemas.
- Approval request/decision schemas.
- Session schemas.
- Agent event schemas.
- Voice input schemas.
- Audio output schemas.
- Feedback schemas.
- Error payload schemas.

This package is the single source of truth for contracts used by frontend, backend, core, providers, and workspace.

If an event, schema, or cross-boundary type is used in more than one package, it belongs here.

### `packages/shared`

Reusable non-domain utilities.

It owns small generic helpers:

- ID generation.
- Result types.
- Error helpers.
- Logging helpers.
- Time helpers.
- Common assertions.

It must stay generic. Agent-specific logic belongs in `packages/core`, not `packages/shared`.

## WebSocket Design

Socrates should use WebSockets for interactive back-and-forth communication between the user and the agent runtime.

WebSockets are used for:

- Streaming model text.
- Streaming tool call lifecycle events.
- Streaming shell stdout/stderr.
- Streaming speech transcription progress.
- Streaming read-aloud generation/playback status.
- Sending approval requests to the UI.
- Receiving approval decisions from the UI.
- Sending message feedback from the UI.
- Sending cancellation requests.
- Updating session/task status.

HTTP is still used for simple request/response operations:

- Create/update local user profile.
- Complete onboarding.
- Create/list/update projects and required workspace attachments.
- Create/list/update project resources stored under the primary workspace `.socrates/resources/` directory.
- Create session.
- List sessions.
- Load session.
- Read static config.
- Fetch persisted artifacts.

## Event Flow

```text
apps/web
  routes through /welcome, /onboarding, /projects, project dashboard, and project chat
  sends user messages through WebSocket `chat.message.send`
  renders backend-owned model/thinking controls from `GET /api/models`
  or captures voice input and sends the transcript as a user message

apps/server
  validates message using packages/contracts
  forwards message to packages/core

packages/core
  builds Socrates system prompt from backend-provided user/project/instruction context
  runs provider-agnostic agent turn orchestration
  calls packages/providers for model streaming
  calls packages/workspace through registered tools
  emits typed events

apps/server
  streams typed events over WebSocket

apps/web
  renders chat, thinking, tool calls, approvals, diffs, terminal output, voice state, read-aloud state, and feedback controls
```

## App Routes

The route structure is defined in `repo_docs/APP_FLOW.md`.

Initial routes:

```text
/welcome
/onboarding
/projects
/projects/new
/projects/:projectId
/projects/:projectId/chats/:conversationId
```

The project page itself is the dashboard. Do not add a separate dashboard id unless a real dashboard entity is introduced later.

## Example Event Families

The exact schemas should live in `packages/contracts/src/events`.

```text
session.created
session.loaded
session.error

project.created
project.updated
project.workspace.attached
project.resource.created
project.instructions.updated

agent.started
agent.message.delta
agent.message.completed
agent.completed
agent.failed

turn.started
turn.completed
turn.failed
turn.cancelled

tool.started
tool.output.delta
tool.completed
tool.failed

approval.requested
approval.decided
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

patch.proposed
patch.applied
patch.rejected
```

## Dependency Rules

Allowed high-level dependencies:

```text
apps/web -> packages/contracts

apps/server -> packages/core
apps/server -> packages/contracts

packages/core -> packages/contracts
packages/core -> packages/workspace
packages/core -> packages/providers
packages/core -> packages/shared

packages/workspace -> packages/contracts
packages/workspace -> packages/shared

packages/providers -> packages/contracts
packages/providers -> packages/shared

packages/contracts -> no internal package dependencies
packages/shared -> no internal package dependencies
```

Forbidden dependencies:

```text
packages/core -> apps/web
packages/core -> apps/server
packages/workspace -> apps/*
packages/providers -> apps/*
packages/contracts -> packages/core
packages/contracts -> packages/workspace
packages/contracts -> packages/providers
packages/shared -> domain packages
```

## Current Extension Rule

New work should extend the existing packages rather than creating parallel paths:

1. Add or update cross-boundary schemas in `packages/contracts`.
2. Put provider-specific model behavior behind `packages/providers`.
3. Put agent orchestration in `packages/core`.
4. Put local filesystem, picker, resource, shell, git, and patch capabilities in `packages/workspace`.
5. Keep `apps/server` as transport and persistence orchestration through focused route, WebSocket, and store modules.
6. Keep `apps/web` as route, component, hook, and rendering code only.
