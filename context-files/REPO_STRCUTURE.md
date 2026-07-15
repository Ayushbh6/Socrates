# Socrates Repo Structure

This document is the source of truth for the current Socrates repo structure. Socrates is a local-first coding agent with a web frontend, a backend runtime, a reusable agent core, provider-agnostic model access, and a clean workspace capability layer.

## Current Shape

Current product distribution is the NPM CLI launching the packaged web/server runtime. `apps/desktop` is retained as dormant historical/future shell code; runtime packaging is owned by root `scripts/runtime/`, and no current feature depends on Tauri or Rust.

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
      scripts/
        run-memory-router-gate-eval.ts
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
        deepseek/
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

  context-files/
    APP_FLOW.md
    DB_STRUCTURE.md
    FRONTEND_BACKEND_CONTRACT.md
    PROVIDER_USAGE.md
    REPO_STRCUTURE.md
    REPO_RULES.md

  scripts/
    runtime/

  evals/
    memory-router-gate/
      README.md
      golden-dataset.json
      report.md
```

Root `scripts/` owns opt-in maintenance, packaging, benchmark, and evaluation entrypoints that are not application runtime modules; a package-specific runner may live under that package's `scripts/` directory when it needs package-owned dependencies. Evaluation fixtures and durable summarized findings live under a matching `evals/<name>/` directory. The Memory Router gate experiment follows this boundary: its runner lives outside server `src`, is invoked only by `pnpm eval:memory-router-gate`, uses a synthetic dataset, and records the rejected production decision in a report while raw provider result JSON is ignored. Nothing under that experiment is imported by the server, web app, CLI, or runtime archive.

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
- Release packaging glue for signed DMG/NSIS artifacts, updater metadata, install scripts, and OS keychain commands.

It must not own:

- Agent decision logic.
- Provider adapters.
- Workspace filesystem or shell operations.
- HTTP/WebSocket contract definitions.
- Independent Socrates persistence.

The desktop shell is dormant and wraps the existing `apps/web` and `apps/server` runtime only when explicitly reactivated. Durable app data remains server-owned. Current packaged runtime assembly and archives come from root `scripts/runtime/`; the compatibility desktop wrapper delegates there instead of maintaining a second builder.

### `apps/cli`

The npm launcher package.

It owns:

- The `@socrates-ai/cli` package manifest and `socrates` binary.
- GitHub Release runtime lookup, download, checksum verification, and extraction.
- Local port selection, browser opening, and runtime process lifecycle.

It must not own agent logic, provider logic, workspace operations, persistence, or frontend UI behavior.

The CLI defaults to the latest GitHub Release runtime; `--runtime-version <tag>` pins a specific tag. Runtime asset lookup should prefer direct GitHub Release download URLs and use REST release metadata only as a fallback, because public `npx` installs may hit unauthenticated GitHub API rate limits. Windows extraction should use `tar.exe` first and PowerShell `Expand-Archive` only as a fallback. Runtime zip creation must archive direct root entries such as `launcher.mjs` and `manifest.json`, not `.` or a wrapper directory, so older npm launchers can extract the latest GitHub runtime reliably. Keep installer/extraction optimization inside the CLI/desktop packaging layer, not in agent/workspace packages.

Release/package-manager tooling is pinned to the proven `pnpm@9.15.1` runtime-build path. Runtime release publishing recreates the tag release and uploads each archive explicitly so stale partial drafts are discarded. Runtime archives still bundle Node v20.20.2. Local runtime archive builds support pnpm 10+ by adding legacy deploy and native build-script allowance only when the builder detects a newer pnpm major. GitHub Windows shell/runtime jobs should use `windows-2022`; `windows-latest` currently maps to Windows Server 2025 / VS 2026 and breaks `node-gyp` Visual Studio detection for native dependencies. Shell Tooling keeps Windows install/typecheck plus contracts/workspace/core tests, and runs server PTY/WebSocket tests on Ubuntu only because they assume POSIX bash/PTY behavior.

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
  terminalStore.ts
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
  conversationSubscriptions.ts
  conversationTerminals.ts
  eventSender.ts
  commandDispatcher.ts
  commandHandlers/
    chatMessageSend.ts
    chatTurnCancel.ts
    approvalDecide.ts
    feedbackSubmit.ts
```

Rules for WebSocket files:

