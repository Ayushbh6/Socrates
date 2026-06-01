# Socrates Memory

This file is the repo-local memory and work log for Socrates.

## Source Of Truth

`repo_docs/` is the source of truth for any information related to the Socrates app.

Always inspect `repo_docs/` first when you need to understand:

- Product flow.
- Repo structure.
- Database design.
- Frontend/backend contracts.
- Provider strategy.
- Engineering rules.
- App route decisions.
- WebSocket event behavior.

Do not rely on stale chat context when the docs can answer the question.

## Current Architecture Decisions

- Socrates is a local-first AI partner app, not only a CLI.
- The app is project-first: no global unscoped chats in V1.
- Route flow is `/welcome -> /onboarding -> /projects -> /projects/:projectId -> /projects/:projectId/chats/:conversationId`.
- `/projects/:projectId` is the project dashboard. There is no separate dashboard id in V1.
- SQLite is the local source of truth for users, projects, project resources, project instructions, conversations, sessions, turns, messages, events, tools, approvals, usage, and errors.
- WebSockets are the live event channel between frontend and backend.
- The frontend uses Socrates-owned hooks around Socrates contracts and WebSocket events.
- `@ai-sdk/react` is not the core chat state engine in V1.
- V1 provider access uses AI SDK provider packages behind Socrates' own provider abstraction.
- Vercel AI Gateway is not the default provider path in V1.

## First Contracts Sprint

Implemented the first TypeScript foundation:

- Added pnpm workspace scaffolding.
- Added `tsup`, `typescript`, and `vitest`.
- Added `@socrates/contracts`.
- Added Zod schemas and inferred TypeScript types.
- Added HTTP API envelope and error contracts.
- Added core entity contracts.
- Added V1 HTTP request/response contracts.
- Added WebSocket envelope, client command, and server event contracts.
- Added tests for API responses, entities, HTTP payloads, client commands, server events, and malformed payload rejection.

Verification commands passed:

