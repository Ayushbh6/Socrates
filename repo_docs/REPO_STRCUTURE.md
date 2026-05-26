# Socrates Repo Structure

This document is the source of truth for the current Socrates repo structure. Socrates is a local-first coding agent with a web frontend, a backend runtime, a reusable agent core, provider-agnostic model access, and a clean workspace capability layer.

## Current Shape

```text
Socrates/
  apps/
    desktop/
      package.json
      scripts/
        dev-services.mjs
      src-tauri/
        Cargo.toml
        tauri.conf.json
        src/
      static/

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
        context/
        prompts/
        tools/
        test/

    workspace/
      src/
        index.ts
        pythonEnvironment.ts
        workspacePaths.ts
        workspaceScaffold.ts
        nativeFolderPicker.ts
        resourceStorage.ts
        envFiles.ts

    providers/
      src/
        types.ts
        ProviderRouter.ts
        EmbeddingProviderRouter.ts
        ai-sdk/
        embeddings/
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
  ToolDetails
  DiffView
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

### `apps/desktop`

The native desktop shell.

It owns:

- Tauri configuration.
- Desktop window metadata.
- Desktop development launch scripts.
- Desktop bundling glue.
- Static placeholder shell assets used by Tauri when the web dev URL is not active.

It must not own:

- Agent decision logic.
- Provider adapters.
- Workspace filesystem or shell operations.
- HTTP/WebSocket contract definitions.
- Independent Socrates persistence.

The desktop shell wraps the existing `apps/web` and `apps/server` runtime. It may start those services for development or bundle/launch them for packaged builds, but durable app data remains server-owned and defaults to `~/.Socrates/socrates.sqlite`.

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
  traceStore.ts
  embeddingStore.ts
  contextCompactionStore.ts
  shared.ts
  types.ts
```

Rules for server store files:

- Keep `SocratesStore` as the public facade used by routes and WebSockets.
- Put persistence behavior in the domain store that owns it.
- Keep common row lookups and shared helpers in `shared.ts`.
- Do not add new persistence methods directly into the facade unless they delegate to a domain store.
- Keep append-only context compaction snapshot persistence in `contextCompactionStore.ts`; indexing completed summaries into `trace_documents` stays behind the store facade.

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
- Context compression policy, prompts, packing, and provider-call-boundary budget checks.
- Approval flow orchestration.
- Session orchestration.
- Sub-agent orchestration later.
- Event emission from agent execution.

The core package should depend on interfaces and contracts, not hardcoded providers or UI details.

V1 model-visible tools live under `packages/core/src/tools/`.

Target structure:

```text
tools/
  types.ts
  registry.ts
  readTool.ts
  searchTool.ts
  editTool.ts
  bashTool.ts
  traceRetrieveTool.ts
  listProjectResourcesTool.ts
```

Rules for core tool files:

- One model-visible tool per small file.
- `registry.ts` is the only place that assembles the enabled tool set.
- Tool argument and result schemas come from `packages/contracts`.
- Tool files handle model-facing descriptions, schema binding, permission metadata, and calls into the owning implementation package.
- Tool files must not contain raw filesystem, shell, git, patch, PDF, document, slide, or image parsing implementation.
- Do not create a god `ToolRegistry` class that mixes schemas, permissions, execution, and implementation details.

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
- Reading PDFs, documents, slide decks, images, and structured data through bounded extractors.
- Writing files.
- Listing directories.
- Searching with `rg`.
- Running shell commands.
- Streaming stdout/stderr.
- Cancelling commands.
- Inspecting lightweight Python environment hints for prompt context.
- Reading git status and diffs.
- Applying patches.
- Reading persisted tool traces for retrieval when requested by the core.

Important distinction:

```text
packages/workspace = how local work is done
packages/core/tools = what the agent is allowed to call
```

The model-facing tool definition belongs in `packages/core/tools`. The raw filesystem, shell, git, and patch implementation belongs in `packages/workspace`.

The V1 model-visible tool surface is:

```text
read
search
edit
bash
trace_retrieve
list_project_resources
```

Implementation can be split into narrower workspace files such as text readers, PDF readers, image readers, search helpers, patch helpers, shell runners, and trace readers. These are internal helpers, not separate model-visible tools.

Reader implementations should stay pragmatic. The initial `read` implementation can wrap local extractors or lightweight libraries, for example text file reads, `pdftotext`-style PDF extraction when available, document/slide text extraction, CSV/JSON previews, and image metadata or OCR/description extraction. Socrates should not build a large document-processing platform before the coding-agent loop works.

The `bash` implementation remains a real escape hatch. Even when a structured reader/searcher exists, approved shell commands may be used for fallback extraction or diagnostics. The safety boundary is approval, workspace scoping, command policy, timeout, and output truncation, not a blanket ban on shell commands that overlap with `read` or `search`. Bash uses a workspace-owned non-interactive shell session that is created lazily per active turn, reused for later bash calls in that turn, and disposed when the turn completes, fails, or is cancelled. Because bash already starts in the active workspace, commands that begin by changing into a guessed external absolute path are rejected with a recoverable tool error; relative workspace navigation and approved external destination arguments remain allowed.