- Keep `websocket.ts` focused on Fastify registration, connection setup, `connection.ready`, conversation subscription setup, conversation Terminal manager setup, and shutdown cleanup.
- Put command parsing and dispatch in `commandDispatcher.ts`.
- Keep conversation socket membership and active-turn replay routing in `conversationSubscriptions.ts`.
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
- Specialized-agent and sub-agent orchestration, including the Global Memory Agent, Skill Writer Agent, and future reusable subagents.
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
  toolDocsTool.ts
  skillsTool.ts
  projectDocsTool.ts
  repoDocsTool.ts
  memoryNoteTool.ts
  soulTool.ts
  userProfileTool.ts
  listProjectResourcesTool.ts
  mcpRegistryTool.ts
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
- Reading PDFs, documents, slide decks, images, and structured data through bounded extractors. `read` applies an estimated default 4,000-token output cap and a hard 6,000-token `tokenLimit` cap across readable formats, with `charLimit`/offset paging still available.
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
url_fetch
edit
apply_patch
bash
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

The main Socrates surface includes `memory_note`. `url_fetch` is an exact-URL HTTP(S) read primitive implemented at the server/runtime boundary; it is not broad web search. The Memory Agent's `memory_notes` inbox and the Skill Writer Agent's `skill_write` mutation tool are specialized-agent/internal tools, not normal main-chat tools.

Implementation can be split into narrower workspace files such as text readers, PDF readers, image readers, search helpers, patch helpers, shell runners, and trace readers. These are internal helpers unless explicitly registered as model-visible tools like `apply_patch`.

Reader implementations should stay pragmatic. The initial `read` implementation can wrap local extractors or lightweight libraries, for example text file reads, `pdftotext`-style PDF extraction when available, document/slide text extraction, CSV/JSON previews, and image metadata or OCR/description extraction. Socrates should not build a large document-processing platform before the coding-agent loop works.

The `read`, `edit`, and `apply_patch` implementations together own file freshness and verification. `read` returns full-file content hashes and file metadata. `edit` is the single-file mutation tool for targeted replacements, new-file writes, and explicit whole-file overwrites; existing-file `content` writes require `overwrite: true`, and all existing-file edits require a prior active-turn `read`, with freshness tracked by the harness rather than model-carried hashes. `apply_patch` exposes `patchText` to the model and accepts the structured `*** Begin Patch` envelope for model-friendly multi-file changes, with `@@` labels treated as optional hints and exact old lines used for matching. Existing-file patch, delete, and rename operations also require a prior active-turn `read`; after any successful edit or patch, another mutation to the same path must re-read first. Standard unified diffs remain accepted for compatibility when already valid; structured patches are normalized, applied, and verified with patched, created, deleted, and renamed intent. Non-dry-run writes must read/stat/hash before mutation, verify disk after mutation, and report recoverable workspace errors rather than successful edits when freshness or read-back checks fail. Workspace mutation helpers also enforce the project-docs and repo-docs boundaries: `<workspace>/.socrates/MEMORY.md` and `<workspace>/.socrates/PROJECT_NOTES.md` can be read normally but cannot be created, edited, patched, deleted, or renamed through generic `edit`/`apply_patch`; mutations must go through `project_docs`. `<workspace>/.socrates/repo_docs/*.md` can be read/searched normally but must be changed through `repo_docs`. Before `edit`, `apply_patch`, or approval-required mutation tools can run, Socrates must have read, searched, or edited `repo_docs` in the same turn.