```text
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

## Important V1 Runtime Rule

Only one active turn may run per conversation in V1.

Composer behavior:

```text
no active turn -> show send arrow and allow sending
active turn -> show stop button and block sending another query
stop button -> send chat.turn.cancel
turn.completed / turn.failed / turn.cancelled -> show send arrow again
```

If the frontend tries to send while a turn is already active, the backend should reject with:

```text
turn_already_active
```

V1 uses cancel/stop, not true pause/resume.

## Historical Backend Foundation Sprint

This section records the initial backend foundation. Some bullets describe the state of that early sprint, not the current full app state. The current state is summarized in later sections.

- Added `@socrates/shared` for reusable IDs, timestamps, and error helpers.
- Added `@socrates/server` with Fastify, `@fastify/websocket`, SQLite, Drizzle ORM, and Drizzle Kit migrations.
- Added DB schema and generated migration SQL for every table in `repo_docs/DB_STRUCTURE.md`, including post-V1 tables.
- Added DB bootstrap with `SOCRATES_DB_PATH` override.
- Default local app storage now lives outside the repo at `~/.Socrates/socrates.sqlite`. `SOCRATES_HOME` can change the app-data directory, and `SOCRATES_DB_PATH` can still point at an explicit SQLite file.
- The previous repo-local development DB at `app-data/socrates.sqlite` is legacy data. On default startup, if `~/.Socrates/socrates.sqlite` does not exist and no explicit `SOCRATES_DB_PATH` is set, the server copies the legacy DB plus WAL/SHM siblings once. Set `SOCRATES_SKIP_LEGACY_DB_IMPORT=true` to skip that import.
- Future local app packaging must use a backend/native filesystem bridge for project workspace selection and creation.
- Added `apps/desktop` as the Tauri desktop shell. `pnpm desktop:dev` starts the existing server and web dev services when needed and opens the web UI in a native window. The desktop shell is launch/bundling glue only; it must not duplicate agent, provider, workspace, or contract logic.
- Added internal-tester packaging flow: `pnpm desktop:runtime` assembles ignored runtime resources, and `pnpm desktop:bundle` runs Tauri build for the native app bundle. The runtime bundles an official Node distribution matching the builder Node version, a deployed server sidecar, Drizzle migrations, and a Next standalone web sidecar. Packaged Tauri starts the launcher, waits for local readiness, then navigates the main window to the local web server.
- Pivoted primary distribution to npm CLI: `@socrates-ai/cli` launches Socrates with `npx`, downloads unsigned platform runtime zips from GitHub Releases, verifies `SHA256SUMS`, extracts under `~/.Socrates/runtimes/`, starts local backend/web sidecars, and opens the browser. SemVer tags now publish npm runtime zips; signed Tauri desktop release remains manual/future. CLI/browser credentials persist in `~/.Socrates/.env`; Tauri credentials use OS keychain. Credential APIs expose only status/source and must never return raw key values.
- Do not rely on browser-only filesystem APIs for the core project model. Socrates needs durable absolute workspace paths so the backend agent can create folders, write `.socrates/`, store resources, scan repos, and run tools.
- Dev V1 may use a backend filesystem bridge or temporary path input. Proper local app V1 should wrap the web UI in Tauri or Electron and use native folder dialogs.
- Added DB-backed HTTP routes for onboarding, projects, resources, and conversations.
- Added the first WebSocket `/ws` path with command validation, contract-shaped lifecycle events, one-active-turn enforcement, `chat.turn.cancel`, and minimal feedback/error/event persistence.

At that point, real model providers, the agent loop, workspace tools, shell execution, real approvals, and frontend UI behavior were still future work. The current V1 AI path, frontend chat UI, store split, and WebSocket split are documented below.

## Project Workspace And Resource Flow Sprint

Implemented the V1 project workspace flow:

- Added `@socrates/workspace` for native folder picker adapters, workspace scaffold creation, and resource file storage.
- Project creation now requires a real absolute workspace path and creates `<workspace>/.socrates/resources/`.
- `start_from_scratch` and `existing_folder` both create a primary `project_workspaces` row.
- Duplicate active workspace paths are rejected with `workspace_already_attached`.
- Project workspace connections are editable from the project dashboard while preserving one active primary workspace. When a new folder already contains `.socrates`, Socrates requires the user to choose whether to use the existing scaffold or delete/recreate that selected folder's `.socrates`.
- Workspace switching copies active uploaded resources from the old `.socrates/resources/` folder into the new one and updates resource/artifact paths. Linked and external resources are left unchanged.
- Added `POST /api/workspaces/pick-folder` for backend/native folder selection.
- Added workspace inspection and update contracts so folder attachment can detect existing `.socrates` before mutating the filesystem.
- Added `POST /api/projects/:projectId/resources/upload` for file uploads into `.socrates/resources/`.
- The frontend `/projects/new` page now uses the backend picker/create flow and keeps a manual absolute-path fallback.
- The dashboard resource panel uploads files through the backend and refreshes project resources from SQLite.

Follow-up fix:

- The `/projects/new` page was simplified to remove Start from scratch vs Use existing folder mode cards.
- V1 project creation now asks only for project title, optional description, and a required connected folder/path.
- The folder picker call goes directly to the local backend origin to avoid Next dev rewrite failures during long-running native OS dialogs.
- The frontend API client now handles non-JSON/plain-text failures cleanly instead of showing raw JSON parse errors.

## Current Repo Notes

- The tracked repo rules doc is `repo_docs/REPO_RULES.md`.
- The earlier `REPO_RULEs.md` casing mismatch was normalized with `git mv`.
- Build output under `packages/contracts/dist/` is generated and ignored.
- `node_modules/` and package-local `node_modules/` are ignored.

## Investigation Memory Direction

- `trace_retrieve` is an investigation tool, not a query-first search box. It supports queryless exact browsing across visible active/archived project conversations with Q/A pair windows, conversation offset, per-conversation limits, title/id/date filters, and role/message filters.
- Socrates-owned memory now has global primary files under `~/.Socrates/primary/` and project files under `~/.Socrates/projects/<projectId>/`, including one diary markdown file per day.
- Bundled primary tool-usage docs are installed from server assets into `~/.Socrates/primary/tool_usage/`: `trace_retrieve.md`, `edit_tools_and_bash.md`, `read_tools.md`, and `memory_tools.md`.
- Workspace-local notes live at `<workspace>/.socrates/PROJECT_NOTES.md` and should be accessed through the dedicated `project_notes` tool rather than generic edit tools. Generic `edit` and `apply_patch` mutations to this file are backend-rejected with a recoverable `project_notes_dedicated_tool_required` error; normal `read`/`search` may still inspect it.
- Workspace-local repo doctrine lives at `<workspace>/.socrates/repo_docs/` with the six-doc structure from this repo: `REPO_RULES.md`, `APP_FLOW.md`, `FRONTEND_BACKEND_CONTRACT.md`, `DB_STRUCTURE.md`, `PROVIDER_USAGE.md`, and `REPO_STRCUTURE.md`. Socrates reads/searches/patches those files through `repo_docs`; generic `edit` and `apply_patch` mutations are rejected with `repo_docs_dedicated_tool_required`.
- The main agent can read/search memory pages through `socrates_memory`; `soul` gives read-only access to identity and operating principles. `socrates_memory` uses memory scopes (`primary`, `project`, `all`) and page controls (`memoryLimit`, `memoryOffset`), not conversation scopes.
- Backend memory synthesis now runs through a buffered memory agent. It gathers completed-turn evidence until about 60k estimated tokens or a 5-minute idle flush, calls DeepSeek v4 Pro with MiMo fallback, appends diary notes, and can patch primary docs through verified oldText/newText edits.
- Soul updates are gated by an internal second model confirmation prompt: `You are about to make changes to the soul. Are you sure?` Only exact `yes` applies the patch. Applied soul updates create persistent notifications with compact diffs.

Four-phase action plan for the next memory/tooling slice:

1. Harden memory/project-note scoping and block generic writes to `<workspace>/.socrates/PROJECT_NOTES.md`; writes must go through `project_notes`, while normal reads can remain allowed for now.
2. Upgrade `socrates_memory` into a true investigation tool with exact/keyword/whole-word/regex search, queryless page browsing, memoryLimit/memoryOffset page controls, date/time/month ranges, result windows, output caps, and strict current-project diary scoping.
3. Done: replace the diary helper with a dedicated backend memory agent that owns diary writing, evidence aggregation, model fallback, logging, and non-blocking failures.
4. Done: add controlled self-updating for global primary docs and tool-usage docs, using evidence-backed backend patches rather than direct main-agent edits. Soul edits require internal confirmation and user-visible notification.

## Project Dashboard And Conversation Slice

The current project dashboard and chat slice is implemented end to end across contracts, server, web, and SQLite.

Project dashboard behavior:

- `/projects/:projectId` is still the project dashboard.
- The dashboard shows a centered `Start new chat` action instead of the full chat composer.
- Clicking `Start new chat` creates a project-scoped conversation with title `New conversation`, then routes to `/projects/:projectId/chats/:conversationId`.
- Project descriptions are stored in full but shown as bounded previews.
- Project instructions are edited through a modal and persisted through `PUT /api/projects/:projectId/instructions`.
- Saved instructions are shown as a bounded preview on the dashboard.
- File uploads accept up to 10 files per request, store files under `<workspace>/.socrates/resources/`, persist artifact metadata, and render bounded scrollable file previews with filename, MIME/type, and size when known.
- Dashboard conversation rows reuse the shared conversation actions menu with `Rename` and `Delete`.

Conversation behavior:

- Creating a conversation does not create a session.
- The first user message creates or reuses the active session, creates a running agent turn, persists the user message, writes per-turn runtime config, updates `conversations.updated_at`, and derives the title if it is still `New conversation`.
- First-message title derivation uses the first word, capped at 10 characters plus `...` when needed.
- Later messages do not auto-rename the conversation.
- Manual rename updates the persisted conversation title.
- Delete is a hard delete after confirmation. It removes conversation-scoped rows and does not archive the conversation.
- The current AI UI send path uses WebSocket `chat.message.send`. The older HTTP message endpoint remains available for no-AI persistence/fallback flows, but the normal chat UI no longer uses it.
- Each turn can select a different provider/model/thinking mode inside the same conversation. The selected runtime config is stored in `turn_runtime_configs`.
- The backend injects the local user display name, current project name, full project description, and full active project instructions into the Socrates system prompt before calling the model. The frontend does not assemble prompt context.
- The backend builds model-facing chat history from prior user messages and final assistant answers, not from historical tool-call dumps or reasoning streams.
- Provider-reported token usage is persisted in `model_usage` and still returned as `tokenUsage` for diagnostics.
- `GET /api/projects/:projectId/conversations/:conversationId` also returns the latest `contextUsage` estimate for the chat header, sourced from `context_usage_snapshots` with a model-call request fallback when no snapshot exists.

## Initial AI SDK Agent Sprint

Implemented the first real Socrates AI path:

- Added `packages/providers` with Socrates-owned `ModelProvider`, `ModelRequest`, `ModelEvent`, `ModelUsage`, `ProviderRouter`, static model catalog, and AI SDK adapter.
- Added `packages/core` with `SocratesAgent`, prompt builder, and provider-agnostic streaming turn orchestration.
- AI SDK imports are kept inside `packages/providers`; `apps/server`, `apps/web`, and `packages/core` do not import provider SDKs.
- Added backend `GET /api/models` so the frontend renders provider/model/thinking options from backend-owned contracts.
- Current V1 providers are OpenAI, Google, and OpenRouter. Anthropic is intentionally skipped for now.
- Current default model is OpenRouter `deepseek/deepseek-v4-pro` with thinking off.
- OpenAI thinking options: `none`, `low`, `medium`, `high`, `xhigh`; `none` is non-thinking mode.
- Google thinking options follow the current model-specific catalog: Gemini Pro has no off/minimal option, while Flash and Flash-Lite include `minimal`.
- OpenRouter V1 thinking UI is `off` / `on`.
- OpenRouter thinking `off` must be sent explicitly as `providerOptions.openrouter.reasoning = { effort: "none", exclude: true }`; omitting reasoning config is not enough because some OpenRouter models can still emit reasoning by default.
- OpenRouter thinking `on` sends reasoning enabled and allows returned reasoning text.
- OpenRouter calls use AI SDK `smoothStream` with word-level chunking to make bursty provider streams feel smoother. This improves perceived streaming after chunks arrive, but it does not reduce upstream time-to-first-token.
- `chat.message.send` creates/reuses the session, creates the user message and running turn, persists runtime config, loads prior user/final-assistant dialogue as model history, builds prompt context, and calls `packages/core`.
- Provider reasoning deltas map to `agent.thinking.delta`; answer deltas map to `agent.answer.delta`; final assistant messages map to `message.completed`; lifecycle ends with `turn.completed` or `turn.failed`.
- Real model rows are persisted in `model_calls`, `model_stream_chunks`, `model_usage`, `context_usage_snapshots`, and `events`.
- The chat header shows the latest estimated model-facing context size, such as `23,433 tokens`, not cumulative all-time provider token spend.
- The chat UI includes compact model and thinking controls, a stop button during active turns, separate thinking rendering, markdown rendering through `react-markdown` and `remark-gfm`, and a small glowing first-token loading indicator.
- Backend env loading currently reads root `.env` and `apps/server/.env`.

Follow-up fix:

- Reasoning/thinking text is persisted as `model_stream_chunks.channel = 'reasoning'` during streaming and is also attached to completed assistant messages through `messages.metadata_json`.
- `GET /api/projects/:projectId/conversations/:conversationId` hydrates assistant `reasoning` from stored stream chunks when older messages do not yet have reasoning metadata, so existing thinking turns remain visible after reload.
- Completed assistant messages render thinking in a separate collapsible `Thinking` block above the final markdown answer.
- The empty composer send control stays the same arrow button and becomes disabled/grey instead of switching to a spinner-like placeholder.

Store refactor:

- `apps/server/src/services/store.ts` is now a thin `SocratesStore` facade that preserves the existing public server API for HTTP routes and WebSocket handlers.
- Store implementation is split into focused domain modules under `apps/server/src/services/store/`, including user, project, resource, instruction, conversation, turn, model telemetry, event, error, approval, and feedback stores.
- Shared store helpers and row lookups live in `apps/server/src/services/store/shared.ts`; exported store-only types live in `apps/server/src/services/store/types.ts`.

WebSocket refactor:

- `apps/server/src/ws/websocket.ts` is now connection setup only: register WebSocket support, own the `ActiveTurns` registry, emit `connection.ready`, and forward raw messages to the dispatcher.
- WebSocket command parsing and dispatch live in `apps/server/src/ws/commandDispatcher.ts`.
- Event creation/sending/error emission lives in `apps/server/src/ws/eventSender.ts`.
- Command-specific logic lives under `apps/server/src/ws/commandHandlers/` for `chat.message.send`, `chat.turn.cancel`, `approval.decide`, and `feedback.submit`.
- Focused server tests now cover invalid JSON, invalid WebSocket command envelopes, provider failure, and cancellation with partial assistant persistence.

Verification commands passed after this slice:

```text
pnpm typecheck
pnpm test
pnpm build
browser smoke with OpenAI multi-turn memory and context estimate update
```

Chat UI behavior:

- `/projects/:projectId/chats/:conversationId` renders `ChatWorkspace`.
- Empty chats show the composer centered in the main area.
- After the first message, the user message appears in the transcript and the composer moves to the bottom.
- Existing chats load persisted messages and keep the composer at the bottom.
- The chat sidebar appears on chat pages only.
- The sidebar lists existing projects, allows starting a new chat in each project with the project `+`, supports per-project conversation collapse, and bounds long conversation lists.
- The whole sidebar is collapsible. When collapsed, it disappears completely and leaves only a small reopen button at the top-left edge of the chat workspace.

## FRONTEND AGENT LOGS

- Initialized Next.js workspace in `apps/web` utilizing App Router, Tailwind CSS v4, and TypeScript.
- Configured styling using `framer-motion`, `lucide-react`, and `shadcn/ui` mapping to a custom Apple-inspired warm cream/teal theme in `globals.css`.
- Implemented the `/welcome` page with a seamless cream background, gradient typography, and fade-in animations.
- Implemented the `/onboarding` page as a floating, unboxed form on the seamless cream background.
- Implemented the `/projects` page as a minimalist list with a `ProjectSearch` component and simplified `ProjectCard`s, removing the global sidebar. Added a personalized greeting (e.g., "Welcome, {name}.") to the header after onboarding.
- Implemented the `/projects/new` page as a clean, centered creation form.
- Implemented the `/projects/:projectId` dashboard with a 2-column layout (Left: project header, centered Start new chat action, and Conversation List; Right: Instructions & Files Panels).
- Implemented the `/projects/:projectId/chats/:conversationId` chat workspace with centered empty-chat composer, bottom composer after messages, streamed AI transcript, compact model/thinking controls, context-estimate header, first-token loading indicator, and collapsible project/conversation sidebar.
- All UI elements have been properly compartmentalized into `apps/web/src/components/` according to `REPO_RULES`.
- Frontend onboarding, projects, project dashboard, resource upload, model catalog, conversation loading, and WebSocket chat flows are now wired to real backend APIs/contracts through `apps/web/src/lib/api.ts` and `apps/web/src/hooks/useSocratesSocket.ts`.

## Tooling, Tool Timeline, And Resource Management Sprint

Implemented the first production-grade Socrates tool loop and inline tool UI.

Agent/tool runtime:

- `packages/contracts/src/tools.ts` now owns shared schemas and types for Socrates tools, tool execution results, approval payloads, truncation metadata, provider metadata, and persisted tool history contracts.
- The model-visible tool registry lives under `packages/core/src/tools/`, with one small file per tool and one unified registry.
- The current model-visible tool surface is:

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

- `read`, `search`, `trace_retrieve`, `socrates_memory`, `soul`, `list_project_resources`, and non-configuring `mcp_registry` operations are read-only and parallel-capable.
- `edit` and `apply_patch` are serialized mutation tools and share a workspace-level mutation lock.
- `project_notes` and `repo_docs` are constrained serialized mutation tools for Socrates-owned workspace markdown surfaces.
- `bash` is serialized and does not run concurrently with file mutations.
- `maxParallelToolCalls` defaults to `5`.
- `maxToolCallsPerTurn` defaults to `80`; if the budget is exhausted, Socrates performs a final no-tools model call so the assistant can answer from available evidence.
- Current-turn tool calls/results are passed back to the model until the final answer is reached.
- Later user turns still carry forward prior user/final-assistant dialogue only; old tool calls, tool results, and reasoning are not loaded as semantic prompt history.
- Old tool evidence is available only through `trace_retrieve`.

Workspace/server implementation:

- `packages/workspace/src/tools/` owns local filesystem, search, edit, and shell execution helpers.
- `read` supports bounded file/dir/resource reads, pragmatic text/data extraction, image metadata, and truncation metadata.
- `search` supports bounded file and text search with ignore handling.
- `edit` supports new-file content writes, explicit whole-file overwrites with `overwrite: true`, and exact multiline `oldString`/`newString` replacements with diff previews and approval policy.
- `apply_patch` supports structured `patchText` (`*** Begin Patch`) for multi-hunk, multi-file, create, delete, and rename changes, with intent-aware read-back verification and clear recoverable diagnostics for bad hunks.
- `bash` is the stable model-visible compatibility id for the Terminal tool. User-facing and prompt copy should say Terminal. It uses platform-native shell adapters: POSIX on macOS/Linux, `powershell.exe` then `pwsh` on Windows, and `cmd.exe` as fallback. Do not add separate model-visible PowerShell/cmd/process tools unless the contracts change.
- `bash` uses one non-interactive persistent shell session per active turn for `operation: "run"`, keeps `cwd`/environment across bash calls in that turn, streams output, enforces timeout/output caps, rejects or times out likely interactive commands, and resets the shell after timeout or shell start/write/protocol failures.
- `bash` supports conversation-scoped Terminal sessions with `operation: "start"`, then `status`/`output`/`stop` by no target when exactly one active Terminal exists or by human Terminal name when needed. Terminal/process ids remain internal for UI/runtime compatibility. Runtime ownership lives in the local Terminal supervisor, while SQLite persists metadata and output. On restart, controllable terminals are reconciled through the supervisor; uncontrollable rows become `detached` or `missing` rather than requiring model-visible process ids.
- Long blocking `bash run` commands can auto-detach into a conversation Terminal after `SOCRATES_TERMINAL_AUTO_DETACH_MS` (default 60 seconds). The UI/product copy says Terminal while the model-visible tool id remains `bash`.
- Terminal input is user-only. Conservative prompt detection can mark a Terminal `awaiting_input` and emit `terminal.input.requested`; the frontend shows a Terminal-scoped input box and the backend persists only redacted input markers.
- Windows command policy auto-allows safe diagnostics such as `Get-Location`, `Get-ChildItem`, `Get-Content`, `Select-String`, `Get-Command`, `where`, Python version checks, and safe git inspection; installs, dev servers, Docker, network commands, deletes, migrations, and git mutations remain approval-gated by default.
- Sensitive-path policy allows safe env templates such as `.env.example`, `.env.sample`, `.env.template`, and `.env.local.example`, while real `.env`, private keys, credentials, and secret-like paths remain blocked or high-risk approval-gated.
- `bash` already starts in the active workspace and rejects commands that begin by changing into a guessed absolute path outside that workspace. Relative workspace navigation and approved external destination paths are still allowed.
- The backend injects compact Python environment hints into the Socrates prompt each turn. Existing project-local venvs and package-manager workflows are preferred; when no environment is detected, Socrates should ask before creating one unless the user already requested setup.
- `apps/server/src/services/store/toolStore.ts` persists tool calls, shell commands/output, file operations, patches, approvals, and trace retrieval data. `apps/server/src/services/store/terminalStore.ts` persists conversation Terminal sessions and output chunks.
- `apps/server/src/ws/activeTurns.ts` owns active turn state, approval waiters, abort controllers, and per-turn shell session lifecycle.
- `apps/server/src/ws/conversationTerminals.ts` coordinates conversation-scoped Terminal rows with the durable local Terminal supervisor, output polling, output events, detached/missing reconciliation, user-only stdin, and cleanup.
- `approval.decide` persists the decision and wakes the waiting active turn.

Provider behavior:

- Providers still only normalize model events. They do not execute tools.
- The AI SDK adapter passes Socrates tool definitions to `streamText`, normalizes tool-call parts into Socrates events, and preserves opaque `providerMetadata`.
- Gemini thought signatures are preserved as `providerMetadata.google.thoughtSignature` only inside the active same-turn tool loop and are passed back on assistant tool-call parts for Gemini continuation.
- Gemini thought signatures are not displayed and are not loaded into later-turn semantic history.
- OpenRouter thinking off remains explicit: `providerOptions.openrouter.reasoning = { effort: "none", exclude: true }`.
- OpenRouter still uses AI SDK `smoothStream` for nicer burst rendering after chunks arrive; this does not reduce upstream time-to-first-token.

Frontend behavior:

- Chat transcripts render a Codex-style inline tool timeline instead of card-heavy separate tool panels.
- Tool rows are collapsed by default with icon, status, concise summary, duration, and expandable details.
- Expanded details show inputs, search snippets, read previews, edit diffs, Terminal command/output, trace summaries, resource lists, errors, and completion status.
- The chat workspace now has a persistent Terminal panel hydrated from `GET /api/projects/:projectId/conversations/:conversationId.terminals` and updated by `terminal.started`, `terminal.output`, `terminal.status`, `terminal.input.requested`, `terminal.completed`, `terminal.stopped`, and compatibility stale/detached/missing state changes.
- Approval prompts render inline under the relevant tool row with adjacent Approve/Reject actions.
- Historical `toolRuns` are returned by conversation GET and merged with live WebSocket tool events so completed tool flows reload with conversation history.
- If a turn is cancelled after assistant text streamed, that visible text is persisted as a cancelled partial assistant message, rendered with a stopped indicator, and included in later semantic history as `user_query -> partial_assistant_response -> new_user_query`. Cancelled turn tools/results/reasoning stay audit/UI-only.
- The chat composer shows a dismissible warning for non-vision models when image understanding is relevant; the warning resets for each new conversation or model switch back to a non-vision model.

Resource management:

- Project resources can be removed from the dashboard Files panel with a hover/focus `X`, confirmation, backend deletion, and local state update.
- `DELETE /api/projects/:projectId/resources/:resourceId` marks the row deleted and removes only Socrates-owned uploaded copies inside `<workspace>/.socrates/resources/`.
- Linked, URL, manual, or unknown-owned resources are soft-deleted only; arbitrary external paths are never physically deleted.
- Normal project/resource listings exclude deleted resources.
- `list_project_resources` is intentionally simple for the agent: it lists active Socrates-known project resources as filenames and metadata only.
- `list_project_resources` model-visible inputs are only:

```ts
{
  kind?: "pdf" | "document" | "text" | "image" | "url" | "local_file" | "note" | "other"
  limit?: number
}
```

- `list_project_resources` returns metadata only: `id`, `name`, `kind`, `source`, `uri`, `mimeType`, `sizeBytes`, and `status`. It never returns PDF/image/document contents; the agent must call `read` on a specific `uri` to inspect content.

Prompt/current behavior:

- The Socrates master prompt now describes local-first/project-first behavior, tool choice, context gathering before edits, approval-aware edit/Terminal behavior, verification expectations, `.socrates/` rules, concise user communication, and a restrained Socratic sacred-sage personality.
- When the user asks Socrates to write code, create a script, build a small program, implement something, or build a small app/tool, the prompt has a dedicated code-generation default section. Socrates should create or edit a real workspace/repo file with `edit`, choose a sensible path when obvious, verify when appropriate, and paste a full runnable file in chat only when the user explicitly asks for inline code or no write-capable workspace is available.
- For generated plotting/data scripts, Socrates should save charts/artifacts to files and print their paths by default instead of using GUI-blocking display calls such as `plt.show()`, unless the user explicitly asks for an interactive window.
- Chat markdown code blocks render through a dedicated code-block UI with a language header and copy button. Block code should not reuse inline-code styling.
- `.socrates/` is Socrates-owned project memory/runtime space, not the default location for generated user code.
- `.socrates/resources/` stores uploaded project resources today.
- Future `.socrates/` subfolders may hold scratchpad or memory; the agent should not treat `.socrates/` as random app source or place normal scripts/tests/app files there unless the user asks or the current feature requires Socrates internals/resource/runtime storage work.

Validation commands passed after this sprint:

```text
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

