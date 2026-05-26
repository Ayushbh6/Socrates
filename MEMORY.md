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
- Development DB path defaults to `app-data/socrates.sqlite`.
- Future production/local app storage should move to `~/.socrates/socrates.sqlite`.
- Future local app packaging must use a backend/native filesystem bridge for project workspace selection and creation.
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
bash
trace_retrieve
list_project_resources
```

- `read`, `search`, `trace_retrieve`, and `list_project_resources` are read-only and parallel-capable.
- `edit` is serialized.
- `bash` is serialized and does not run concurrently with `edit`.
- `maxParallelToolCalls` defaults to `5`.
- `maxToolCallsPerTurn` defaults to `80`; if the budget is exhausted, Socrates performs a final no-tools model call so the assistant can answer from available evidence.
- Current-turn tool calls/results are passed back to the model until the final answer is reached.
- Later user turns still carry forward prior user/final-assistant dialogue only; old tool calls, tool results, and reasoning are not loaded as semantic prompt history.
- Old tool evidence is available only through `trace_retrieve`.

Workspace/server implementation:

- `packages/workspace/src/tools/` owns local filesystem, search, edit, and shell execution helpers.
- `read` supports bounded file/dir/resource reads, pragmatic text/data extraction, image metadata, and truncation metadata.
- `search` supports bounded file and text search with ignore handling.
- `edit` supports create, overwrite, exact multiline replace, and patch-style edits with diff previews and approval policy.
- `bash` uses one non-interactive persistent shell session per active turn, keeps `cwd`/environment across bash calls in that turn, streams output, enforces timeout/output caps, rejects or times out likely interactive commands, and resets the shell after timeout.
- `bash` already starts in the active workspace and rejects commands that begin by changing into a guessed absolute path outside that workspace. Relative workspace navigation and approved external destination paths are still allowed.
- The backend injects compact Python environment hints into the Socrates prompt each turn. Existing project-local venvs and package-manager workflows are preferred; when no environment is detected, Socrates should ask before creating one unless the user already requested setup.
- `apps/server/src/services/store/toolStore.ts` persists tool calls, shell commands/output, file operations, patches, approvals, and trace retrieval data.
- `apps/server/src/ws/activeTurns.ts` owns active turn state, approval waiters, abort controllers, and per-turn shell session lifecycle.
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
- Expanded details show inputs, search snippets, read previews, edit diffs, bash command/output, trace summaries, resource lists, errors, and completion status.
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

- The Socrates master prompt now describes local-first/project-first behavior, tool choice, context gathering before edits, approval-aware edit/bash behavior, verification expectations, `.socrates/` rules, concise user communication, and a restrained Socratic sacred-sage personality.
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
- The model-facing interface should be high-level: natural-language `query`, scope, conversation hint, evidence type, tool name, path, command, and returned handles.
- Opaque ids such as `conversationId`, `turnId`, `messageId`, and `toolCallId` should be follow-up handles returned by search or backend-filled context, not values the model must know upfront.
- Retrieval should support broad search first, then exact bounded inspect of a returned handle when precision matters.
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

Implemented the retrieval-only `trace_retrieve` upgrade:

- Replaced the V0 `traces` output with search/inspect `results`.
- Search accepts natural `query`, scope, conversation hints, evidence filters, tool/path/command filters, date filters, and bounded limits.
- Inspect accepts returned handles or ids and returns exact bounded source content.
- Added `trace_documents` and `trace_index_jobs`, plus internal SQLite FTS for lexical trace search.
- `TraceStore` owns trace indexing, FTS search, exact inspect, and immediate `build_trace_documents` job processing after completed, failed, and cancelled turns.
- Indexing is new-turn-only; there is no backfill for old DB history.
- Deterministic trace docs cover messages, tool calls, shell output, file operations, patches, errors, turn summaries, and heuristic verbatim anchors.
- Semantic trace retrieval is now available when project embeddings are configured; otherwise it degrades to lexical/exact retrieval with a warning.

TODO:

- Later, hand verbatim-anchor selection to a faster reviewer LLM so high-value exact source text can be marked more intelligently than the current heuristic.

## Trace Retrieve Precision Upgrade

Implemented the `turnNo` precision upgrade for `trace_retrieve`:

- Search accepts structured `turnNo` and optional `role` for ordinal recall.
- `turnNo` counts user/Q&A turns inside the resolved conversation. `turnNo: 2, role: "user"` means the user message in the second turn.
- There is intentionally no natural-language ordinal fallback. If Socrates puts "second user message" only in `query` and omits `turnNo`, the backend runs ordinary search.
- Broad ordinal lookup with `scope = "recent_conversations"` or `scope = "project"` requires a `conversationHint`; ambiguous hints and out-of-range turn numbers return warnings instead of fallback results.
- Search results now include ready-to-call `inspectArgs`, explicit source ids such as `messageId`/`toolCallId`, and raw source provenance.
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
- `trace_retrieve` keeps one model-visible tool. `mode = "combined"` merges lexical and vector evidence when embeddings are ready; `mode = "semantic"` ranks by vector similarity first.
- `trace_retrieve` search and inspect results now include conversation provenance (`conversation.title`, status, updated time, and `isCurrentConversation`) so Socrates can name the source chat correctly and avoid calling earlier project evidence "this conversation".
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
- The locked fallback compressor model is OpenRouter `qwen/qwen3.6-plus` with thinking off.
- The compressor-model gate compares summary faithfulness, preservation of decisions/rules, usefulness of trace handles, concision, latency, and cost; the latest gate selected DeepSeek v4 Flash by faithfulness tie plus lower output/token usage.

## Context Compression, Recovery, And Diff UI Implementation

Implemented the first contextual compression and recovery slice:

- `packages/core/src/context/contextCompression.ts` owns provider-call-boundary context estimation, packing, compressor prompts, synchronous compaction near `160k`, post-turn precompute near `145k`, a packed-context target near `120k`, and a hard cap of `180k` estimated tokens.
- Compression is enabled by default through the runtime path and can be disabled only with `SOCRATES_CONTEXT_COMPRESSION_ENABLED=false`. It uses OpenRouter `deepseek/deepseek-v4-flash` as the primary compressor and keeps OpenRouter `qwen/qwen3.6-plus` as fallback. Both compressor routes use explicit OpenRouter thinking off.
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