`apps/server/src/services/store/memoryStore.ts` owns Socrates memory scaffolding, the bounded hash-validated stable-prelude snapshot cache, `tool_docs`, `skills`, `project_docs`, `repo_docs`, `soul`, `user_profile`, the backend memory agent, primary doc patches, and soul confirmation. `apps/server/src/services/store/skillImportStore.ts` owns deterministic portable-skill ZIP staging, public-HTTPS download guards, security inspection, preview persistence, atomic global/project installation, imported provenance, and enable/disable state; `attachmentStore.ts` admits bounded `skill_zip` chat attachments and verifies current-turn ownership before preview. Main chat no longer receives a per-turn wake-context block; stable identity/always-apply sections come from one backend snapshot with stat fast-path, content-hash validation, standing-section-only rebuilds, and hard-deduplicated routed targets, while changing memory/runtime facts are fetched through visible tools. `project_docs` is the workspace memory/notes surface for `.socrates/MEMORY.md` and `.socrates/PROJECT_NOTES.md`; project notes include an `active_context` section for project-local open loops and recall plus a protected generated `runtime_context` section that refreshes lazily when `project_docs` touches notes. `repo_docs` is the runtime doctrine surface for `.socrates/repo_docs/*.md`. Runtime memory docs use YAML frontmatter plus `socrates:section` markers, and `apps/server/src/services/store/memoryDocParser.ts` parses/builds section indexes for `read_index`, `read_section`, and `patch_section`. Parsed indexes are persisted in `memory_doc_indexes` and `memory_doc_sections`; markdown remains the source of truth. `tool_docs` is read-only tool guidance for the main agent; primary tool-usage markdown lives in `apps/server/src/memory/defaults/primary/tool_usage/`, is copied into server `dist` during build, and is installed into `~/.Socrates/tool_usage/` on memory initialization. `skills` discovers enabled builtin, global, and project skills from disk; list/describe/read remain automatic, `preview_import` stages one exact public HTTPS URL or current-turn ZIP attachment, and approval-required `commit_import` installs its exact destination-bound preview. UI flows continue to build/import/manage skills through the same store. `soul` reads `~/.Socrates/identity.md` through read/index/section operations, while `user_profile` reads durable cross-project user profile facts and global active context through the same focused read pattern. Standalone `operating_principles.md` is retired and deleted during global memory initialization. Workspace repo-doc templates live in `apps/server/src/memory/defaults/workspace/repo_docs/` and are installed into `<workspace>/.socrates/repo_docs/` only when missing. Memory-agent actions and confirmations are persisted in SQLite. Memory-note creation must normalize/deduplicate before insert and enforce the same-turn max-two guard; memory-note closure stores both an outcome (`applied`, `already_represented`, `skipped`, or `proposed_skill`) and a human resolution. Applied identity updates and memory-agent activity summaries create durable notification rows through `apps/server/src/services/store/notificationStore.ts`, while pending skill proposals remain the action-needed notification path.

`memoryStore.ts` should stay close to persistence, scaffolding, and coordination. Serious model-driven capabilities must not live there as one-off provider streams. Skill creation/update now routes through the real Skill Writer Agent path with the same runner, prompt, tool-registry, validation, event, and persistence structure as Socrates and the Global Memory Agent; `skill_write` is only the narrow scoped save/validation tool.

The `bash` implementation is the compatibility id for the Terminal tool and remains a real escape hatch. `list`, `run`, `start`, `status`, `output`, and `stop` are its compact Terminal control plane. Every raw `run` uses the PTY path and becomes the same named conversation Terminal after the 15-second foreground window if it is still active; it is never killed or restarted to detach. `conversationTerminals.ts` owns PTYs, bounded output, user-only stdin, supervisor reconciliation, and task-aware Terminal lifetime. `waitTool.ts`, `agentTaskStore.ts`, and `agent_tasks`/`agent_task_waits` implement the separate deterministic wait/resume coordinator: it stores terminal event dependencies, suspends the model without a final answer, and starts the same task's continuation only for an eligible event. Healthy Terminals referenced by a task have no fixed TTL. Model-facing control uses human names only; opaque terminal/process ids and cursors stay internal.

`packages/workspace/src/pythonEnvironment.ts` and `packages/workspace/src/workspaceEnvironment.ts` own the lightweight workspace environment scan. They detect enough stack, package-manager, and virtual-environment hints for the server to maintain compact protected `runtime_context` facts under project notes. The server refreshes that section lazily from `project_docs` notes calls and rewrites only when the generated signature changes. The generated section should not expand into dependency dumps, package lists, workspace package inventories, or root-script lists. The agent should read project notes when workspace runtime facts matter, prefer existing project environments or detected package-manager workflows, and ask before creating a new environment when no env exists unless the user already requested setup.

`list_project_resources` is a read-only model-visible tool, but its executor belongs to the server/store boundary because it reads project resource records. It must not scan `.socrates/resources/` with shell commands; it asks `SocratesStore` for active visible project resources and returns bounded filenames/metadata so the model can choose a follow-up `read`. The model-visible input stays intentionally small: `kind` and `limit`.

Terminal orchestration now extends that PTY layer with `list` in `packages/core/src/tools/bashTool.ts`, generic foreground-to-background handoff in `apps/server/src/ws/conversationTerminals.ts`, and the separate `wait` tool in `packages/core/src/tools/waitTool.ts`. `apps/server/src/services/store/agentTaskStore.ts` persists deterministic task/wait dependencies in `agent_tasks` and `agent_task_waits`; it is not an LLM or separate agent. Wake continuations are created by `chatMessageSend.ts` and run through the normal Socrates agent path with bounded terminal evidence.

