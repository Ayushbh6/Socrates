# Socrates App Flow

This document defines the initial product flow, route structure, and page responsibilities for Socrates.

Socrates is project-first. Users do not start with a floating global chat. They enter a project, use project resources and instructions, then create or resume conversations inside that project.

## Route Summary

```text
/welcome
/onboarding
/settings
/projects
/projects/new
/projects/:projectId
/projects/:projectId/chats/:conversationId
```

Avoid this shape:

```text
/projects/:projectId/dashboard/:dashboardId
```

The project itself is the dashboard. A separate dashboard id adds complexity without representing a real entity.

## First-Run Flow

```text
open app
  -> /welcome
  -> check local database
  -> if no onboarded user exists, go to /onboarding
  -> if onboarded user exists, go to /projects
```

The first-run check should use local SQLite state, not browser-only local storage.

The local SQLite file defaults to `~/.Socrates/socrates.sqlite`. `SOCRATES_HOME` changes the app-data directory, and `SOCRATES_DB_PATH` points at an explicit SQLite file for tests or recovery. Repo-local `app-data/socrates.sqlite` is only a legacy development import source.

## Browser Development Launch Flow

The current dev-test path is the browser app, not the desktop/Tauri shell.

Development launch:

```text
terminal 1: pnpm --filter @socrates/server dev
  -> starts Fastify APIs and WebSockets on 127.0.0.1:4000

terminal 2: pnpm --filter web dev
  -> starts the Next.js UI on 127.0.0.1:3000

open http://127.0.0.1:3000
```

The server still owns the SQLite path. By default it stores durable data at `~/.Socrates/socrates.sqlite`; browser dev testing must not invent a separate database path.

## Desktop Launch Flow

The desktop shell lives in `apps/desktop` and wraps the existing web/server app instead of duplicating runtime logic.

Desktop/Tauri launch is not the normal dev-test path. Use it only when specifically working on the future desktop shell or release packaging:

```text
pnpm desktop:dev
  -> Tauri starts
  -> beforeDevCommand runs apps/desktop/scripts/dev-services.mjs
  -> script starts apps/server on 127.0.0.1:4000 if needed
  -> script starts apps/web on 127.0.0.1:3000 if needed
  -> Tauri opens the web UI at http://127.0.0.1:3000
```

The desktop shell must also use the same server-owned SQLite path and must not invent a separate database path.

Production/internal-tester bundle flow:

```text
pnpm desktop:bundle
  -> build server dist
  -> build Next standalone web runtime
  -> deploy server production dependencies
  -> download/copy official Node runtime matching the builder Node version
  -> copy launcher, server, web, migrations, and Node into apps/desktop/runtime/
  -> tauri build bundles runtime as native app resources
```

npm CLI release flow:

```text
push SemVer tag, for example v0.1.2
  -> GitHub Actions builds unsigned runtime zips for macOS arm64, macOS x64, and Windows x64
  -> each runtime zip includes a fixed Node runtime for app processes and native dependency ABI compatibility
  -> SHA256SUMS and runtime zips are attached to GitHub Releases
  -> users run npx @socrates-ai/cli
  -> CLI downloads/verifies/extracts the matching runtime under ~/.Socrates/runtimes/
  -> CLI starts the backend and web sidecars and opens the browser
```

The npm CLI path is the primary distribution path until paid desktop signing is available. The signed Tauri release workflow is manual-only and reserved for a future polished desktop release.

The CLI fetches the latest GitHub Release runtime by default, so older published launcher packages can still pick up newer runtime zips. Publishing the npm package version is useful for launcher metadata, `--version`, and launcher-only fixes, but runtime rollout is driven by the GitHub Release assets. The CLI should resolve and download assets through direct `github.com/.../releases/.../download/...` URLs first, using REST release metadata only as a fallback, so unauthenticated GitHub API rate limits do not block `npx` installs. Windows runtime extraction should prefer `tar.exe`, with PowerShell `Expand-Archive` only as a fallback, because `Expand-Archive` is slower on the large Windows archive and has been unreliable with `./`-prefixed zip entries. Runtime archive creation must write root entries such as `launcher.mjs` and `manifest.json` directly, without a `./` prefix or wrapper directory.

Current runtime release is GitHub Release `v0.1.15`. It includes the v0.1.8 provider/cache/runtime fixes, the compressor refactor, memory-agent packing fix, proactive investigation harness, repo-docs preflight gate, durable project-memory checkpoint, OpenRouter GLM 5.2 model/pricing update, extension-discovery/context stabilization, the Memory Center plus identity/user-profile cleanup work, duplicate primary-memory section recovery, evidence-index guidance, and duplicate primary-doc heading normalization. Current npm launcher is `@socrates-ai/cli@0.1.15`. The launcher prefers direct GitHub Release asset URLs before falling back to REST metadata so rate limits do not block public `npx` installs.

On packaged app startup, Tauri loads the static startup screen, chooses free localhost ports, starts the bundled Node launcher, waits for the web runtime, then navigates the main window to the local Next server. The launcher starts the backend first, waits for `/health`, starts the web server with `SOCRATES_API_BASE_URL` pointing at the backend, and exits both child services when Tauri exits.

Provider credentials:

```text
CLI/browser app
  -> user saves provider key through onboarding or /settings
  -> backend writes the secret to ~/.Socrates/.env with restricted local file permissions
  -> backend also keeps the key in the current process session

packaged Tauri app
  -> user saves provider key through onboarding or /settings
  -> Tauri writes the secret to OS keychain
  -> Tauri injects configured keys into the sidecar process environment at launch
  -> frontend also posts the key to the local backend session so the current process can use it immediately
```

OpenRouter is required for the default chat and compression path. OpenAI is required only when the user selects hosted OpenAI embeddings instead of local Ollama embeddings. Google is optional. The backend and frontend must return only credential presence/source/status, never secret values.

Manual update flow:

```text
/settings
  -> Check for updates
  -> Tauri updater reads latest.json from GitHub Releases
  -> user chooses Install
  -> updater downloads signed artifact and asks for restart
```

## Returning-User Flow

```text
open app
  -> /welcome
  -> check local database
  -> /projects
```

The welcome page can be brief and atmospheric. It should not become a marketing site.

## `/welcome`

Purpose:

- Introduce Socrates.
- Give the app a calm, polished first impression.
- Route the user based on onboarding state.

Visual direction:

- Apple-inspired.
- Minimal.
- Airy.
- High contrast where needed.
- No clutter.
- No dense feature explanation.

Primary action:

```text
Open Workspace
```

Routing:

```text
if users.onboarding_completed = false or no user row exists:
  /onboarding
else:
  /projects
```

## `/onboarding`

Purpose:

- Create the local user profile.
- Ask the user what Socrates should call them.
- Mark onboarding as complete.

Fields:

```text
display_name
```

Submit action:

```text
Next
```

Database effects:

```text
create users row if missing
set users.display_name
set users.onboarding_completed = 1
set users.onboarded_at
```

Routing after submit:

```text
/projects
```