## Trace Retrieval And Context Indexing Planning

Planned the next `trace_retrieve` direction before implementation.

Key decisions:

- `trace_retrieve` should evolve from V0 tool-call lookup into hybrid search/inspect retrieval over Socrates history.
- The model-facing interface should be high-level: natural-language `query`, `mode`, `scope`, optional title/id narrowing, returned `resultNumber`, and exact follow-up ids only after search.
- Opaque ids such as `conversationId`, `messageId`, and `toolId` should be follow-up handles returned by search or backend-filled context, not values the model must know upfront. `conversationId` is allowed as an optional exact narrowing input when same-title conversations collide.
- Retrieval should support broad search first, then exact bounded inspect of a returned `resultNumber` or natural filter when precision matters.
- The backend should introduce an internal trace index layer:

```text
trace_documents
trace_embeddings
trace_index_jobs
```

- `trace_documents` are the canonical searchable corpus behind `trace_retrieve`, derived from raw DB history such as messages, tool calls, shell output, patches, errors, events, turn summaries, conversation summaries, and verbatim anchors.
- Raw DB tables remain the source of truth. Trace documents and summaries do not replace raw messages/tools/events.
- Conversation summaries and compaction summaries are hidden runtime context, not fake user or assistant messages.
- Verbatim anchors preserve exact high-value user source text such as rubrics, canonical examples, "follow this exactly" instructions, and source-of-truth pasted content.
- Embeddings should be generated asynchronously after turns are stored. Chat turns should not wait for embedding jobs.
- Embedding provider access must stay behind provider abstractions. The updated semantic phase direction is OpenAI `text-embedding-3-small` as the hosted default plus offline local embeddings through Ollama as a first-class option.