`mcp_registry` is the base model-visible MCP discovery and lifecycle tool. List/describe/check are automatic discovery or validation; configure/delete are mutation-lane operations with normal user approval and project/global scope. Model-visible configure carries only `secretBindings` names/source. `apps/server/src/ws/activeTurns.ts` and `commandHandlers/credentialInputSubmit.ts` own the transient one-at-a-time credential waiter; `CredentialPrompt.tsx` owns the masked inline handoff; `packages/mcp` alone receives resolved values and writes the private scope env file. Backend UI/API routes additionally own JSON/TOML/manual setup, edit, enable/disable, status, blank-on-read secret config, config-file open, and delete. Dynamic MCP tool names are runtime-provided additions after describe/check, not separate handwritten core tools.

`trace_retrieve` is also a read-only model-visible tool. The model-facing wrapper lives in `packages/core/tools`; provider-neutral chunking/ranking contracts live in `packages/core/src/retrieval`; and `apps/server/src/services/retrieval` owns LanceDB lifecycle, indexing, lexical/vector/hybrid retrieval, and diagnostics. `TraceStore` retains authoritative/raw conversation and audit resolution but must not own a parallel semantic implementation.

Structured ordinal recall also belongs in `TraceStore`. The model may pass `turnNo` and optional `role` through the same `trace_retrieve` search contract, but the backend resolves that against raw `turns` and `messages` for one precise conversation before any FTS path. Do not create separate model-visible ordinal, trace document, or embedding tools.

The intended retrieval index is internal infrastructure, not a new model-visible tool surface:

```text
raw runtime tables
  messages
  tool_calls
  shell_commands
  terminal_sessions
  file_operations
  patches
  errors
  events

internal retrieval state
  SQLite retrieval_index_states / retrieval_jobs
  SQLite retrieval_runs / retrieval_result_diagnostics
  LanceDB project tables containing reproducible chunks, vectors, and FTS rows
  project_embedding_configs

model-visible access
  trace_retrieve
```

Retrieval indexing is server/store work. The implementation converts each visible turn into one canonical Q&A parent, chunks user and assistant roles independently, and incrementally upserts changed parents into the active LanceDB project table. Memory sections use the same chunker and index lifecycle. Compaction summaries, tool calls, shell output, patches, files, and errors are excluded from the semantic corpus and remain available through raw inspect/audit. `packages/workspace` does not own conversation-history indexing because retrieval is over Socrates persistence rather than local filesystem state.

Context compression is a provider-call-boundary concern around the agent/model loop, not ad hoc prompt rewriting inside WebSocket handlers. `packages/core` owns the model-facing context assembly policy, `CompressorAgent`, compressor prompts, packing, and budget decisions. `packages/contracts/src/contextCompression.ts` owns the strict structured schemas. `apps/server/src/services/store/contextCompactionStore.ts` owns append-only snapshot persistence, while `traceStore.ts` indexes completed summaries into searchable trace evidence. `apps/server/src/services/store/modelSettingsResolver.ts` resolves saved worker and memory-agent settings against the credential-filtered model list before runtime use. `packages/providers` owns provider/model token counting and structured generation behind the provider interface; provider-specific compression, auth-mode request behavior, or tokenizer behavior must not leak into `apps/web` or route handlers.

`packages/contracts/src/socratesSurfaces.ts` is the single code-owned `.socrates` surface registry. `packages/workspace` derives protected paths and storage roots from it, and `packages/core` renders its bounded model-facing surface map. `packages/contracts/src/attachments.ts` owns inline/count/per-file/combined attachment limits. `apps/web/src/components/chat/ChatComposer.tsx` converts pasted text over 10,000 characters into `pasted-text-<id>.txt`; `apps/server/src/services/store/attachmentStore.ts` validates and persists image/text source attachments with provenance, while `conversationStore.ts` sends compact manifests and includes image bytes only for vision-capable models. These responsibilities must not be duplicated as frontend-only constants or handwritten prompt path maps.

### Specialized Agent Ownership

Socrates, the Global Memory Agent, and the Skill Writer Agent should share one production-grade agent pattern:

```text
agent prompt
  -> shared agent runner
  -> scoped tool registry
  -> executor mapping
  -> structured validation
  -> typed events and persistence
```