`packages/workspace/src/pythonEnvironment.ts` owns the lightweight Python environment scan. It detects common local venv folders and Python dependency-manager files so the server can inject compact per-turn prompt guidance. The agent should prefer existing project environments or detected package-manager workflows, and should ask before creating a new environment when no env exists unless the user already requested setup.

`list_project_resources` is a read-only model-visible tool, but its executor belongs to the server/store boundary because it reads project resource records. It must not scan `.socrates/resources/` with shell commands; it asks `SocratesStore` for active visible project resources and returns bounded filenames/metadata so the model can choose a follow-up `read`. The model-visible input stays intentionally small: `kind` and `limit`.

`trace_retrieve` is also a read-only model-visible tool, but its search corpus and inspect handles belong to the server/store boundary. The model-facing wrapper lives in `packages/core/tools`, while `apps/server/src/services/store/traceStore.ts` owns trace indexing, SQLite FTS search, and exact inspect.

Structured ordinal recall also belongs in `TraceStore`. The model may pass `turnNo` and optional `role` through the same `trace_retrieve` search contract, but the backend resolves that against raw `turns` and `messages` for one precise conversation before any FTS path. Do not create separate model-visible ordinal, trace document, or embedding tools.

The intended retrieval index is internal infrastructure, not a new model-visible tool surface:

```text
raw runtime tables
  messages
  tool_calls
  shell_commands
  file_operations
  patches
  errors
  events

internal retrieval index
  trace_documents
  trace_embeddings
  trace_index_jobs
  project_embedding_configs
  context_compaction_snapshots

model-visible access
  trace_retrieve
```

Trace indexing jobs are server/store work. The current implementation builds deterministic trace documents immediately after turns complete, fail, or are cancelled. When project embeddings are configured, server/store code also enqueues and processes `embed_trace_documents` jobs asynchronously. Completed context compaction snapshots are indexed as hidden `conversation_summary` trace evidence. Rolling conversation summaries outside compaction remain a later phase. `packages/workspace` should not own conversation history indexing, because trace retrieval is over Socrates persistence rather than local filesystem state.

Context compression is a provider-call-boundary concern around the agent/model loop, not ad hoc prompt rewriting inside WebSocket handlers. `packages/core` owns the model-facing context assembly policy, compressor prompt/schema, packing, and budget decisions. `apps/server/src/services/store/contextCompactionStore.ts` owns append-only snapshot persistence, while `traceStore.ts` indexes completed summaries into searchable trace evidence. `packages/providers` owns provider/model token counting and executes the selected compressor/model request behind the provider interface; provider-specific compression or tokenizer behavior must not leak into `apps/web` or route handlers.

### `packages/providers`

The model provider layer.

It owns:

- The internal `ModelProvider` interface.
- Internal embedding provider interface.
- Vercel AI SDK adapter.
- Provider/model registry.
- Provider config loading.
- Provider-aware request token counting with local tokenizer fallback, safety-margin metadata, and provider-exact counting where available.
- Future LiteLLM, Ollama, OpenRouter, OpenAI, Anthropic, or Gemini direct adapters if needed.

The agent core should call only the internal provider interface.

Embedding generation for trace documents stays behind provider abstractions. Chat turns do not import or call embedding SDKs directly. The semantic phase added a provider-agnostic `EmbeddingProvider` boundary in `packages/providers`, separate from the chat `ModelProvider`.

The first embedding phase supports two first-class choices:

```text
OpenAI hosted default
  providerId = openai
  modelId = text-embedding-3-small

Offline local
  providerId = ollama first
  modelId = embeddinggemma, mxbai-embed-large, nomic-embed-text, all-minilm, or configured local model
```

Hugging Face / sentence-transformers can be added as an advanced local backend through the same boundary after the Ollama path is stable. `apps/server` coordinates embedding jobs, but provider-specific HTTP/API/Python details stay out of routes, WebSocket handlers, frontend code, and `packages/core`.

The project dashboard owns the frontend entrypoint for this setup. It renders a state-aware Semantic Search panel that opens a modal step flow for Online vs Offline embeddings. The frontend calls backend project embedding endpoints for status, diagnostics, configuration, and reindexing; it must not call OpenAI, Ollama, Hugging Face, or local runtimes directly.

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
7. Keep trace indexing, trace document persistence, inspect-handle resolution, and conversation-history retrieval in `apps/server/src/services/store/` or focused server-side indexing modules.
8. Keep embedding generation behind `packages/providers`; do not call embedding provider SDKs directly from routes, WebSocket handlers, or frontend code.