Docs updated to record this planned direction:

```text
repo_docs/FRONTEND_BACKEND_CONTRACT.md
repo_docs/DB_STRUCTURE.md
repo_docs/APP_FLOW.md
repo_docs/REPO_STRCUTURE.md
repo_docs/PROVIDER_USAGE.md
repo_docs/REPO_RULES.md
```

## Trace Retrieval Search/Inspect Implementation

Implemented the retrieval-only `trace_retrieve` upgrade. This section describes the first version of the tool; the current model-visible shape is summarized in the later "Trace Retrieve Memory Overhaul And Slim Output" section.

- Replaced the V0 `traces` output with search/inspect `results`.
- Search accepts natural `query`, scope, evidence filters, tool/path/command filters, date filters, and bounded limits.
- Inspect accepts returned `resultNumber`, natural filters, or server-side compatibility ids and returns exact bounded source content.
- Added `trace_documents` and `trace_index_jobs`, plus internal SQLite FTS for lexical trace search.
- `TraceStore` owns trace indexing, FTS search, exact inspect, and immediate `build_trace_documents` job processing after completed, failed, and cancelled turns.
- Indexing is new-turn-only; there is no backfill for old DB history.
- Deterministic trace docs cover messages, tool calls, shell output, file operations, patches, errors, turn summaries, and heuristic verbatim anchors.
- Semantic trace retrieval is now available when project embeddings are configured; otherwise it degrades to lexical/exact retrieval with a warning.