Important:

- This page should not ask for provider keys yet.
- This page should not ask for complex preferences yet.
- Keep it focused on the user's name.

## `/projects`

Purpose:

- Show all projects.
- Let the user create a project.
- Let the user open an existing project.

Primary UI:

- Project list/grid.
- Search projects.
- New project button.

Initial project creation:

```text
Create project -> enter project title -> optional description -> connect a local workspace folder
```

Later options can include:

```text
Clone from GitHub
Import project archive
```

Database reads:

```text
projects
project_workspaces
recent conversation/activity metadata
```

Routing:

```text
click project -> /projects/:projectId
new project -> /projects/new
```

## `/projects/new`

Purpose:

- Create a project container.
- Attach Socrates to a real local workspace folder.
- Create the project metadata in SQLite.
- Create the project-local Socrates scaffold inside the workspace.

Fields:

```text
project title
description
workspace folder
```

Required fields:

```text
project title
workspace folder
```

Optional fields:

```text
description
```

Workspace behavior:

```text
user enters project title
user optionally enters description
user connects any local folder through the backend/native picker or pastes an absolute path
backend verifies the folder exists and is a directory
backend inspects whether <workspace>/.socrates already exists
if .socrates exists, frontend asks whether to use it or delete/create fresh
backend creates or preserves <workspace>/.socrates/resources/ according to that choice
```

Folder selection is owned by the local backend/native bridge, not browser-only filesystem APIs. In dev V1 the frontend calls the backend picker directly instead of relying on the Next rewrite because native picker requests can be long-running. The frontend also keeps a manual absolute-path fallback.

V1 invariant:

```text
Every active Socrates project must have exactly one primary local workspace folder.
```

Database effects:

```text
create projects row
create project_workspaces row with is_primary = 1
store project_workspaces.path as the absolute workspace path
emit project.created event
emit project.workspace.attached event
```

Filesystem effects:

```text
create <workspace>/.socrates/
create <workspace>/.socrates/resources/
```

If the selected folder already contains `.socrates`, Socrates must not silently reuse or delete it. The frontend shows a modal with `Use existing` as the default safe action and `Delete and create fresh` as the destructive action. `Use existing` keeps existing `.socrates` contents and appends future resources. `Delete and create fresh` deletes only that selected folder's `.socrates` directory and recreates `.socrates/resources/`.

Socrates should not edit the workspace root `.gitignore` in V1. Users can ignore `.socrates/` themselves if they want. A future version may offer an explicit opt-in action for that.

Routing after creation:

```text
/projects/:projectId
```

## `/projects/:projectId`

This is the project dashboard.

Purpose:

- Show project context.
- Show project resources.
- Show project instructions.
- Show past conversations.
- Show semantic search / embedding setup status.
- Start a new chat.

Primary areas:

```text
project header
centered start new chat action
conversation list
resource panel
instructions panel
semantic search panel/action
workspace status
```

Project header:

- Show the project title.
- Show the optional project description only as a bounded preview.
- Store the full description in SQLite, but do not render unbounded text on the dashboard.
- The preview should fit below the project name without stretching the layout. Prefer a two-line clamp with a safe character fallback around 80 characters plus `...`.

Resource panel:

- Uploaded PDFs.
- Documents.
- Text notes.
- Images.
- Links.
- Local files selected as references.

V1 uploaded files are copied by the backend into:

```text
<primary_workspace>/.socrates/resources/
```

The resulting `project_resources.uri` points to the stored local file path.

File upload behavior:

- Clicking the files add action opens the file upload control.
- Users may select up to 10 files at once.
- The backend stores each uploaded file under the primary workspace `.socrates/resources/` folder and creates one `project_resources` row per file.
- Direct files manually copied into `.socrates/resources/` are synced into `project_resources` when project resources are listed or the dashboard loads. This is one-way metadata sync for direct files in that folder, not a chat attachment import.
- Removing a resource asks for confirmation, marks the resource row as `deleted`, removes it from project context, and deletes only Socrates-owned uploaded copies inside `.socrates/resources/`.
- If a Socrates-owned resource file is manually removed from `.socrates/resources/`, normal resource listings mark that resource deleted and stop showing it.
- The file panel should show uploaded file previews with filename, type, and size when known.
- The preview area must have a bounded height. It may show around four file previews before becoming scrollable.
- The file panel must not grow indefinitely when a project has many resources.

Instructions panel:

- Project-specific guidance.
- Persistent instructions for conversations in this project.
- Clicking the instructions add/edit action opens a modal with a large text area.
- Saving instructions writes the full content to `project_instructions`.
- The dashboard panel displays only a bounded preview of saved instructions. Prefer a two-line clamp with a safe character fallback around 100 characters plus `...`.
- Empty instructions should show the add-instructions prompt.

Conversation list:

- Existing conversations in this project.
- Last message preview.
- Last activity time.
- Status.
- Empty projects should continue to show the current empty state.
- Each conversation row should include a compact `...` actions menu.
- The row actions menu includes `Rename` and `Delete`.
- Rename updates the persisted conversation title.
- Delete removes the conversation and its conversation-scoped data from the database. It is not archived in the current V1 flow.

Actions:

```text
Start new chat
Open existing chat
Rename conversation
Delete conversation
Add resource
Edit instructions
Set up semantic search
Open workspace folder
Edit workspace connection
```

Routing:

```text
start new chat -> create conversation -> /projects/:projectId/chats/:conversationId
open existing chat -> /projects/:projectId/chats/:conversationId
back to all projects -> /projects
```

Workspace editing:

```text
project dashboard -> Workspace panel -> Edit
user picks or pastes a new absolute folder path
backend/frontend inspect for an existing .socrates directory
user chooses Use existing or Delete and create fresh when needed
backend blocks the switch if any turn in the project is active
backend detaches the old primary workspace and creates one new active primary workspace
backend copies active uploaded resources from old .socrates/resources to the new workspace
```

### Project Embedding Setup Flow

The project dashboard exposes project-scoped semantic search setup. This is project infrastructure, not a per-chat model selector.

Dashboard action states:

```text
not configured -> Enable semantic search
queued/running job -> Embedding index running
ready and indexed -> Semantic search enabled
provider unavailable or failed -> Fix embeddings
```

Clicking the dashboard action opens a modal. Prefer user-facing language such as "Enable semantic search" on the dashboard, while the modal can use the technical term "embeddings".

Modal entry:

```text
Choose embedding mode
  Online
  Offline
```

Online flow:

```text
1. Choose hosted provider
   OpenAI text-embedding-3-small
2. Check API key
   backend checks server env and user-triggered workspace .env* key presence
3. Preview indexing
   show trace document count / estimated work when available
4. Start indexing
   save project embedding config and enqueue embed_trace_documents jobs
5. Progress
   queued/running/completed/failed counts, lexical search still available while indexing
```

The online flow must clearly state that trace document text is sent to OpenAI for embedding generation.

Offline flow:

```text
1. Choose local backend
   Ollama recommended
   Hugging Face / sentence-transformers advanced later
2. Check local setup
   backend checks Ollama server reachability and selected model availability
3. Choose local model
   embeddinggemma recommended initially
   alternatives: mxbai-embed-large, nomic-embed-text, all-minilm
4. Setup guidance
   show exact commands such as ollama pull embeddinggemma when missing
5. Start local indexing
   save project embedding config and enqueue jobs
6. Progress
   same status surface as online
```

Socrates must not silently install Ollama or download embedding models. The offline setup flow only detects local state and shows explicit commands for the user to run.

The project dashboard must not show the full chat composer in V1. The composer belongs on `/projects/:projectId/chats/:conversationId`. The dashboard shows a centered `Start new chat` button/action instead.

## `/projects/:projectId/chats/:conversationId`

Purpose:

- Main Socrates chat workspace.
- Show the conversation transcript.
- Let users send messages inside a project-scoped conversation.
- Stream agent events over WebSocket.
- Show streamed thinking when the selected provider exposes it.
- Show streamed final assistant answers.
- Show the Terminal shell for active and recent conversation terminals: a compact right rail for overview/history plus an on-demand bottom dock for focused interaction on desktop, and a full-screen terminal sheet on mobile.
- Show the latest estimated model-facing context size next to the conversation title.

Primary layout:

```text
left/nav area
  project and conversation navigation

main chat area
  user messages
  thinking blocks
  assistant messages
  tool-call timeline
  terminal panel
  feedback controls
  composer

right panel
  artifacts
  diffs
  previews
  project resources
  terminal output when relevant
```

Left sidebar behavior:

- The chat route includes a collapsible left sidebar.
- The whole sidebar can be collapsed. When collapsed, it disappears completely and leaves only a small reopen button at the top-left edge of the chat workspace. Do not leave a rail, thin sidebar strip, or hidden chat text behind.
- When expanded, the collapse control lives inside the sidebar header.
- The sidebar header is `Projects`.
- The sidebar lists existing projects only. Users cannot create new projects from this sidebar in V1.
- Each project row shows the project name, a small `+` action to start a new chat in that project, and a collapse/expand control for that project's chats.
- Clicking a project name routes to that project's dashboard.
- Clicking the project `+` creates a conversation in that project and routes to `/projects/:projectId/chats/:conversationId`.
- Expanding a project shows that project's conversations.
- Clicking a conversation routes to its chat page.
- A project with many conversations must not stretch the sidebar indefinitely. The conversation list inside an expanded project should have a bounded height and become scrollable after roughly 10 to 15 chats.
- Sidebar state such as collapsed projects may be local UI state in V1.

Chat states:

- Empty conversation: no messages have been sent yet. The composer is centered in the main chat area.
- Active conversation: once the first user message is sent, that message appears in the transcript and the composer moves to the bottom of the chat area.
- Existing conversation: load persisted messages and keep the composer at the bottom.
- While a turn is waiting for the first provider token, show a small loading indicator in the assistant area.
- Once thinking or answer text begins streaming, replace the loading indicator with the live stream.

Composer controls:

- Text input.
- Send.
- Stop while a turn is active.
- Compact model selector rendered from `GET /api/models`.
- Compact thinking selector rendered from the selected model's backend-owned thinking options.

Composer behavior:

- Pressing Enter sends the message when the input has non-empty trimmed text.
- The send button on the right sends the message when the input has non-empty trimmed text.
- Sending the first message creates the first session and turn for the conversation.
- The frontend should not call any model provider directly.
- The chat page subscribes its WebSocket to the active conversation with `chat.conversation.subscribe` on initial connect and reconnect.
- The frontend sends `chat.message.send` over WebSocket for the real AI path.
- The older no-AI HTTP message endpoint remains available but is not the normal chat UI send path.

Composer run-state behavior:

```text
no active turn -> show send arrow and allow sending
active turn -> show stop button and block sending another query
stop button -> send chat.turn.cancel
turn.completed / turn.failed / turn.cancelled -> show send arrow again
```

V1 uses cancel/stop, not true pause/resume.

Active AI turns continue while the local backend process is alive even if the browser refreshes, the user switches conversations, the tab sleeps, or the socket reconnects. Live events are persisted and then broadcast to the sockets currently subscribed to that conversation. Returning to a running conversation replays the active-turn event stream and hydrates persisted partial text through HTTP. The active-turn lock is per conversation: a running turn in one conversation does not block starting a turn in another conversation. Closing the app/backend process stops that runtime boundary; on next startup, stale active turns are reconciled as stopped/cancelled rather than shown as still live.

If assistant answer text has already streamed when the user stops a turn, the backend persists that visible text as a cancelled partial assistant message. The transcript keeps showing it with a stopped indicator, and later model turns receive the semantic shape `user_query -> partial_assistant_response -> new_user_query`. Tool calls/results/reasoning from the cancelled turn remain persisted for audit/UI only.

If a running, failed, or cancelled turn has streamed text but no completed assistant message row, `GET /api/projects/:projectId/conversations/:conversationId` can return a `partialTurns` entry recovered from `model_stream_chunks`. The frontend renders that incomplete turn with recovered answer text, reasoning, and persisted historical tool runs, and it can restore stop-button state when the turn is still running after reload.

The same conversation response returns active and recent `terminals` so reloads hydrate the Terminal shell. Terminal response entries include bounded stdout/stderr tails, optional raw PTY replay text, and process metadata for the desktop rail, bottom dock, and mobile sheet, not the complete log archive.

Runtime settings are per turn:

```text
provider
model
thinking_enabled
thinking_effort
approval_mode
sandbox_mode
max_output_tokens
temperature
```

These settings are stored in `turn_runtime_configs`.

WebSocket behavior:

```text
web sends user message or transcribed voice message
server validates event
core starts turn
provider streams model events
tools emit progress events
server streams typed events back to web
web renders live state
db records every event
```

Current V1 agent scope:

```text
enabled:
  multi-turn model conversations
  per-turn model and thinking selection
  streamed thinking and answer events when exposed by provider
  assistant markdown rendering
  provider usage persistence
  header context estimate from context usage snapshots or model-call request fallback
  backend-injected user/project/instruction prompt context
  read-only current_time tool for current date, ISO timestamp, and time zone
  workspace tools
  approvals
  shell/file/patch execution
  contextual compression events and hidden compaction summaries
  incomplete-turn recovery from persisted stream chunks

not yet enabled:
  dedicated git tool
  sub-agent/task/todo tools

accepted next/refactor direction:
  memory_note for Socrates-to-Memory-Agent leads
  Memory Agent skill freshness suggestions and approved update requests
  Skill Writer Agent as a real specialized agent path, not a one-off provider workflow
```

## Tooling And Context Management Target

The current base model-visible tool surface is:

```text
read
search
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

The main-agent `memory_note` tool is intentionally small: Socrates supplies only a human `note` and optional `importance`; the backend attaches the current user message, conversation id, message id, turn id, source project, workspace path when available, and a default project-local skill-scope hint automatically. Those refs are backend lookup values for later trace chaining, not fields Socrates should manually write into the note.

`read` handles bounded reads of files, directories, PDFs, documents, slide decks, structured data, and images. Its default model-visible output cap is an estimated 4,000 tokens, and the hard model-requested `tokenLimit` cap is 6,000 estimated tokens across all readable formats. `charLimit` still exists for compatibility and offset paging, but the effective returned text is bounded by both `charLimit` and the token cap, with clear truncation metadata. File reads include full-file freshness metadata (`contentHash`, `mtimeMs`, `sizeBytes`, and line endings for text) so later edits can prove they are based on current disk content. The first implementation should use pragmatic local extractors or lightweight parsers rather than overbuilding a full document-processing platform.

`search` handles both file discovery and grep-style text search. It respects ignore files by default, skips nuisance/generated/binary paths by default, defaults to at most 20 results, hard-caps requested results at 50, and returns warnings when output is capped or vendor/generated paths are skipped. Text queries that look like regex syntax (`|`, `.*`, `\b`, character classes, anchors, etc.) are interpreted as regex unless `regex: false` is explicit, and zero-match literal regex-looking searches return a warning. File search matches case-insensitively against both full relative paths and basenames, including glob-style queries.

`edit` is the primary V1 model-visible single-file mutation tool. Existing files should use targeted `oldString`/`newString` replacements; `content` is for new files unless `overwrite: true` explicitly requests a deliberate full-file rewrite. New deliverables, scratch files, or generated files derived from files in a subfolder should be written with an explicit path in that same subfolder or nearest relevant existing folder; the workspace root is appropriate only when the user asks for it, the artifact is truly project-level, or the task is standalone workspace-level work with no relevant subfolder. `apply_patch` is the separate multi-hunk or multi-file patch tool. Its model-facing input is `patchText`; models should prefer the structured `*** Begin Patch` envelope with `*** Add File`, `*** Update File`, `*** Delete File`, and `*** Move to` sections because it avoids fragile unified-diff hunk counts. `@@` labels are optional hints, and the old lines inside the hunk are the real match target. Standard unified diffs are still accepted for compatibility when already valid and are applied via `git apply`. Both mutation tools require approval unless the user explicitly runs a full-access mode. Non-dry-run mutations read/stat/hash before writing and immediately verify disk after writing; returned `changedFiles` include verified hashes and size/line metadata. Existing-file edits, patches, deletes, and renames require a prior `read` in the active turn; after a successful mutation, another mutation to the same file must re-read first. Before `edit`, `apply_patch`, or any approval-required mutation runs, Socrates must have read, searched, or edited `repo_docs` in the same turn; missing preflight surfaces recoverable `repo_docs_preflight_required`. The harness tracks freshness from read results instead of model-carried hashes. Stale, unread, non-explicit overwrite, and failed read-back verification cases surface as recoverable tool errors, so Socrates must re-read or switch to targeted replacement rather than claim a write succeeded. Generic `edit` and `apply_patch` writes to `<workspace>/.socrates/MEMORY.md`, `<workspace>/.socrates/PROJECT_NOTES.md`, and `<workspace>/.socrates/repo_docs/*.md` are rejected; those docs remain normally readable/searchable but must be changed through `project_docs` or `repo_docs`.

Generated-app debugging should be evidence-first. For stack traces, Socrates should compare the reported file and line with current file contents before guessing. For import errors, it should verify the file tree, package roots, working directory, and target module file before blaming stale caches. For database failures, it should distinguish credentials/config from service availability by inspecting safe config/templates and Terminal logs, then run the smallest meaningful verification after a fix.

`bash` is the compatibility id for the Terminal tool. It runs platform-native PTY commands from the active project workspace, while UI/product copy says Terminal. macOS/Linux use POSIX shell adapters while Windows uses ConPTY through `powershell.exe`, then `pwsh`, then `cmd.exe` fallback. `operation: "run"` is the default and executes a fresh PTY command that returns a lightly normalized terminal transcript plus exit/status metadata; separate `run` calls do not preserve exported environment or cwd. Foreground mutating `run` commands are serialized by the per-workspace mutation queue across concurrent conversations, including Git commits/checkouts, package installs, and file-generating scripts. Read-only commands can run concurrently, and `operation: "start"` launches conversation-scoped background PTY Terminals such as dev servers, REPLs, prompts, watchers, and basic TUI apps without holding the mutation queue forever. `status`, `output`, and `stop` inspect or terminate a Terminal without rerunning it. Model-authored status/output/stop should omit the target when exactly one active Terminal exists or use the human Terminal name shown in context. Terminal/process ids and output cursors remain internal for UI/runtime compatibility. Long blocking or obviously interactive `run` commands can auto-detach into a Terminal after `SOCRATES_TERMINAL_AUTO_DETACH_MS` (default 15 seconds). It has a default timeout of 120 seconds for blocking runs, streams output, persists full command/Terminal output and shell/process metadata for retrieval, and relies on policy to auto-allow, approval-gate, or deny commands. It remains an approved fallback for cases where `read`, `search`, or `edit` are insufficient; Socrates should not block a legitimate approved command solely because a specialized tool exists.

Conversation terminals are scoped by `projectId + conversationId + workspacePath`. Multiple named terminals can run in one conversation. A turn may complete while terminals continue running; later turns receive a bounded terminal-context summary with names, statuses, commands, cwd, and recent output, but not opaque ids. Model-facing Terminal control uses human names/targets only; supervisor process ids and output cursors stay internal. Started Terminal `status`, `output`, and `stop` return only newly model-visible output since the last model-visible terminal check; full output chunks remain persisted for the UI and trace audit. Starting a Terminal with an already-running name reuses the existing Terminal and returns newly visible output instead of spawning a duplicate. Running terminals are stopped on explicit stop, conversation delete, workspace switch, app shutdown, or idle TTL (`SOCRATES_TERMINAL_IDLE_TTL_MS`, default 2 hours). On server restart, previously running terminals are reconciled through the local supervisor when possible; uncontrollable entries become `detached` or `missing` rather than model-facing process plumbing.

The frontend Terminal shell is xterm-backed. It replays bounded persisted PTY output after refresh/reconnect, sends raw keyboard/paste data through `terminal.input`, and sends `terminal.resize` when the active xterm surface changes. Desktop uses a compact right rail for overview/history and a bottom dock for focused terminal use; the dock auto-opens when a Terminal is awaiting user input. Mobile uses a full-screen terminal sheet. If a terminal appears to be waiting for user input, the backend emits `terminal.input.requested`. Only the user can send stdin; the agent must ask the user for the needed input, stop its response, and wait for the next user turn. Prompt detection alone is not interactivity success; success requires user input and follow-up Terminal output. Model-authored `stop` is rejected while a Terminal is awaiting user input, while the user stop control still cancels it. Raw stdin is redacted from persistence and model context.

Terminal already starts in the active workspace. Commands that begin by changing into guessed absolute paths outside that workspace are rejected. For subfolder commands, Socrates should pass `cwd` instead of prefixing commands with `cd`. Before Terminal commands create files or directories, Socrates should verify the intended parent directory exists and use an explicit relative path or `cwd` so outputs do not accidentally land in the workspace root. Relative workspace navigation and approved external destination paths remain allowed.

Workspace runtime scan facts are not injected into the system prompt. The backend maintains a protected `runtime_context` section in `<workspace>/.socrates/PROJECT_NOTES.md` with compact generated workspace facts such as detected stack, package manager, and virtual-environment hints. It is not a background file watcher; the section refreshes lazily when `project_docs` touches notes and rewrites only when the generated signature changes. Socrates should read project notes when workspace runtime facts matter, use existing project-local environments or detected package-manager workflows when present, ask before creating a new environment when none is found, and save generated plot artifacts to files instead of blocking on GUI display unless the user explicitly asks. Terminal output, live terminal state, dependency dumps, package lists, and root-script inventories must not be persisted in this notes section.

Current date/time is not injected into the Socrates system prompt. The read-only `current_time({})` tool returns backend-owned `currentDate`, `currentDateTime`, `timeZone`, and `source: "system"`. Socrates should call it for date-sensitive answers, filenames, logs, or document prose that truly needs today's date. It should not derive today's date from older project documents or previous conversations.

Main chat does not inject a per-turn wake-context block. Stable recall guidance belongs in the base prompt, and changing facts stay behind tools: `project_docs` for notes/memory, `repo_docs` for doctrine, `current_time` for date/time, `skills` for reusable workflows, and `mcp_registry` for MCP servers. The runtime must not inject hidden skill or MCP matches based on words in the user's prompt.

`trace_retrieve` retrieves previous conversation memory only when useful. Normal search prevents historical tool dumps from being carried forward or recursively re-retrieved, while explicit `mode = "audit"` keeps full runtime evidence available through SQLite. `mode = "audit"` with `include: ["shell"]` covers foreground shell commands and detached conversation Terminal sessions/chunks through the same investigative shell evidence path; no extra terminal-specific model input parameters are required. Its searchable corpus is limited to visible non-deleted conversations (`active` and `archived`); hard-deleted conversations and orphan trace rows must not be returned.

`tool_docs` is a read/search interface over global Socrates tool-usage guidance. It is the right place to inspect tool behavior before retrying failed tools or using unfamiliar/edge-case tools.

`skills` is a model-visible discovery/inspection tool for builtin, global, and project skills. The preferred model path is `skills({ operation: "list" })` with an optional `scope`, followed by `skills({ operation: "describe", id: "<exact-listed-id>" })` or an exact listed `name`. `list` returns compact rows with id/name/scope/description; `describe` returns the selected `SKILL.md` content. The main Socrates agent cannot create, edit, or delete skills through this tool. Skill creation/update should route through explicit UI approval plus the Skill Writer Agent, whose narrow internal write path is `skill_write`.

`project_docs` is the constrained read/search/index/edit interface for `<workspace>/.socrates/MEMORY.md` and `<workspace>/.socrates/PROJECT_NOTES.md`. Memory is durable cross-conversation project state; notes are active working state such as todos, active project context, checked files, next commands, restart points, and the protected backend-generated `runtime_context` section. Runtime project docs are structured markdown with stable section ids, so agents should prefer `read_index`, `read_section`, and `patch_section` when the section is known. Tool outputs include system runtime date/time metadata, and successful docs mutations stamp frontmatter with backend-owned `updated_at`, `updated_by`, and `last_edited_section`. Any `project_docs` call for notes first ensures `runtime_context`; agents cannot patch that section directly, and terminal output and live terminal state do not belong there. After meaningful work, the runtime injects one bounded checkpoint if `project_docs memory` has not been updated. A notes edit alone does not satisfy durable memory closure.

`repo_docs` is the constrained read/search/index/edit interface for durable workspace doctrine under `<workspace>/.socrates/repo_docs/`. Project access creates the four structured template files `CORE_IDEA.md`, `REPO_NAVIGATION.md`, `REPO_RULES.md`, and `CONTRACTS.md` when missing, without overwriting user-edited files. Tool outputs include system runtime date/time metadata, and successful docs mutations stamp frontmatter with backend-owned `updated_at`, `updated_by`, and `last_edited_section`. Socrates should read repo docs before meaningful implementation and update these docs after durable repo behavior, architecture, contracts, data rules, provider usage, workflows, or pitfalls change.

`user_profile` is a read-only model-visible access path for `~/.Socrates/user_profile.md`, which stores durable user profile, stable cross-project preferences, and global active context. It supports `read`, `read_index`, and `read_section`; Socrates should prefer index then section reads, while full reads are reserved for whole-document needs and capped at 8,000 chars. The main agent cannot write it; the backend memory agent updates it through scoped `edit_files`. The `active_context` section is only for currently useful user-life context that is global across projects; project-specific active context belongs in that workspace's project notes. The `evidence_index` section is for compact retrievable anchors behind important profile claims: date, project/conversation title or id, turn/message/event id or trace handle when available, the supported claim, and the profile section using that claim.

`soul` is the read-only model-visible access path for `~/.Socrates/identity.md`, which now contains core identity, voice/presence, relationship-to-user, operating-principle, safety-boundary, and tool/memory-discipline sections. It supports `read`, `read_index`, and `read_section`; Socrates should prefer index then section reads, while full reads are reserved for whole-document needs and capped at 8,000 chars. It cannot write. Identity edits are backend memory-agent owned: the memory agent proposes exact oldText/newText patches, the backend verifies target text and hashes, then a second internal model call must answer the literal confirmation prompt `You are about to make changes to the soul. Are you sure?` with exact `yes` before the patch is applied. Applied identity updates are audited and create persistent top-right notifications with compact diffs. Standalone `operating_principles.md` is retired and removed during global memory initialization.

The backend Global Memory Agent replaces the old diary-only helper. It is a scheduled/manual app-level `SocratesAgent` run over completed-turn event manifests after the durable `events.sequence` watermark, not a per-turn project worker. Manifest packing adds completed turns one by one and stops before either 80 turns or the 60k estimated-token cap. The Memory Agent also consumes Socrates-authored memory notes as high-signal leads. Its responsibility is to classify evidence before action, keep `user_profile.md`, `identity.md`, and skill freshness up to date, and mark processed notes done. It may update user profile directly through scoped edits, may update identity only through the existing confirmation policy, and should send approved skill create/update tasks to the Skill Writer Agent instead of writing final skill markdown itself. The memory-agent model call uses the same V1 170k context-compression trigger as normal chat calls, but passes memory mode so `memoryCompactionSchema` and `memoryAgentCompressorPrompt.ts` compact old memory-agent context. Failures are logged in events and memory-agent tables and must not fail the user chat turn.

Memory Center (`/memory`) is the global memory-agent UI. It contains agent status, pending signal, model/thinking/cadence settings, run history, global MCP controls, global skill creation/deletion, and read-only memory files. It must remain a fixed-shell professional UI: header and footer do not scroll, the middle region is the scroll surface, and on desktop the left content and right Memory Files rail scroll independently. Core Memory shows only `identity.md` and `user_profile.md`; `operating_principles.md` is not a file card because those principles are a section inside Identity.

## Memory Notes And Skill Writing Target

Socrates-to-Memory-Agent communication should be a simple backend-backed notepad, not a complex model-facing A2A envelope. For the main Socrates agent, the create tool is:

```text
memory_note({
  note: "This turn shows the user's strong preference for human-facing contracts and simple agent handoffs. Review whether it is durable.",
  importance: "high"
})
```

On create, the backend automatically attaches the current user message excerpt, conversation id, message id, turn id, source project, workspace path when available, and default project-local skill-scope hint. Socrates should write the human note only. It should not copy ids into the prose unless the user specifically gave an external id as part of the task. It should not ask for a skill, invent a skill name, choose project/global scope, or name a target memory section.

The Memory Agent receives a separate `memory_notes` inbox:

```text
list
  returns at most 10 numbered rows with importance, source project/workspace metadata, default skill-scope hint, and the first short note slice

read(noteNumber)
  returns full note, attached user message excerpt, and backend trace lookup ids

mark_done(noteNumber, resolution)
  closes the item with a one-line reason after profile, identity, skill-freshness, or deliberate skip handling is complete
```

The read result deliberately includes trace lookup ids so the Memory Agent can chain into `trace_retrieve` for the full conversation/tool evidence. The note is a lead, not the whole memory item.

Memory Agent classification comes before writes. Durable facts, preferences, allergy/safety boundaries, and global active user context belong in `user_profile.md` with evidence anchors when important. Project-specific active context belongs in `.socrates/PROJECT_NOTES.md` and should be skipped by the global Memory Agent with an explicit resolution. Rare Socrates behavior/identity changes go through the identity confirmation path. Only reusable procedures become skill proposals; weak or current-turn-only leads should be skipped and marked done with a one-line reason.

Skill proposal scope is owned by the Memory Agent. Socrates-originated notes carry a backend default of project scope because they came from a project turn; the Memory Agent keeps that scope for most project-local workflows and upgrades to global only when the procedure is clearly reusable across projects. Autonomous Memory Agent skill proposals also choose project or global scope.

Memory Agent skill freshness flow:

```text
completed turns or memory note
  -> Memory Agent inspects trace evidence and full existing SKILL.md content
  -> Memory Agent creates a user-visible skill proposal or update proposal
  -> user approves manually by default, with auto-approve possible later
  -> approved task goes to Skill Writer Agent
  -> Skill Writer Agent writes/updates the final SKILL.md through skill_write
```

Skill Writer Agent is a craft executor. It should not decide whether a skill should exist, accept or reject the product intent, or run broad investigation. It should always perform the approved create/update task unless its read, validation, or scoped write tools fail. There is no fourth agent behind it: `skill_write` is just the narrow save/validation tool.

Skill Writer Agent tools should be narrow:

```text
trace_retrieve
skills list/describe/read full skill content
skill_write for final create/update only
user_profile read-only
soul read-only
project_docs read-only for project skills
repo_docs read-only for project skills
current_time when truly needed
```

It should not receive Terminal, arbitrary filesystem read/write, generic patch tools, identity/profile writes, project/repo docs writes, or raw path mutation tools.

Settings exposes independent worker model selectors for Skill Writer, Context Compactor, Title Generator, and Memory Router. Each selector uses the normal model registry and thinking options, with defaults preserving the current production choices. Memory Router controls the pre-turn and post-evidence structured routing calls and defaults to OpenRouter `deepseek/deepseek-v4-flash` with thinking off.

`mcp_registry` is the model-visible MCP discovery/inspection tool. The model-facing contract is intentionally just `list` and `describe`: `list` returns compact global plus project-visible servers with canonical ids, names, scopes, descriptions, and the first tool previews; `describe` takes an exact listed `id` or exact listed `name`, loads that single server, and returns docs plus dynamic `mcp__...` tool names. UI/API flows handle configure, check, enable/disable, and delete. The system prompt carries only concise registry-first guidance; it must not dump MCP server tool lists or schemas. The first provider call exposes only the core tools plus `mcp_registry`; dynamic `mcp__...` tool names may be added to later same-turn provider requests only after the registry/runtime reports them available.

The intended trace retrieval flow is search first, exact inspection second:

```text
agent needs older context
  -> trace_retrieve search with query, mode, scope, and bounded limits
  -> backend searches clean conversation memory with exact, semantic, or combined retrieval
  -> result returns compact numbered message-first evidence rows
  -> if exact wording matters, agent calls trace_retrieve inspect using resultNumber, messageId, or toolId
  -> backend returns bounded raw message, summary, or audit evidence
```

Normal `trace_retrieve` uses `mode = "exact"` by default over the last 10 visible conversations and returns top 5 results. Use exact for names, filenames, paths, dates, ids, commands, and quoted wording. Use `mode = "semantic"` for fuzzy conceptual memory and `mode = "combined"` for hybrid recall; both intentionally take only `query`, optional `scope`, and optional `limit`. Use `mode = "audit"` only for tool calls, shell output, file operations, patches, errors, and runtime debugging. If `messageId` is present it returns that exact message; if `mode = "audit"` and `toolId` is present it returns that exact tool call. `conversationTitle` narrows exact/audit search to matching visible conversation titles using normalized, case-insensitive, punctuation/space-tolerant matching; `conversationId` can narrow same-title conversations after search returns it.

Normal search rows are intentionally small: `resultNumber`, `text`, `entryType`, `conversationTitle`, `conversationId`, plus `messageId` and `messageNo` when the row is an exact `user_query` or `assistant_response`. `entryType = "continuation_summary"` is fallback evidence only and must not be treated as original message provenance. The model should not need opaque ids before retrieval; after search, it may use `resultNumber`, `messageId`, or audit `toolId` for exact follow-up inspection.

Ordinal recall uses a stricter path. If the user asks for one turn such as "the second user message" or "turn 4", Socrates must put the literal integer in `turnNo` and, when relevant, set `role` to `user` or `assistant`; omitting role returns the user and assistant message rows for that turn. `turnNo` is for single-turn lookup and takes precedence over `conversationLimit`; use `conversationLimit` for broad multi-conversation recall. The backend does not parse ordinal phrases out of `query`; this avoids false positives such as matching "turn 2" against "turn 20". Project/recent ordinal searches may return multiple matching visible conversations, so Socrates should inspect the relevant result before making exact claims.

Supported retrieval scopes should include:

```text
current_conversation
recent_conversations
project
```

Conversation hints should be natural language, for example:

```text
"the previous conversation about retrieval tools"
"two conversations ago"
"the chat named assignment rubric"
```

Backend code resolves those hints against project conversations, titles, timestamps, summaries, and indexed trace documents.

`list_project_resources` lists active project resources from backend records, especially uploaded files stored under `.socrates/resources/`. It accepts only `kind` and `limit`, returns filenames and metadata only, and defaults to a modest bounded list. The agent should prefer it before shell directory probing when the user asks about uploaded resources, then call `read` on the returned URI/path when content inspection is needed.

Resource listing syncs direct files from `.socrates/resources/` into backend records first, so files copied there manually from VS Code/Finder are visible to both the dashboard and `list_project_resources`. Chat image attachments live under `.socrates/attachments/` and are not project resources. User messages include attachment references with filename, MIME type, size, and path, so the agent can reopen exact uploaded screenshots/images with `read` when the native image part is no longer in the visible prompt or when prior-image evidence is retrieved with `trace_retrieve`. Attachment files intentionally remain on disk after conversation deletion; if trace has no visible conversation provenance but a file exists in `.socrates/attachments`, Socrates should describe the file and state that the original conversation metadata is unavailable, likely because the conversation was deleted.

Generated code belongs in the attached workspace/repo, not in `.socrates/`. When the user asks Socrates to write code or create a script/program, Socrates should use `edit` to create the file in a sensible repo location. If the work is based on files in a subfolder, generated outputs should stay in that subfolder or the nearest relevant existing folder unless the user says otherwise. If the location is ambiguous and the user says Socrates can decide, use that nearest relevant folder when one is known; use the repo root only for genuinely project-level or standalone workspace-level work, or a small well-named folder for natural multi-file work.

Between user queries, Socrates should carry forward final user/assistant dialogue, not full historical tool-call dumps. Within the current turn, tool calls and tool outputs may be passed back to the model until the final answer is reached.

Active, detached, or missing Terminal summaries are current-state context, not old transcript replay. The backend injects bounded terminal context into every new turn: human Terminal name, command, cwd, shell/platform, status, exit/signal, awaiting-input state, safe prompt text, and recent PTY/stdout tail. Full terminal logs stay persisted as ordered chunks and inspectable through terminal output polling or trace retrieval. Opaque terminal ids, process ids, PTY chunk sequences, and resize details stay internal.

Provider-exposed thinking is shown and stored when available, but it is not used as semantic prompt context for later user queries.

Gemini thought signatures and similar provider-specific tool-call metadata are same-turn-only continuation metadata. They may be carried while the active run is resolving tool calls, but they must not become later-turn semantic conversation history.

## Compaction And Exact Source Recall

When conversation context grows too large, Socrates should compact hidden runtime context without mutating the visible transcript.

Bad behavior:

```text
append "Summary: ..." as a fake user or assistant message
replace exact source text with vague summary only
lose access to a user's canonical pasted rules or rubric
```

Correct behavior:

```text
raw messages/events/tools stay in SQLite
visible chat messages stay visible messages only
context builder includes hidden summaries when needed
trace_retrieve can inspect exact source handles
```

The context builder should keep recent visible user/assistant messages exact while older turns are represented by compact hidden summaries. When exact older content matters, summaries should point to inspectable handles.

Context compression must preserve active terminal anchors: human Terminal names, commands, status, awaiting-input state, latest actionable output/prompt, and source handles for exact recovery. It must not stuff full terminal logs or opaque process handles into hidden context.

Compression applies to both common long-chat growth and long single-turn work. A conversation such as `Q1/A1 ... Q70/A70` should keep recent Q/A pairs as normal `user` and `assistant` messages while older Q/A pairs move into hidden compacted context. A single large task should use the same mechanism before the next model call: keep the current user request and latest critical evidence exact when possible, but compact older current-turn tool outputs into hidden evidence capsules with exact inspect handles.

Compression should run only at safe provider-call boundaries:

```text
before first model call in a turn
after a batch of tool results, before the next model call
before a final no-tools answer when tool budget is exhausted
after turn completion, asynchronously, for durable summaries/anchors
```

It should not rewrite the visible transcript. It should not create fake assistant messages such as "Summary: ...". Recent real chat remains real chat schema; hidden compacted context is additional runtime context for the model.

Current implementation thresholds:

```text
trigger at 170k estimated input tokens
recent completed-turn raw tail target around 50k tokens
current-turn tool-result raw tail target around 50k tokens
keep at least the latest 5 current-turn tool results when possible
```

There is one V1 trigger: before each provider call, Socrates counts the assembled model-visible input. If it is below 170k, the request proceeds. If it is at or above 170k, compaction runs before sending the next provider call. Recent completed Q/A turns stay raw by whole-turn boundary, never cut mid-turn. Older head context is summarized into hidden markdown. For long active turns, older bulky tool results are converted into lightweight progress statements while preserving the newest whole tool results. Global Memory Agent calls use the same trigger with memory-mode compression, so the memory compressor prompt and structured memory schema are used instead of the chat compressor prompt/schema.

The estimate is provider-aware. Before each model call, Socrates counts the assembled next provider request through `packages/providers`, including the system prompt, visible messages, hidden compaction summaries, active tool calls/results, and tool definitions/schemas. Completed earlier turns still contribute only visible user query plus final assistant answer.

Compression is enabled by default and can be disabled only with `SOCRATES_CONTEXT_COMPRESSION_ENABLED=false`.

The chat header displays the latest estimated model-facing context usage, for example `23,433 tokens`, plus the cumulative conversation cost from completed turn usage reports. Provider-reported token usage remains persisted for compatibility diagnostics, but `turn_usage_reports` and `ai_usage_events` are the source of truth for cost/cache reporting. Memory Router usage is included in the same total through `ai_usage_events`, not displayed as a separate cost category. If exact provider cost is unavailable, computed costs are clearly marked through usage quality flags and the frontend cost marker.

Socrates' answer voice should hide machinery by default. It can use tools, docs, memory, ids, hashes, model names, and backend state internally, but the final answer should sound like a capable human collaborator unless the user explicitly asks for exact audit details.

Example:

```text
Turn 2:
  user pastes a long rubric and says "use this format throughout"

Later compaction:
  hidden context summary says:
    "The canonical question-writing rubric was provided in Turn 2.
     It is high-priority and must be followed exactly.
     Retrieve exact source handle msg_... before generating final questions."

trace index:
  stores exact rubric chunks as verbatim anchors
```

Verbatim anchors are exact preserved chunks for high-value source material. They should be created when the user provides:

- Rubrics.
- Canonical examples.
- "Follow this exactly" instructions.
- "Use this throughout" guidance.
- Source-of-truth copied text.
- Long user messages likely to be referenced repeatedly.

This gives Socrates three context levels:

```text
recent exact messages
compact hidden summaries
exact retrievable anchors
```

`trace_retrieve` is the bridge between compact summaries and raw evidence. Broad search can find likely relevant history; exact inspection can open the one message, turn, tool call, or shell output needed to avoid RAG noise.

Current implementation note:

```text
trace_retrieve search supports lexical/exact and active project embeddings
mode = exact is the default lexical search
mode = combined merges lexical and vector evidence when embeddings are ready
mode = semantic ranks by vector similarity when embeddings are ready
mode = audit searches runtime/tool evidence only
search and inspect results include conversation provenance
context compaction snapshots are indexed as hidden conversation_summary evidence
```

Compressor-model selection:

```text
primary: OpenRouter deepseek/deepseek-v4-flash with thinking off
fallback 1: OpenRouter xiaomi/mimo-v2.5-pro with thinking off
fallback 2: OpenRouter z-ai/glm-5.2 with thinking off
```

The local/release evaluation should keep using identical conversation/tool-history fixtures and compare faithfulness, preservation of exact decisions/rules, trace-handle usefulness, concision, latency, and cost. OpenRouter thinking off must use the explicit reasoning-off provider options documented in `PROVIDER_USAGE.md`.

OpenRouter cache-friendly routing uses a stable project/conversation cache-affinity key, sent as top-level `session_id` and `prompt_cache_key` provider options. Socrates no longer leaves multi-provider routing empty: multi-provider OpenRouter models send price-first routing with `sort: "price"` and `allow_fallbacks: true`, while DeepSeek V4 routes use cheap-compatible ranked provider orders. After the first OpenRouter call in a turn reports its actual routed provider, later continuations in that same turn prefer that provider while keeping fallbacks allowed. Deliberate provider pins use OpenRouter provider slugs, not display labels; title-generation routes pin `deepinfra` or `alibaba`. OpenRouter usage metadata is persisted with routed provider, raw usage, cache-read/write tokens, and provider response metadata; when provider cost is absent, Socrates computes a marked estimate from the versioned endpoint-pricing snapshot in `packages/providers`.

The frontend listens for `context.compaction.started`, `context.compaction.completed`, and `context.compaction.failed`. Blocking active-turn compaction emits `started` before awaiting the compressor model so the UI can show a small `Compacting conversation context...` state during the wait. Background precompute remains silent in the live UI and does not add transcript messages.

When showing or answering from retrieved history, Socrates must use the returned `conversationTitle` and `entryType`. It should report message numbers only when the row has `entryType` of `user_query` or `assistant_response` and includes `messageNo`; `continuation_summary` rows are fallback leads, not exact message provenance.

Semantic retrieval is available through two first-class options:

```text
hosted default: OpenAI text-embedding-3-small
offline local: Ollama embeddinggemma by default, with Hugging Face / sentence-transformers as an advanced local backend later
```

Embedding generation stays asynchronous after trace document creation. It should not block chat turns, and if the selected embedding provider is unavailable Socrates should continue with lexical/exact retrieval plus a warning.

## Project-Scoped Conversations

Every conversation belongs to exactly one project.

```text
projects.id -> conversations.project_id
```

This keeps the app organized:

```text
Project
  resources
  instructions
  conversations
    turns
    messages
    events
```

Global chats should not exist in V1.

## Resource Flow

```text
user adds resource
  -> copy/upload file-backed resources to <workspace>/.socrates/resources/
  -> create project_resources row
  -> emit project.resource.created event
  -> resource becomes available to future project conversations
```

Resources are project-level context, not conversation-only context by default.

The default V1 resource storage location is:

```text
<primary_workspace>/.socrates/resources/
```

Do not scatter uploaded resources into arbitrary workspace folders.

Later, a conversation can pin or select a subset of project resources if needed.

## Chat Creation Flow

```text
user clicks New chat on project dashboard
  -> create conversations row with project_id
  -> title = "New conversation"
  -> no session is created yet
  -> route to /projects/:projectId/chats/:conversationId
```

The first user message creates the first `session`, `turn`, and user `message`.

```text
user sends first message
  -> create or reuse active session for the conversation
  -> create turns row for the agent lifecycle
  -> create messages row with role = "user"
  -> create turn_runtime_configs row for selected provider/model/thinking settings
  -> build model history from prior user messages and final assistant answers
  -> inject user display name, project name, full project description, and full project instructions into the Socrates system prompt
  -> count the assembled provider-call request, including active tools/tool evidence and tool schemas
  -> stream model output through packages/core and packages/providers with provider-owned cache-affinity/routing options
  -> for OpenRouter continuations in the same turn, prefer the first actual routed provider reported by usage metadata while keeping fallbacks allowed
  -> create assistant message on completion
  -> persist model_calls, model_stream_chunks, model_usage, context_usage_snapshots when a context window is known, and events
  -> update conversations.updated_at
  -> if this is the first user message, set a short placeholder title and start background generated-title replacement
```

Conversation title behavior:

- A newly created conversation starts with the persisted title `New conversation`.
- When the first user message is sent, the backend immediately updates the conversation title to the first 15 normalized characters followed by `...` when truncated.
- If the first message is image-only, the immediate placeholder is `Image chat...`.
- In the WebSocket chat path, the backend then generates a personalized title from the first text/image message. It tries OpenRouter `meta-llama/llama-4-maverick` with cost-aware routing first, and falls back to OpenRouter `qwen/qwen3.5-flash-02-23` with cost-aware routing if Llama does not return a title.
- Generated title updates are emitted as `conversation.updated` so the sidebar/header can replace the placeholder without a full refresh.
- Later user messages do not auto-rename the conversation.
- Manual rename through the conversation row menu overrides the title.

## Chat Deletion Flow

```text
user chooses Delete from a conversation row menu
  -> confirm destructive action in the UI
  -> delete conversation-scoped rows in a backend transaction
  -> delete conversations row
  -> refresh the dashboard/sidebar conversation list
```

Deleting a conversation does not delete:

- The owning project.
- Project instructions.
- Project resources.
- Workspace files outside conversation-scoped artifacts.

V1 conversation delete is a hard delete. It does not set `conversations.status = "deleted"` and does not archive the conversation.

## Voice Input Flow

```text
user records voice
  -> create voice_inputs row
  -> transcribe
  -> create normal user message from transcript
  -> create normal turn
```

Voice input is a message creation path, not a separate conversation type.

## Read-Aloud Flow

```text
user clicks read aloud on assistant message
  -> create audio_outputs row
  -> generate or play audio
  -> attach optional audio artifact
```

Read aloud is attached to an assistant message.

## Feedback Flow

```text
user clicks thumbs up/down
  -> create or update message_feedback row
  -> emit feedback.created or feedback.updated event
```

Feedback should attach to the exact message, turn, or model call being rated.

## Frontend Hooks

Socrates should use its own React hooks around its own WebSocket and HTTP contracts.

Initial hooks:

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
useVoiceInput()
useReadAloud()
useMessageFeedback()
```

Do not make `@ai-sdk/react` the core chat state engine in V1. Socrates needs typed events richer than a normal chat stream.

## Design Notes

The first UI should feel calm and serious, not busy.

Guidelines:

- Build the actual app, not a marketing landing page.
- Keep `/welcome` minimal and polished.
- Keep `/onboarding` one step.
- Make `/projects` practical and uncluttered.
- Make project dashboards resource-aware.
- Keep chat event-rich but visually organized.
- Render fenced code blocks as readable standalone blocks with language labels, copy buttons, and horizontal scrolling. Do not let inline-code styling make block code unreadable.
- Do not copy Claude/Codex visuals directly; use them only as interaction references.
