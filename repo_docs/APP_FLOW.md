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

## Desktop Launch Flow

The desktop shell lives in `apps/desktop` and wraps the existing web/server app instead of duplicating runtime logic.

Development launch:

```text
pnpm desktop:dev
  -> Tauri starts
  -> beforeDevCommand runs apps/desktop/scripts/dev-services.mjs
  -> script starts apps/server on 127.0.0.1:4000 if needed
  -> script starts apps/web on 127.0.0.1:3000 if needed
  -> Tauri opens the web UI at http://127.0.0.1:3000
```

The server still owns the SQLite path. By default it stores durable data at `~/.Socrates/socrates.sqlite`; the desktop shell must not invent a separate database path.

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

The CLI fetches the latest GitHub Release by default, so older published launcher packages can still pick up newer runtime zips. Publishing the npm package version is still useful for launcher metadata and `--version`, but runtime rollout is driven by the GitHub Release assets. Windows runtime extraction currently uses PowerShell `Expand-Archive` and can be very slow on some machines because the Windows archive is larger and contains many files. Improving Windows extraction speed, archive size, and progress reporting is a release-quality priority.

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
- Show a persistent Terminal panel for active and recent conversation terminals.
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

If assistant answer text has already streamed when the user stops a turn, the backend persists that visible text as a cancelled partial assistant message. The transcript keeps showing it with a stopped indicator, and later model turns receive the semantic shape `user_query -> partial_assistant_response -> new_user_query`. Tool calls/results/reasoning from the cancelled turn remain persisted for audit/UI only.

If a running, failed, or cancelled turn has streamed text but no completed assistant message row, `GET /api/projects/:projectId/conversations/:conversationId` can return a `partialTurns` entry recovered from `model_stream_chunks`. The frontend renders that incomplete turn with recovered answer text, reasoning, and persisted historical tool runs, and it can restore stop-button state when the turn is still running after reload.

The same conversation response returns active and recent `terminals` so reloads hydrate the Terminal panel. Terminal response entries include bounded stdout/stderr tails and process metadata, not the complete log archive.

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
  workspace tools
  approvals
  shell/file/patch execution
  contextual compression events and hidden compaction summaries
  incomplete-turn recovery from persisted stream chunks

not yet enabled:
  dedicated git tool
  sub-agent/task/todo tools
