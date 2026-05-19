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

## Backend Foundation Sprint

Implemented the first backend foundation:

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
- Added WebSocket `/ws` skeleton that validates commands with `@socrates/contracts`, emits contract-shaped lifecycle events, enforces one active turn per conversation, supports `chat.turn.cancel`, and persists minimal feedback/error/event records.

This sprint intentionally does not implement real model providers, the agent loop, workspace tools, shell execution, real approvals, or frontend UI behavior.

## Project Workspace And Resource Flow Sprint

Implemented the V1 project workspace flow:

- Added `@socrates/workspace` for native folder picker adapters, workspace scaffold creation, and resource file storage.
- Project creation now requires a real absolute workspace path and creates `<workspace>/.socrates/resources/`.
- `start_from_scratch` and `existing_folder` both create a primary `project_workspaces` row.
- Duplicate active workspace paths are rejected with `workspace_already_attached`.
- Added `POST /api/workspaces/pick-folder` for backend/native folder selection.
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
- The backend loads full completed visible conversation history for V1 multi-turn memory.
- Provider-reported token usage is persisted and `GET /api/projects/:projectId/conversations/:conversationId` returns cumulative token totals for the header.

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
- `chat.message.send` creates/reuses the session, creates the user message and running turn, persists runtime config, loads full history, builds prompt context, and calls `packages/core`.
- Provider reasoning deltas map to `agent.thinking.delta`; answer deltas map to `agent.answer.delta`; final assistant messages map to `message.completed`; lifecycle ends with `turn.completed` or `turn.failed`.
- Real model rows are persisted in `model_calls`, `model_stream_chunks`, `model_usage`, `context_usage_snapshots` when context window metadata is known, and `events`.
- The chat header shows cumulative completed-turn provider token totals after assistant responses complete.
- The chat UI includes compact model and thinking controls, a stop button during active turns, separate thinking rendering, markdown rendering through `react-markdown` and `remark-gfm`, and a small glowing first-token loading indicator.
- Backend env loading currently reads root `.env` and `apps/server/.env`.

Verification commands passed after this slice:

```text
pnpm typecheck
pnpm test
pnpm build
browser smoke with OpenAI multi-turn memory and token total update
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
- Implemented the `/projects/:projectId/chats/:conversationId` chat workspace with centered empty-chat composer, bottom composer after messages, streamed AI transcript, compact model/thinking controls, cumulative token header, first-token loading indicator, and collapsible project/conversation sidebar.
- All UI elements have been properly compartmentalized into `apps/web/src/components/` according to `REPO_RULES`.
- Frontend onboarding, projects, project dashboard, resource upload, model catalog, conversation loading, and WebSocket chat flows are now wired to real backend APIs/contracts through `apps/web/src/lib/api.ts` and `apps/web/src/hooks/useSocratesSocket.ts`.