Do not add serious model-driven workflows as bespoke provider calls inside routes, stores, or UI handlers. A store method may enqueue work, load context, persist outputs, and apply validated effects, but it should not own a private prompt loop for a capability that behaves like an agent.

Role boundaries:

- Memory Router is a real `MemoryRouterAgent` built through the same prompt -> shared runner -> scoped tool registry/executor -> strict structured validation -> usage/persistence pattern as other model-driven capabilities. Its pre-turn phase has only `memory_search`, backend automatic prefetch, a three-call cap, and exact read-only `readTargets`. Its finalization phase receives bounded task-wide evidence, may inspect only backend-created task-scoped references through `turn_evidence`, and returns bounded reconciliation plans. It never authors patches or writes docs; Socrates performs and re-reads every planned project/repo mutation before the final answer is released.
- Socrates writes workspace project memory, project notes, and repo docs through `project_docs` and `repo_docs`. It owns project-scoped active context in project notes and may create `memory_note` leads for the Memory Agent, preferably one and never more than two per user-turn. It does not write identity, user profile, or skills.
- The Global Memory Agent writes global user profile through scoped edits, proposes/applies identity only through the confirmation policy, inspects full skills for freshness, and sends approved skill create/update tasks to the Skill Writer Agent. It uses `StructuredToolAgentRunner` like Memory Router: normal scoped tool calls first, then one strict Zod journal output. Each successful run persists one `memory_agent_journal` row and refreshes a bounded generated ledger/next-run briefing; `read_memory_journal` provides capped list/read access to older runs without embeddings. It should skip project-local active context for global memory and close each memory note with one of `applied`, `already_represented`, `skipped`, or `proposed_skill` plus a one-line resolution.
- The Skill Writer Agent receives exact approved evidence ids, inspects every source turn, reads the canonical scoped existing skill for updates, then writes the final `SKILL.md` plus optional bounded supporting files through `skill_write`. It does not decide whether the skill should exist. The write path rejects shallow bodies, traversal, broken links, and no-op updates; one bounded agent retry is allowed when an attempt ends without the required write call.

### `packages/providers`

The model provider layer.

It owns:

- The internal `ModelProvider` interface.
- Internal embedding provider interface.
- Vercel AI SDK adapter.
- Native Ollama chat adapter and dynamic local model discovery.
- Provider/model registry, including auth-mode-specific catalog entries.
- Provider config loading and credential-auth resolution.
- Provider-aware request token counting with local tokenizer fallback, safety-margin metadata, and provider-exact counting where available.
- Future LiteLLM, Anthropic, or deeper direct wrappers for major providers if needed.

The agent core should call only the internal provider interface. Runtime model identity is `{ providerId, authMode, modelId }`; provider id alone is not enough when a provider supports both API-key billing and subscription-auth request paths. Ollama chat models use the same identity shape with `providerId = "ollama"` and `authMode = "api_key"` for the local direct path, but no secret is required.

Ollama chat model discovery is dynamic and server-owned. The backend refreshes `/api/models` from installed local Ollama metadata, filters out embedding-only models, exposes discovered chat-capable models to the composer, worker model settings, title generation, Memory Router, and Global Memory Agent, and never pulls or installs models during discovery.

Embedding generation for trace documents stays behind provider abstractions. Chat turns do not import or call embedding SDKs directly. The semantic phase added a provider-agnostic `EmbeddingProvider` boundary in `packages/providers`, separate from the chat `ModelProvider`.

The first embedding phase supports two first-class choices:

```text
OpenAI hosted default
  providerId = openai
  modelId = text-embedding-3-small

Offline local
  providerId = ollama first
  modelId = embeddinggemma:latest, qwen3-embedding:0.6b, nomic-embed-text-v2-moe:latest, nomic-embed-text:latest, mxbai-embed-large:latest, or another exact configured local embedding model
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
- Chat attachment kinds and shared inline/count/byte limits.
- The code-owned Socrates surface registry and generated-map metadata.
- Chat/memory compaction schemas and hard summary bounds.
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
  subscribes the chat WebSocket to the active conversation with `chat.conversation.subscribe`
  sends user messages through WebSocket `chat.message.send`
  renders backend-owned credential-filtered model/thinking controls from `GET /api/models`
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
  persists typed events, then streams them to sockets currently subscribed to the conversation

apps/web
  renders chat, thinking, tool calls, approvals, diffs, terminal output, voice state, read-aloud state, and feedback controls
```

## App Routes

The route structure is defined in `context-files/APP_FLOW.md`.

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