```

## Tooling And Context Management Target

The first tooling phase exposes seven model-visible tools:

```text
read
search
edit
apply_patch
bash
trace_retrieve
list_project_resources
```

`read` handles bounded reads of files, directories, PDFs, documents, slide decks, structured data, and images. Its default `charLimit` is 20,000 characters, with a normal backend per-call cap of 80,000 characters and clear truncation metadata. File reads include full-file freshness metadata (`contentHash`, `mtimeMs`, `sizeBytes`, and line endings for text) so later edits can prove they are based on current disk content. The first implementation should use pragmatic local extractors or lightweight parsers rather than overbuilding a full document-processing platform.

`search` handles both file discovery and grep-style text search. It respects ignore files by default, skips nuisance/generated/binary paths by default, defaults to at most 20 results, hard-caps requested results at 50, and returns warnings when output is capped or vendor/generated paths are skipped. Text queries that look like regex syntax (`|`, `.*`, `\b`, character classes, anchors, etc.) are interpreted as regex unless `regex: false` is explicit, and zero-match literal regex-looking searches return a warning. File search matches case-insensitively against both full relative paths and basenames, including glob-style queries.

`edit` is the primary V1 model-visible single-file mutation tool. Existing files should use targeted `oldString`/`newString` replacements; `content` is for new files unless `overwrite: true` explicitly requests a deliberate full-file rewrite. `apply_patch` is the separate unified-diff tool for multi-hunk or multi-file changes. Both require approval unless the user explicitly runs a full-access mode. Non-dry-run mutations read/stat/hash before writing and immediately verify disk after writing; returned `changedFiles` include verified hashes and size/line metadata. Existing-file `edit` calls require a prior `read` in the active turn; the harness tracks freshness from read results instead of model-carried hashes. Stale, unread, non-explicit overwrite, and failed read-back verification cases surface as recoverable tool errors, so Socrates must re-read or switch to targeted replacement rather than claim a write succeeded.

Generated-app debugging should be evidence-first. For stack traces, Socrates should compare the reported file and line with current file contents before guessing. For import errors, it should verify the file tree, package roots, working directory, and target module file before blaming stale caches. For database failures, it should distinguish credentials/config from service availability by inspecting safe config/templates and Terminal logs, then run the smallest meaningful verification after a fix.

`bash` is the compatibility id for the Terminal tool. It runs platform-native shell commands from the active project workspace, while UI/product copy says Terminal. macOS/Linux use POSIX shell adapters while Windows tries `powershell.exe`, then `pwsh`, then `cmd.exe` fallback. `operation: "run"` is the default and uses one non-interactive shell process per active turn, so `cwd` and exported environment can persist across Terminal calls inside that turn. `operation: "start"` launches a conversation-scoped Terminal; `status`, `output`, and `stop` inspect or terminate a Terminal without rerunning it. Model-authored status/output/stop should omit the target when exactly one active Terminal exists or use the human Terminal name shown in context. Terminal/process ids remain internal for UI/runtime compatibility. Long blocking `run` commands can auto-detach into a Terminal after `SOCRATES_TERMINAL_AUTO_DETACH_MS` (default 60 seconds). It has a default timeout of 120 seconds for blocking runs, streams output, persists full command/Terminal output and shell/process metadata for retrieval, and relies on policy to auto-allow, approval-gate, or deny commands. It remains an approved fallback for cases where `read`, `search`, or `edit` are insufficient; Socrates should not block a legitimate approved command solely because a specialized tool exists.

Conversation terminals are scoped by `projectId + conversationId + workspacePath`. Multiple named terminals can run in one conversation. A turn may complete while terminals continue running; later turns receive a bounded terminal-context summary with names, statuses, commands, cwd, and recent output, but not opaque ids. Model-facing Terminal control uses human names/targets only; supervisor process ids and output cursors stay internal. Starting a Terminal with an already-running name reuses the existing Terminal and returns its recent output instead of spawning a duplicate. Running terminals are stopped on explicit stop, conversation delete, workspace switch, app shutdown, or idle TTL (`SOCRATES_TERMINAL_IDLE_TTL_MS`, default 2 hours). On server restart, previously running terminals are reconciled through the local supervisor when possible; uncontrollable entries become `detached` or `missing` rather than model-facing process plumbing.

If a terminal appears to be waiting for user input, the backend emits `terminal.input.requested` and the frontend shows a Terminal-scoped input box. Only the user can send stdin through `terminal.input`; the agent must ask the user for the needed input and must not invent stdin. Raw stdin is redacted from persistence and model context.

Terminal already starts in the active workspace. Commands that begin by changing into guessed absolute paths outside that workspace are rejected. Relative workspace navigation and approved external destination paths remain allowed.

The backend also injects compact Python and shell environment hints from the active workspace. Socrates should use existing project-local environments or package-manager workflows when present, use PowerShell-compatible command syntax on Windows, ask before creating a new environment when none is found, and save generated plot artifacts to files instead of blocking on GUI display unless the user explicitly asks.

`trace_retrieve` retrieves previous conversation and execution evidence only when useful. It prevents historical tool dumps from being carried forward in every later prompt while keeping full auditability through SQLite.

The intended trace retrieval flow is search first, exact inspection second:

```text
agent needs older context
  -> trace_retrieve search with natural-language query, scope, and optional conversation hint
  -> backend searches indexed trace documents with scoped SQLite FTS/exact retrieval
  -> result returns compact numbered evidence plus provenance
  -> if exact wording matters, agent calls trace_retrieve inspect using resultNumber or natural filters
  -> backend returns bounded raw message/tool/shell/patch/error text