TODO:

- Later, hand verbatim-anchor selection to a faster reviewer LLM so high-value exact source text can be marked more intelligently than the current heuristic.

## Trace Retrieve Precision Upgrade

Implemented the `turnNo` precision upgrade for `trace_retrieve`. Current output is message-first and slim, not the older turn-envelope shape.

- Search accepts structured `turnNo` and optional `role` for ordinal recall.
- `turnNo` counts user/Q&A turns inside the resolved conversation. `turnNo: 2, role: "user"` means the user message in the second turn.
- `turnNo` should not be combined with `query`; it is an exact ordinal selector that returns that one Q/A turn, not a text-search hint. If both are sent, the backend runs the query search, ignores `turnNo`, keeps `role` as a query sub-filter, and returns a warning telling Socrates to select either query search or one exact turn.
- There is intentionally no natural-language ordinal fallback. If Socrates puts "second user message" only in `query` and omits `turnNo`, the backend runs ordinary search.
- Broad ordinal lookup with `scope = "recent_conversations"` or `scope = "project"` should be narrowed with `conversationTitle` or `conversationId` when the user clearly names a conversation. Ambiguous or out-of-range turn numbers return warnings instead of fallback results.
- Search results now include slim message-first rows with `resultNumber`, `text`, `entryType`, `conversationTitle`, `conversationId`, and exact `messageId`/`messageNo` or `toolId` when available. The model should prefer `resultNumber` or returned exact ids for follow-up inspect.
- Inspecting `conversationId` returns an ordered bounded conversation bundle using `startTurnNo` and `turnLimit`.
- Exact inspect can fall back to raw persisted rows for returned `messageId`, `toolCallId`, or `turnId` when trace documents are absent. Raw tables remain the source of truth; this is not a trace backfill.

## Trace Embeddings And Semantic Retrieval Implementation

Implemented the semantic trace retrieval phase:

- Added `project_embedding_configs` and `trace_embeddings`, plus `embed_trace_documents` jobs through `trace_index_jobs`.
- Added `EmbeddingProvider` in `packages/providers`, separate from the chat `ModelProvider`.
- Supported hosted OpenAI embeddings with default model `text-embedding-3-small`.
- Supported offline Ollama embeddings with default model `embeddinggemma` and default base URL `http://127.0.0.1:11434`.
- Hugging Face / sentence-transformers remains an advanced future local backend after the Ollama path is stable.
- Added project embedding HTTP endpoints for status, setup check, configure, and reindex.
- Added a project-dashboard Semantic Search panel and modal with Online and Offline setup flows.
- OpenAI credentials remain env-only: server env or a user-selected workspace `.env*` file. The backend reports only key presence and filenames, never secret values.
- Socrates does not silently install Ollama or pull models. Missing Ollama setup returns explicit guidance such as `ollama pull embeddinggemma`.
- Embedding generation is async and in-process. Configure/reindex and newly indexed turns enqueue work without blocking chat turns.
- `trace_retrieve` keeps one model-visible tool with four modes. `mode = "exact"` is the default lexical search over clean conversation memory; `mode = "semantic"` ranks by vector similarity for fuzzy recall; `mode = "combined"` merges lexical and vector evidence when embeddings are ready; `mode = "audit"` is required for tool calls, shell output, file operations, patches, errors, and other runtime evidence.
- `trace_retrieve` search and inspect results now include slim conversation provenance (`conversationTitle`, `conversationId`) so Socrates can name the source chat correctly and avoid calling earlier project evidence "this conversation".
- Retrieval only compares vectors for the active project config: provider id, model id, dimensions, and current trace document content hash must match.
- Raw messages/tools/events remain the source of truth. Embeddings are retrieval rows over `trace_documents`, not fake messages or replacement history.

## Context Compression Planning

Planned the next context-management phase after the `trace_retrieve` upgrade.

Key decisions:

- Compression should happen at provider-call boundaries, not literally in the middle of a running tool call.
- The same mechanism covers both long conversations and long single-turn tasks: before each model call, Socrates assembles the best model-facing context under budget.
- Recent visible user/assistant messages should remain in normal chat-message schema, not be flattened into a summary blob.
- Current active-turn provider/tool protocol must stay valid; older or bulky current-turn tool evidence can be compacted into hidden runtime context with exact inspect handles.
- Older same-conversation material should become hidden compacted context with provenance and `trace_retrieve` inspect handles.
- Previous conversations should not be automatically included in every prompt; they come in through `trace_retrieve` or explicit project/context summaries when relevant.
- Raw messages, tool calls, shell output, patches, errors, and events remain in SQLite as the source of truth. Compaction changes only what is sent to the model.
- Compaction summaries must not be fake user or assistant messages.
- The locked primary compressor model is OpenRouter `deepseek/deepseek-v4-flash` with thinking off.
- The locked fallback compressor model is OpenRouter `stepfun/step-3.7-flash` with thinking off.
- The compressor-model gate compares summary faithfulness, preservation of decisions/rules, usefulness of trace handles, concision, latency, and cost; the latest gate selected DeepSeek v4 Flash by faithfulness tie plus lower output/token usage.

## Context Compression, Recovery, And Diff UI Implementation

Implemented the first contextual compression and recovery slice:

- `packages/core/src/context/contextCompression.ts` owns provider-call-boundary context estimation, packing, compressor prompts, synchronous compaction near `160k`, post-turn precompute near `145k`, a packed-context target near `120k`, and a hard cap of `180k` estimated tokens.
- Compression is enabled by default through the runtime path and can be disabled only with `SOCRATES_CONTEXT_COMPRESSION_ENABLED=false`. It uses OpenRouter `deepseek/deepseek-v4-flash` as the primary compressor and keeps OpenRouter `stepfun/step-3.7-flash` as fallback. Both compressor routes use explicit OpenRouter thinking off.
- `context_compaction_snapshots` stores append-only compaction snapshots with an active/latest marker, previous snapshot id, source ids, structured summary JSON, rendered hidden context, source handles, estimates, compressor model, usage, status, timing, and errors.
- Completed compaction snapshots are indexed into `trace_documents` as hidden `conversation_summary` evidence so `trace_retrieve` can search and inspect summary provenance without creating fake chat messages.
- The WebSocket stream now includes typed `context.compaction.started`, `context.compaction.completed`, and `context.compaction.failed` events. Blocking active-turn compaction emits `started` before awaiting the compressor model, while background precompute stays silent in the live UI. The frontend renders only a subtle `Compacting conversation context...` state.
- Provider calls persist `estimatedTokens` and `contextBudgetTokens` in `model_calls.request_json`; `context_usage_snapshots` records the effective Socrates budget capped at `180k`.
- The conversation HTTP load returns `contextUsage` for the header and optional `partialTurns` recovered from `model_stream_chunks` when a turn stopped, failed, or is still running without a completed assistant message.
- Reloading a failed or interrupted turn now shows recovered partial assistant text, reasoning, and historical tool runs instead of making the last user query look unanswered.
- Context token counting is provider-aware and lives in `packages/providers`: `ModelProvider.countTokens()` counts the assembled next model request, including system prompt, visible messages, hidden compaction summaries, current-turn tool calls/results, and tool definitions/schemas.
- OpenAI/OpenRouter local counts use `js-tiktoken`; unknown/fallback tokenizers include a 15 percent safety margin, and Google may use Gemini provider-exact countTokens near thresholds when credentials are configured. The safety count populates `contextUsage`, `context_usage_snapshots`, and compatibility `estimatedTokens`.
- `tokenUsage` remains provider-reported cost/diagnostic usage. Completed previous turns still enter later prompts as visible user query plus final assistant answer only; old tool results are not replayed unless retrieved or summarized into current context.
- The AI SDK provider adapter aborts idle provider streams after `SOCRATES_MODEL_STREAM_IDLE_TIMEOUT_MS` or the default `120000ms`, producing a structured `model_stream_idle_timeout` error instead of hanging indefinitely.
- Edit approval and completed tool details now prefer focused diffs derived from `edit` operations' `oldText`/`newText`, hide raw literal replacement payloads in approval UI, reject non-unified fake diff text, and render visual Codex-style diff cards through `DiffView`.

## Conversation-Scoped Terminal Sessions Implementation

Implemented the Codex-like Terminal layer on top of Bash v2:

- `packages/contracts` extends internal `bash`/Terminal output with `terminalId`, terminal metadata, terminal statuses, conversation `terminals`, and WebSocket commands/events for `terminal.stop`, `terminal.input`, `terminal.rename`, `terminal.started`, `terminal.output`, `terminal.status`, `terminal.input.requested`, `terminal.completed`, `terminal.stopped`, and legacy/backward-compatible `terminal.stale` paths.
- `apps/server` added `terminal_sessions` and `terminal_output_chunks` plus `TerminalStore`. `shell_commands` remains per-tool provenance and can link to terminal metadata; full long-running Terminal logs live in terminal tables.
- `ConversationTerminalManager` lives at `apps/server/src/ws/conversationTerminals.ts` and owns conversation-scoped process state. It routes `bash start/status/output/stop`, auto-detaches likely long-running `run` commands, broadcasts terminal events, detects conservative user-input prompts, redacts stdin markers, marks persisted running terminals stale on startup, and cleans up on stop/delete/shutdown/TTL.
- Terminal scope is `projectId + conversationId + workspacePath`. Multiple named Terminals can exist in one conversation. They survive turn completion, but are not reattached after server restart.
- The Socrates system prompt now includes bounded Terminal context on every turn: ids, names, command, cwd, shell/platform, status, exit/signal, awaiting-input prompt, and recent output tail. This is current-state context and should survive compression; full logs are not replayed into the prompt.
- The frontend chat workspace has a persistent Terminal panel with status, command/cwd/shell metadata, bounded live output, stop controls, and user-only stdin controls when a Terminal awaits input. Timeline rows still show compact tool provenance and label `bash` as Terminal in UI copy.
- Regression coverage includes contract tests for terminal commands/events, server tests for cross-turn terminal hydration/context injection/stop, schema migration coverage for terminal tables, and workspace stdin process coverage.

## Verified Edit Tool And Debugging Discipline

Implemented the verified edit reliability slice after Terminal v2:

- `read` now returns full-file freshness metadata: `contentHash`, `mtimeMs`, `sizeBytes`, and text `lineEnding` when applicable. The hash represents the full file bytes, not the truncated preview returned to the model.
- Historical note: this slice originally kept patch operations inside `edit` with model-carried base hashes. The current contract later split unified diffs into `apply_patch` and moved edit freshness to the harness-tracked active-turn read state.
- Non-dry-run edits read/stat/hash before writing, write text through a same-directory temp file, immediately read/stat/hash after writing, and fail with recoverable errors such as `edit_stale_content`, `edit_write_failed`, `edit_verification_failed`, or `patch_verification_failed` when disk state does not match Socrates' plan.
- `replace` stays lightweight because exact `oldText` must match current disk content. It still verifies disk after writing before reporting success.
- Completed edit outputs include per-file verification metadata: before/after hashes, before/after byte sizes, line delta, and `verification: "verified"`.
- `apps/server` persists verified edit evidence in existing `file_operations` columns (`content_hash_before`, `content_hash_after`, `metadata_json`) and surfaces that evidence in conversation tool history and trace documents. No DB migration was required.
- The Socrates prompt now requires reading before overwrite/patch, refusing to claim unverified edits, comparing stack traces against current file contents, checking file/module existence before cache guesses, distinguishing DB config/credential errors from service availability, and running the smallest meaningful verification after fixes.
- Regression coverage includes contracts for freshness metadata, workspace tests for stale hashes, read-back verification, Windows-style paths, CRLF preservation, env template policy, patch verification, server tests for persisted edit hashes and recoverable stale-edit failures, and core prompt coverage for debugging discipline.
- Search now treats regex-looking text queries such as `a|b`, `.*`, `\b`, anchors, and character classes as regex unless `regex: false` is explicit; zero-match literal regex-looking searches return warnings. File search now matches case-insensitively against both full relative paths and basenames, including glob queries. The prompt tells Socrates to set `regex=true` for regex syntax and otherwise search simple terms separately.

## v0.1.1 Runtime Release And Windows Install Note

Published the current Terminal v2 plus verified edit/search runtime as GitHub Release `v0.1.1`:

- `main` includes `d9c3028` (`Use release version in runtime manifest`), `f8738e9` (`Bump CLI version to 0.1.1`), and `4a2f1dc` (`Harden edit verification and search reliability`).
- The `v0.1.1` GitHub Release contains `SHA256SUMS`, `socrates-runtime-darwin-arm64.zip`, `socrates-runtime-darwin-x64.zip`, and `socrates-runtime-win32-x64.zip`. Existing `@socrates-ai/cli@0.1.0` clients fetch GitHub Releases `latest`, so rerunning `npx @socrates-ai/cli` should download the `v0.1.1` runtime.
- npm registry publishing of `@socrates-ai/cli@0.1.1` is not complete from this machine because `npm whoami` returned `401 Unauthorized`. `npm publish --access public --dry-run` passed from `apps/cli`, so the remaining npm step is authentication plus real publish.
- Windows first-run/update extraction is a known serious UX issue: the Windows runtime zip is about 496 MiB and the CLI currently extracts with PowerShell `Expand-Archive`, which can take extremely long on some laptops when combined with many files, NTFS writes, and antivirus scanning. Fixing Windows runtime extraction/package size/progress should be treated as the next release/install-performance priority before broad Windows testing.

## v0.1.2 Vision, Tooling, And Runtime-Owned Handles

Prepared the v0.1.2 runtime slice for the npm CLI release path:

- Vision-capable OpenRouter, OpenAI, and Google calls keep native image parts and the full Socrates tool set in the same AI SDK request. The previous OpenRouter workaround that omitted tools when images were present was removed.
- Composer image attachments are copied into `<workspace>/.socrates/attachments/` and remain referenced in the user text so Socrates can reopen exact files later. Vision models receive native image parts; non-vision models receive clear omission/reference text instead of image bytes.
- Context compression no longer serializes base64 image bytes into compressor prompts. Recent native image parts remain available to the actual model call, while compressed history keeps compact metadata and `.socrates/attachments` references.
- The Socrates master prompt explicitly teaches the agent that chat screenshots/images live under `<workspace>/.socrates/attachments/`, are not project resources, and should be reopened with `read` from known attachment paths when native image parts are unavailable or prior-image evidence must be inspected exactly.
- The Socrates prompt now explicitly tells vision-capable models to inspect images as native visual inputs and still use tools until enough evidence has been gathered.
- OpenRouter thinking off remains explicit through `providerOptions.openrouter.reasoning = { effort: "none", exclude: true }`, including provider request-shape coverage.
- `search` now defaults to 20 results, hard-caps model-requested results at 50, skips generated/vendor folders by default, and emits warnings when output is capped or paths are skipped.
- Terminal stdin is usable for running Terminals, not only perfectly detected awaiting-input rows. The UI supports raw input plus quick keys for arrow navigation, Enter, Escape, and Ctrl-C.
- Cancelled streaming preserves partial assistant text through stop/reload instead of letting thinking/tool rows hide or replace the intermediate answer.
- Model-facing tool schemas and prompt context no longer require Socrates to type opaque runtime ids. `bash` status/output/stop can omit the target when exactly one active Terminal exists or use a human Terminal name such as `dev-server`; terminal ids and process ids remain internal for UI/runtime compatibility only.
- `trace_retrieve` search returns numbered slim message-first rows. Model-facing inspect should start with `resultNumber` or returned exact ids such as `messageId`, `conversationId`, or audit `toolId`; natural filters such as `turnNo`, `role`, `query`, `paths`, or `command` remain available where they are appropriate. `conversationHint` is no longer model-facing; use normalized `conversationTitle` or exact `conversationId`.
- Trace retrieval is limited to visible non-deleted conversations (`active` and `archived`). Conversation hard delete removes trace docs, FTS rows, embeddings, and index jobs; orphan trace rows from older deletes are cleaned/excluded. `.socrates/attachments` files intentionally remain on disk and are not proof of active conversation provenance by themselves.
- MiMo Pro is vision-capable in the model catalog and image-read path.
- Tool results sent back into the next model step are sanitized to strip opaque ids from the model-visible output body while preserving provider-required `toolCallId` in the protocol wrapper and full ids in persistence/UI.
- `mcp_registry` model-facing inputs prefer `preset` or `serverName`; opaque server ids are internal/backward-compatible.
- WebSocket reconnect/backoff clears transient connection errors after reconnect and keeps visible assistant/terminal state recoverable through refresh.

## v0.1.3 Trace Retrieval Evidence Windows

Prepared the v0.1.3 runtime slice for the npm CLI release path:

- `trace_retrieve` search snippets now use broader investigation windows centered on the best exact phrase or dense word match, with surrounding line context and raw-message fallback for verbatim anchors.
- The agent preserves model-visible `conversationId`, `messageId`, and `toolId` in `trace_retrieve` outputs and returns a cached warning for duplicate identical `trace_retrieve` calls in one turn.
- `@socrates-ai/cli` and `@socrates/desktop` package versions are bumped to `0.1.3`; the runtime manifest should resolve to `0.1.3` locally and to `v0.1.3` under the GitHub release workflow.