```

The model should not need to know opaque ids before retrieval. `conversationId`, `turnId`, `messageId`, and `toolCallId` remain internal/source-provenance details and compatibility fields, not values Socrates should type into normal tool calls.

Ordinal recall uses a stricter path. If the user asks for "the second user message" or "turn 2", Socrates must put the literal number in `turnNo` and, when relevant, set `role` to `user` or `assistant`. The backend does not parse ordinal phrases out of `query`; this avoids false positives such as matching "turn 2" against "turn 20". For project/recent searches, `turnNo` requires a `conversationHint` that resolves to exactly one conversation.

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

Resource listing syncs direct files from `.socrates/resources/` into backend records first, so files copied there manually from VS Code/Finder are visible to both the dashboard and `list_project_resources`. Chat image attachments live under `.socrates/attachments/` and are not project resources.

Generated code belongs in the attached workspace/repo, not in `.socrates/`. When the user asks Socrates to write code or create a script/program, Socrates should use `edit` to create the file in a sensible repo location. If the location is ambiguous and the user says Socrates can decide, use the repo root for a standalone script or a small well-named folder for natural multi-file work.

Between user queries, Socrates should carry forward final user/assistant dialogue, not full historical tool-call dumps. Within the current turn, tool calls and tool outputs may be passed back to the model until the final answer is reached.

Active/stale Terminal summaries are current-state context, not old transcript replay. The backend injects bounded terminal context into every new turn: terminal id/name, command, cwd, shell/platform, status, exit/signal, awaiting-input state, safe prompt text, and recent stdout/stderr tail. Full terminal logs stay persisted and inspectable through terminal output polling or trace retrieval.

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

Context compression must preserve active terminal anchors: terminal ids, commands, status, awaiting-input state, latest actionable output/prompt, and source handles for exact recovery. It must not stuff full terminal logs into hidden context.

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
precompute around 145k estimated tokens
synchronous compaction around 160k estimated tokens
target packed context around 120k estimated tokens
hard cap 180k estimated tokens
```

`120k` is the packed-context target after compression, not a trigger. `145k` starts background post-turn precompute for the next turn. `160k` is the blocking active-turn threshold before a provider call is allowed to continue. `180k` remains the hard do-not-send cap after counting the assembled provider request.

The estimate is provider-aware. Before each model call, Socrates counts the assembled next provider request through `packages/providers`, including the system prompt, visible messages, hidden compaction summaries, active tool calls/results, and tool definitions/schemas. Completed earlier turns still contribute only visible user query plus final assistant answer.

Compression is enabled by default and can be disabled only with `SOCRATES_CONTEXT_COMPRESSION_ENABLED=false`.

The chat header displays the latest estimated model-facing context usage, for example `23,433 tokens`. It does not display cumulative provider token spend. Provider-reported token usage remains persisted for diagnostics and cost accounting.

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
mode = combined merges lexical and vector evidence when embeddings are ready
mode = semantic ranks by vector similarity when embeddings are ready
search and inspect results include conversation provenance
context compaction snapshots are indexed as hidden conversation_summary evidence
```

Compressor-model selection:

```text
primary: OpenRouter deepseek/deepseek-v4-flash with thinking off
fallback: OpenRouter qwen/qwen3.6-35b-a3b with thinking off
```

The local/release evaluation should keep using identical conversation/tool-history fixtures and compare faithfulness, preservation of exact decisions/rules, trace-handle usefulness, concision, latency, and cost. OpenRouter thinking off must use the explicit reasoning-off provider options documented in `PROVIDER_USAGE.md`.

The frontend listens for `context.compaction.started`, `context.compaction.completed`, and `context.compaction.failed`. Blocking active-turn compaction emits `started` before awaiting the compressor model so the UI can show a small `Compacting conversation context...` state during the wait. Background precompute remains silent in the live UI and does not add transcript messages.

When showing or answering from retrieved history, Socrates must use the returned conversation provenance. If `conversation.isCurrentConversation` is false, the answer should say the evidence came from an earlier project conversation or use `conversation.title`; it should only say "this conversation" or "current chat" when the provenance says the result is from the current conversation.

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
  -> stream model output through packages/core and packages/providers
  -> create assistant message on completion
  -> persist model_calls, model_stream_chunks, model_usage, context_usage_snapshots when a context window is known, and events
  -> update conversations.updated_at
  -> if title is still "New conversation", update it from the first word of the message
```

Conversation title behavior:

- A newly created conversation starts with the persisted title `New conversation`.
- When the first user message is sent, the backend updates the conversation title from the first word of the message.
- If the first word is longer than 10 characters, the title uses the first 10 characters followed by `...`.
- If the first word is 10 characters or shorter, the title is the first word as written.
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