## Trace Retrieve Memory Overhaul And Slim Output

Current `trace_retrieve` direction after the May 31 cleanup:

- Normal retrieval is a conversation-memory tool over visible non-deleted conversations only. It must not surface hard-deleted conversation provenance, orphan trace docs, or previous `trace_retrieve` output as normal evidence.
- `mode = "exact"` is the default lexical path for quoted text, names, file paths, commands, titles, dates, ids, and literal wording.
- `mode = "semantic"` is the vector path for fuzzy recall and should keep model input minimal: `operation`, `mode`, `query`, optional `scope`, and optional `limit`.
- `mode = "combined"` merges lexical and semantic evidence and should also keep model input minimal: `operation`, `mode`, `query`, optional `scope`, and optional `limit`.
- `mode = "audit"` is required for runtime/tool evidence such as tool calls, shell output, file operations, patches, and errors.
- `conversationTitle` replaces the older `conversationHint` input. Matching is normalized for case, punctuation, diacritics, and repeated or extra whitespace. `conversationId` can narrow same-title collisions.
- Query search can be narrowed with model-facing sub-filters: `role`, `entryType`, `hasAttachment`, `createdAfter`, `createdBefore`, `conversationTitle`, and `conversationId`. `turnNo` is not a sub-filter; it remains exclusive ordinal lookup.
- Normal search output is intentionally slim and message-first: each row should have `resultNumber`, `text`, `entryType`, `provenanceKind`, `conversationTitle`, `conversationId`, plus `messageId` and `messageNo` for exact user/assistant messages or `toolId` for audit rows. Assistant rows can include `pairedUserMessageNo` and `pairedUserPreview` so Socrates can answer `user_query x / assistant_response y` without inferring the pair.
- Search snippets should be investigation-friendly, not tiny hit previews: center on the best exact phrase or densest word match, include roughly 7-8 lines of surrounding context where possible, and fall back to the raw source message around a verbatim anchor so quoted-line matches include surrounding evidence.
- The agent preserves model-visible `conversationId`, `messageId`, and `toolId` in `trace_retrieve` outputs and returns a cached warning for repeated identical `trace_retrieve` inputs within one turn instead of re-running the same search loop.
- `entryType = "user_query"` means `messageNo` is the user query number; `entryType = "assistant_response"` means `messageNo` is the assistant response number. `entryType = "continuation_summary"` is fallback evidence only and must not be treated as original message provenance.
- Normal search output must not expose storage/debug fields such as `turnId`, `turnNo`, split `userMessageNo`/`assistantMessageNo`, `inspectArgs`, trace handles, source tables, source ids, raw scores, provenance debug data, project ids, or metadata blobs.
- Exact inspect output should also stay slim: `content`, `entryType`, optional `provenanceKind`, `conversationTitle`, `conversationId`, `messageId`, `toolId`, `messageNo`, paired user metadata for assistant messages, and truncation metadata only when bounded.
- The Socrates prompt should teach the simple path first: search, read the returned `entryType`/`messageNo`/`conversationTitle`, and inspect only when full exact text or deeper audit evidence is needed.
- Previous-image questions should use `trace_retrieve` first for active conversation provenance. If no active provenance is found, Socrates may search/read `.socrates/attachments/`, but it must say the file exists without active conversation metadata rather than inventing a deleted conversation title.
- Current status: contracts/server/core/providers/web/docs have been updated and package tests passed, but the user reported live-model behavior is still not reliable enough. A new chat should start by testing the slim output contract directly against the failing quoted-line prompt, then inspect live tool results before adding more complexity.

Validation commands passed for this slice:

```text
pnpm --filter @socrates/contracts test
pnpm --filter @socrates/core test
pnpm --filter @socrates/server test
pnpm --filter web typecheck
pnpm --filter @socrates/workspace test
pnpm --filter @socrates/providers test
```

## Flat Edit And apply_patch Split (feat-123-cursor)

Split the model-facing file mutation surface to reduce weak-model tool-schema failures while preserving capabilities:

- `edit` is now flat per call: `{ path, content, overwrite? }` for new-file content writes or explicit whole-file overwrite, or `{ path, oldString, newString, replaceAll? }` for targeted multiline replace. Existing-file `content` without explicit overwrite intent fails before writing with recoverable `edit_use_targeted_replace`. No `operations[]`, no discriminated union, and no model-carried `baseContentHash` / `expectedOccurrences`.
- `apply_patch` is a dedicated mutation tool: `{ patchText, dryRun? }` for multi-hunk or multi-file changes. The preferred model input is structured `*** Begin Patch` text with `*** Add File`, `*** Update File`, `*** Delete File`, and `*** Move to`; standard unified diffs remain accepted for compatibility when already valid.
- Patch verification is intent-aware: patched/created targets must exist with verified content, deleted targets must be absent, and renamed targets include `previousPath` while verifying old path absence and new path presence.
- `FileFreshnessTracker` (turn-scoped in `apps/server` `activeTurns`) records `read` `contentHash` values and enforces freshness on existing-file `edit` writes/replaces and `apply_patch` update/delete/rename operations with recoverable `edit_stale_content`.
- `packages/workspace` owns tracker, mutation lock, and patch helpers; `packages/contracts` owns schemas; `packages/core` registers both tools; frontend `editPresentation` reads flat args and routes `apply_patch` through the same diff UI.
- Rule 10 / contract docs amended: `apply_patch` is model-visible; patch is no longer a hidden `edit` mode.

## feat-123-cursor Merge-Readiness Updates

Current branch polish before merge:

- The base model-visible tool registry includes `read`, `search`, `edit`, `apply_patch`, `bash`, `trace_retrieve`, `socrates_memory`, `project_notes`, `repo_docs`, `soul`, `list_project_resources`, and `mcp_registry`. Dynamic MCP tool names can be added only by the MCP runtime after a server is available.
- Terminal model-facing use stays human-handle based. `bash` status/output/stop can omit the target when exactly one active Terminal exists or use the human Terminal name; terminal ids, process ids, and output sequence numbers are internal persistence/UI/supervisor details.
- Long-running Terminals are owned by a durable local supervisor process. Server restart reconciliation marks uncontrollable persisted rows as `detached` or `missing`; `stale` is legacy/backward-compatible status language, not the preferred user/model-facing state.
- Terminal output requests drain supervisor output first, persist new chunks, and return recent DB-backed output by human handle so background polling does not make model-facing output blank.
- MCP setup is routed through `mcp_registry`; Playwright can be configured as a no-secret preset and dynamic MCP tools should not require opaque server ids in model-authored inputs.
- Chat transcript UI now anchors each new user query near the top of the transcript viewport, keeps streamed/partial content visible until hydrated server state arrives, collapses completed tool-heavy work into `Ran X tools`, and uses a more compact composer.
- Final merge validation for this branch should include package tests for contracts/workspace/core/server/providers, `web` typecheck/lint, `git diff --check`, and a manual Socrates smoke over OpenAI, Gemini, edit, apply_patch, Terminal, MCP/Playwright, and chat streaming UI.
