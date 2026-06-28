# Socrates Repo Rules

These rules are strict and non-negotiable. They exist to keep the codebase understandable as Socrates grows into a serious coding agent.

## 1. Keep Package Responsibilities Clear

Each package has one job.

```text
apps/web          -> user interface
apps/server       -> API and WebSocket transport
apps/desktop      -> native desktop shell and app launch/bundling glue
packages/core     -> agent runtime and orchestration
packages/workspace -> local file, shell, search, git, and patch operations
packages/providers -> model provider abstraction and adapters
packages/contracts -> shared schemas, event types, tool contracts
packages/shared   -> generic reusable utilities
```

Do not place logic in a package just because it is convenient. Put it where it belongs. The desktop shell can launch or bundle the existing web/server runtime, but it must not fork agent logic, provider logic, workspace filesystem logic, or API contracts.

## 2. No Duplicate Implementations

There must never be three versions of the same helper scattered across the repo.

If logic is reused:

- Put domain logic in the domain package that owns it.
- Put cross-boundary schemas in `packages/contracts`.
- Put generic helpers in `packages/shared`.
- Import and reuse the existing function.

Before adding a new helper, search the repo for an existing one.

## 3. Contracts Live In One Place

All shared schemas, events, request types, response types, tool argument types, and approval payload types must live in `packages/contracts`.

This includes:

- WebSocket events.
- HTTP API payloads.
- Tool call schemas.
- Tool result schemas.
- Session schemas.
- Approval schemas.
- Error payload schemas.

Do not redefine event or payload shapes inside `apps/web`, `apps/server`, or `packages/core`.

## 4. WebSocket Events Must Be Typed

Every WebSocket event must have:

- A stable event name.
- A schema.
- A TypeScript type inferred from the schema.
- A single source of truth in `packages/contracts`.

No anonymous event objects should be manually constructed in random files.

Bad:

```ts
socket.send(JSON.stringify({ type: "thing", value: "abc" }))
```

Good:

```ts
const event = AgentMessageDeltaEvent.parse({
  type: "agent.message.delta",
  sessionId,
  text,
})

socket.send(JSON.stringify(event))
```

## 5. The Frontend Must Not Own Agent Logic

`apps/web` renders state and sends user actions. It must not decide how the agent works.

The frontend should use Socrates-owned hooks around Socrates contracts and WebSocket events. Do not make `@ai-sdk/react` the core chat state engine in V1.

Frontend code may:

- Display messages.
- Show tool calls.
- Render diffs.
- Capture voice input through approved browser APIs.
- Trigger read-aloud playback for assistant messages.
- Collect thumbs up/down feedback.
- Ask for approvals.
- Send approval decisions.
- Send cancellation requests.

Frontend code must not:

- Call model providers directly.
- Call transcription or text-to-speech providers directly unless the architecture explicitly chooses browser-native APIs and records that choice through contracts/events.
- Read or write local repo files directly.
- Run shell commands.
- Implement agent loops.
- Duplicate backend validation rules.

## 6. The Server Should Stay Thin

`apps/server` is transport glue. It should validate requests, manage connections, and call package APIs.

Server routes must not become a dumping ground for:

- Agent orchestration.
- Tool implementations.
- Provider-specific logic.
- Filesystem logic.
- Shell command logic.

If a route grows complex, move the logic into the correct package.

## 7. Projects Are The Primary App Boundary

All V1 conversations must belong to a project.

Required shape:

```text
user -> project -> conversation -> session -> turn
```

Project resources, project instructions, conversations, sessions, artifacts, and events must remain traceable back to the owning project.

Do not create global unscoped chats in V1.

Every active V1 project must have exactly one primary local workspace folder.

Project rows are Socrates metadata and history. Workspace folders are the real local project surface on the user's laptop.

When a project is created from scratch or attached to an existing folder, Socrates must create:

```text
<workspace>/.socrates/
<workspace>/.socrates/resources/
```

Do not edit the workspace root `.gitignore` automatically in V1.

## 8. The Agent Core Must Be Provider-Agnostic

`packages/core` must never import OpenAI, Anthropic, Gemini, Ollama, OpenRouter, LiteLLM, or Vercel AI SDK directly.

The core talks only to the internal model interface from `packages/providers`.

The correct shape is:

```text
packages/core -> ModelProvider interface -> provider adapter
```

Provider/model tokenizer details also belong behind this boundary. Context budgeting must call the provider interface's token counter for the assembled next model request instead of using ad hoc character estimates in `packages/core`, `apps/server`, or `apps/web`.

Not:

```text
packages/core -> OpenAI SDK
packages/core -> Anthropic SDK
packages/core -> Vercel AI SDK
```

## 9. Workspace Operations Must Go Through `packages/workspace`

All local file, shell, search, git, and patch operations must go through `packages/workspace`.

Project folder creation, existing-folder verification, `.socrates/` scaffold creation, and resource file placement also belong to `packages/workspace`.

Native folder picker adapters also belong to `packages/workspace`. The frontend must not rely on browser-only filesystem APIs for the core project/workspace model.

Do not run ad hoc filesystem or shell logic from:

- `apps/web`
- `apps/server/routes`
- `packages/core/agent`
- random utility files

The agent-facing tool wrapper lives in `packages/core/tools`, but the implementation lives in `packages/workspace`.

## 10. Tools Need Schemas, Permissions, And Ownership

Every agent tool must define:

- Name.
- Description.
- Argument schema.
- Result schema.
- Permission behavior.
- Execution function.
- Owning package.

Tool definitions belong in `packages/core/tools`.

Tool implementation details belong in the package that owns the capability, usually `packages/workspace`.

The V1 model-visible tool surface is intentionally small:

```text
read
search
edit
apply_patch
bash
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

Do not expose separate `glob`, `grep`, `write`, `git`, `todo`, `question`, `webfetch`, or sub-agent/task tools in the initial tooling phase. Those may exist as internal implementation helpers, but the main Socrates model should see the smaller surface above plus dynamic MCP tools explicitly exposed by the MCP runtime after `mcp_registry describe`. Patch application is exposed as `apply_patch`, not as a hidden patch mode inside `edit`.

Do not dump all skills, MCP servers, MCP tool schemas, workspace runtime facts, or current date/time into the system prompt. Stable routing guidance belongs in the base prompt; changing facts belong behind tools. The runtime must not grep user prompts for skill/MCP names and inject hidden matched ids or descriptions. Socrates should discover extensions itself with `skills list` / `skills describe` and `mcp_registry list` / `mcp_registry describe`.

Each model-visible tool must live in its own small TypeScript file under `packages/core/tools/`, with a single unified registry that exposes the enabled tools to the agent. Do not put all tools into one large class or one large mixed implementation file.

The `read`, `search`, `trace_retrieve`, `tool_docs`, `skills`, `soul`, `user_profile`, `list_project_resources`, and model-visible `mcp_registry` operations are read-only. They may be auto-allowed when scoped to the project workspace or Socrates-owned memory and bounded by output limits. `skills` model calls are limited to `list` and `describe`; compatibility `search`/`read` stays backend-supported but should not be the prompt-driving path. `mcp_registry` model calls are limited to `list` and `describe`; UI/API flows may configure, check, enable/disable, and delete MCP servers. `project_docs` is read/search/edit constrained to `<workspace>/.socrates/MEMORY.md` and `<workspace>/.socrates/PROJECT_NOTES.md`. `repo_docs` is read/search/edit constrained to the four allowlisted markdown files under `<workspace>/.socrates/repo_docs/`: `CORE_IDEA.md`, `REPO_NAVIGATION.md`, `REPO_RULES.md`, and `CONTRACTS.md`. Generic `edit` and `apply_patch` writes to Socrates docs are rejected; use `project_docs` or `repo_docs`. Before `edit`, `apply_patch`, or approval-required mutation tools can run, Socrates must have read, searched, or edited `repo_docs` in the same turn; missing preflight returns recoverable `repo_docs_preflight_required`.

`trace_retrieve` must stay high-level and intent-based. The model should start with `operation="search"`, choose a retrieval mode, and search by query, scope, and bounded limits. Semantic and combined search stay minimal: `query`, optional `scope`, and optional `limit`. Exact search may use `conversationTitle`, `conversationId`, `conversationLimit`, `turnNo`, and `role`; `conversationTitle` is normalized so case, punctuation, and extra spacing do not make matching brittle. Audit-only filters such as evidence type, path, command, tool name, and `toolId` are for `mode="audit"`. Exact `messageId` and audit `toolId` lookups win over search and return the full source. The model should not be expected to know opaque database ids before retrieval.

Normal search output must stay slim and message-first: `resultNumber`, `text`, `entryType`, `conversationTitle`, `conversationId`, and `messageId`/`messageNo` for exact user or assistant message rows. `entryType` must distinguish `user_query`, `assistant_response`, and `continuation_summary`; continuation summaries are fallback evidence only and must not fabricate message ids or message numbers.

`conversationId`, `messageId`, `toolCallId`, terminal ids, process ids, provider ids, and other opaque runtime ids may remain internal for storage, UI events, provider protocol correlation, and backwards compatibility. Returned trace ids may be used for precise follow-up `trace_retrieve` inspection, but they must not be required or recommended as the first step in model-authored investigation. Normal search results should not expose storage/debug fields such as trace handles, source tables, source ids, turn ids, scores, metadata, or inspect argument blobs.

Trace retrieval is limited to visible non-deleted conversations (`active` and `archived`). Hard-deleted conversations must not be searchable or inspectable through orphan `trace_documents`, and conversation hard delete must remove trace documents, FTS rows, trace embeddings, and trace index jobs for that conversation.

Search and inspect results must include enough conversation identity to answer correctly. Socrates should use `conversationTitle` as the human-readable location and `conversationId` only to disambiguate same-title conversations.

For ordinal recall, the model must use the structured integer `turnNo` search field and optional `role`. The backend must not silently infer `turnNo` from natural-language query text such as "second user message"; without `turnNo`, the call remains ordinary search. `turnNo` is for a single explicit turn and takes precedence over `conversationLimit`; broad ordinal lookup with `recent_conversations` or `project` can return multiple matching turns across visible conversations; out-of-range ordinal lookups must return warnings instead of falling back.

Trace retrieval is search-then-inspect:

```text
search
  natural-language, scoped, hybrid retrieval
  returns compact numbered evidence plus provenance

inspect
  exact bounded retrieval by returned resultNumber or natural filters
  returns raw source text or exact tool evidence
```

Trace index internals such as `trace_documents`, `trace_embeddings`, and `trace_index_jobs` must not become separate model-visible tools. They are backend storage/indexing implementation details behind `trace_retrieve`.

Embedding providers must follow the same boundary rules as chat providers. OpenAI hosted embeddings and offline local embeddings through Ollama or a future Hugging Face / sentence-transformers backend must live behind `packages/providers`; frontend code, routes, WebSocket handlers, and `packages/core` must not call embedding SDKs or local model runtimes directly. Socrates must not silently install or download offline embedding models; it should detect missing local setup and show explicit setup guidance.

Conversation summaries, turn summaries, and verbatim anchors must preserve provenance back to raw rows. Summaries must not be stored as fake user or assistant messages. The `messages` table is for real visible chat messages only.

Verbatim anchors should preserve exact high-value user source material such as rubrics, canonical examples, "use this throughout" instructions, and pasted source-of-truth text. When exact wording matters, Socrates should inspect the anchor/raw message rather than rely only on semantic retrieval snippets.

`list_project_resources` must use backend project resource records and should be preferred before shell probing when the user asks about uploaded project files under `.socrates/resources/`. Its model-visible input is limited to `kind` and `limit`, and its output must stay to filenames/metadata only.

Chat screenshots/images are different from project resources. They are stored under `<workspace>/.socrates/attachments/`, tracked by `message_attachments`, and referenced in user messages with filename, MIME type, size, and path. The agent prompt should teach Socrates to use native image parts when available, and to reopen known attachment paths with `read` when prior or exact screenshot inspection is needed. These attachments must not be surfaced through `list_project_resources`. Attachment files may remain after a conversation is deleted; if trace retrieval has no visible provenance, Socrates must not invent the deleted conversation title or message context from the filename alone.

The `edit` tool is the primary V1 model-visible single-file mutation tool. Existing files should use targeted `oldString`/`newString` replacements; whole-file `content` on an existing file requires explicit `overwrite: true` and should be reserved for deliberate rewrites. New deliverables, scratch files, or generated files that are derived from files in a subfolder should use an explicit path in that same subfolder or the nearest relevant existing folder; the workspace root is appropriate only when the user asks for it, the artifact is truly project-level, or the task is standalone workspace-level work with no relevant subfolder. The separate `apply_patch` tool covers multi-hunk or multi-file patch application. Its preferred model-facing input is `patchText` using the structured `*** Begin Patch` envelope with `*** Add File`, `*** Update File`, `*** Delete File`, and `*** Move to` sections so models do not need to calculate unified-diff hunk counts; `@@` labels are optional hints and exact old lines do the matching. Standard unified diffs remain accepted for compatibility when already valid and are applied via `git apply`. Both must show a diff or equivalent preview and require approval unless the user explicitly runs a full-access mode. The harness tracks file freshness from `read` results; existing-file edits, patches, deletes, and renames require a prior active-turn read, and another mutation to the same file after a successful mutation must re-read first. Before `edit`, `apply_patch`, or approval-required mutation tools can run, Socrates must have read, searched, or edited `repo_docs` in the same turn; missing preflight returns recoverable `repo_docs_preflight_required`. Generic `edit` and `apply_patch` writes to `<workspace>/.socrates/MEMORY.md`, `<workspace>/.socrates/PROJECT_NOTES.md`, and `<workspace>/.socrates/repo_docs/*.md` are rejected; workspace docs must be changed through `project_docs` or `repo_docs`. Model-facing tool inputs must not carry content hashes.

When the user asks Socrates to write code, create a script, build a small program, implement something, or build a small app/tool, Socrates should treat that as a request to create or edit a real workspace file with `edit`, not as a request for a long inline code block. This applies even for small scripts when the workspace is write-capable. Generated code belongs in the attached workspace/repo, not in `.socrates/`. Socrates should choose a sensible path when obvious, ask one concise question only when destination/language/intent is genuinely ambiguous, optionally verify with Terminal, and summarize file path plus run instructions in the final answer. If the work is based on files in a subfolder, generated outputs should stay in that subfolder or the nearest relevant existing folder unless the user says otherwise. If the user says "wherever" or lets Socrates decide, use that nearest relevant folder when one is known; use the repo root only for genuinely project-level or standalone workspace-level work, or create a small well-named folder only when the task naturally needs multiple files. It should paste a full runnable file in chat only when the user explicitly asks for inline code or when no write-capable workspace is available.

Before installing Python packages or running generated Python code, Socrates should read project notes when workspace runtime facts matter. The backend maintains a protected `runtime_context` section in `.socrates/PROJECT_NOTES.md` with generated workspace scan facts such as detected venvs, dependency files, and package-manager hints. If a project-local environment or package-manager workflow is detected, Socrates should use that instead of creating a second environment or running raw global `pip`. If no environment is detected and dependencies are needed, it should ask the user before creating a venv or installing packages unless the user already explicitly requested setup. Terminal output and live terminal state must not be persisted in `runtime_context`.

Generated plotting/data scripts should save charts or artifacts to files and print their paths by default. Avoid GUI-blocking calls like `plt.show()` unless the user explicitly asks for an interactive window.

`.socrates/` is Socrates-owned memory/runtime/resource storage. It is not the default location for user code, scripts, tests, or normal app/repo changes. The agent should edit `.socrates/` only when the user explicitly asks for Socrates internals, uploaded resources, or runtime/memory storage behavior.

`current_time` is the read-only no-input current date/time authority. Use it for date-sensitive answers, filenames, logs, and document prose that truly needs today's date or exact time. The Socrates system prompt must not include changing current date/time fields.

`project_docs` is the main workspace memory surface. Use `area: "memory"` for durable cross-conversation project state: goals, decisions, constraints, blockers, durable user/project preferences, changed workflow facts, and handoff facts. Use `area: "notes"` for live assistant notes: active todos, checked files, partial progress, next commands, restart points, and the protected backend-owned `runtime_context` section. Runtime project docs are structured markdown; prefer `read_index`, then `read_section` or `patch_section`, when a known section is enough. `project_docs` outputs include system runtime date/time metadata, and successful edits stamp frontmatter with backend-owned `updated_at`, `updated_by`, and `last_edited_section`. After meaningful workspace work, the runtime may require a `project_docs` memory update before final; notes are useful but do not satisfy durable memory.

`repo_docs` owns the runtime `.socrates/repo_docs/*.md` doctrine files. They are structured markdown with stable section ids; prefer `read_index`, `read_section`, and `patch_section` for focused doctrine changes. `repo_docs` outputs include system runtime date/time metadata, and successful edits stamp frontmatter with backend-owned `updated_at`, `updated_by`, and `last_edited_section`. Root maintainer documentation lives in `context-files/*.md`, not `.socrates/repo_docs/`, so do not confuse it with Socrates runtime-owned docs.

`tool_docs` retrieves Socrates tool-usage guidance, not conversation history. Use `trace_retrieve` for raw conversation/tool provenance, `tool_docs` for tool behavior, `project_docs` for workspace memory/notes, `repo_docs` for repository doctrine, `current_time` for current date/time, and `user_profile` for durable cross-project user profile facts.

Primary tool-usage docs are runtime-bundled markdown assets, not inline seed strings. They live in `apps/server/src/memory/defaults/primary/tool_usage/`, are copied into server `dist` during build, and install into `~/.Socrates/tool_usage/` so Socrates can read them through `tool_docs`.

`soul` is the only model-visible reader for `~/.Socrates/identity.md`. It supports `read`, `read_index`, and `read_section` for identity, voice, relationship, operating-principle, safety, and tool/memory-discipline sections. It is read-only: the main agent cannot write this doc through `soul` or generic workspace mutation tools. `user_profile` reads `~/.Socrates/user_profile.md` with the same read/index/section pattern and is also read-only for the main agent. Identity and user-profile edits are backend-memory-agent controlled, evidence-backed, patch-verified, and require the applicable confirmation/update policy before applying. Applied identity updates must create durable notifications for the user.

The `bash` tool id is the only V1 model-visible command execution tool, but product/UI/prompt copy should call it Terminal. It may run git, package managers, test commands, Docker, dev servers, REPLs, prompts, and basic TUI commands, but policy decides whether each command is auto-allowed, approval-gated, or denied. Internally it is PTY-backed and platform-native: POSIX on macOS/Linux, ConPTY PowerShell-first on Windows, and cmd fallback. Do not add separate model-visible PowerShell, cmd, terminal, or process tools without updating contracts. Destructive, network, install, git mutation, delete, migration, and outside-workspace commands require approval by default.

Long-running or interactive shell work must use `bash` process operations: `start` to launch a conversation-scoped PTY Terminal, then `status`, `output`, and `stop` with no target when exactly one active Terminal exists or with the human Terminal name when there are multiple candidates. Blocking or obviously interactive `run` commands may auto-detach into a Terminal after the configured threshold. Terminals are scoped to `projectId + conversationId + workspacePath`; they survive across turns, are represented in bounded terminal context without exposing opaque ids to the model, and are cleaned up on explicit stop, conversation delete, workspace switch, app shutdown, or idle TTL. If a Terminal needs input, only the user may send raw xterm stdin through the frontend; the agent must ask the user and raw stdin must stay redacted from model context and persistence.

Workspace-mutating work must be serialized per workspace across concurrent conversations. `edit`, `apply_patch`, `project_docs` edits, `repo_docs` patches, and foreground mutating Terminal commands such as Git branch changes/commits/pushes, package installs, migrations, and file-generating scripts use the shared workspace mutation queue. Read-only commands and background Terminals such as dev servers/watchers must not hold that queue forever.

Terminal commands already start in the active workspace. Commands that begin by changing into a guessed absolute path outside the active workspace, such as `cd /Users/example/project && ...`, must be rejected with a recoverable error. For commands that operate inside a subfolder, Socrates should use the `cwd` input instead of prefixing the command with `cd`. Before Terminal commands create files or directories, Socrates should verify the intended parent directory exists and use an explicit relative path or `cwd` so outputs do not accidentally land in the workspace root. Relative `cd` inside the workspace and absolute paths used as explicit arguments or destinations may still be allowed by policy and approval.

The agent should prefer `read` for file/document/image inspection and `search` for file discovery or content search because those tools provide bounded structured output. This is a preference, not a hard restriction. If `read` or `search` fails or gives poor output, an approved Terminal fallback such as a local extractor, `cat`, `find`, `grep`, or `pdftotext` may still run. Do not deny a legitimate approved Terminal command solely because a more specialized Socrates tool exists.

Tool outputs must be bounded. `read` uses an estimated `tokenLimit` default of 4,000 tokens and a hard model-requested max of 6,000 estimated tokens across normal files, PDFs, documents, presentations, spreadsheets, SVG text, and other readable formats. `charLimit` remains available for character paging and has a hard cap of 80,000 characters, but effective read output is bounded by both `charLimit` and `tokenLimit`; truncation metadata must make cuts explicit. `search` defaults to at most 20 results and has a hard runtime cap of 50 results; generated/vendor directories such as `.git`, `node_modules`, `dist`, `build`, `.next`, `.turbo`, and `coverage` are skipped by default and warnings must tell the model to narrow noisy searches. Large files, PDFs, documents, slides, command outputs, and trace retrieval results must be paged or summarized instead of dumped wholesale into model context.

## 11. Dangerous Actions Require Approval

The agent must request user approval before actions that can change the system or consume meaningful resources.

Approval is required for:

- File writes.
- Patch application.
- Package installation.
- Shell commands with side effects.
- Git commits.
- Git pushes.
- Deleting files.
- Moving files.
- Network operations that send workspace content to external services outside the selected model provider flow.

Read-only actions may be allowed automatically depending on policy.

Approval requests and decisions must use schemas from `packages/contracts`.

## 12. No Hidden Side Effects

Functions should make side effects obvious from their name and package.

Bad:

```ts
getProjectInfo() // silently runs git commands and writes cache files
```

Good:

```ts
readProjectInfo()
refreshProjectInfoCache()
```

Side effects must be explicit.

## 13. Prefer Small, Composable Functions

Reusable base functions should be small and organized by responsibility.

Avoid large files that mix:

- Validation.
- Business logic.
- IO.
- UI formatting.
- Provider translation.
- Persistence.

Split by responsibility before the file becomes difficult to reason about.

## 14. Errors Must Be Structured

Cross-boundary errors must use structured error payloads from `packages/contracts`.

Do not throw raw strings across package or WebSocket boundaries.

Errors should include:

- Stable code.
- Human-readable message.
- Optional details.
- Source package when useful.

## 15. Session State Must Be Explicit

Long-running agent work must be represented through explicit session/task state.

The system should be able to answer:

- What session is running?
- What message started it?
- What tools were called?
- What approvals were requested?
- What commands ran?
- What files changed?
- What failed?

No important agent state should exist only in memory if it is needed for recovery, display, or audit.

Only one active turn may run per conversation in V1. This is a per-conversation lock, not a global app lock: different conversations may each run an active turn concurrently while the backend process is alive. The composer must switch from send mode to stop mode while its current conversation has an active turn, and return to send mode after `turn.completed`, `turn.failed`, or `turn.cancelled`.

When a turn is cancelled after assistant text has streamed, Socrates must persist that visible text as a cancelled partial assistant message and carry it forward in later semantic chat history. Historical tool calls, tool results, and reasoning from the cancelled turn remain audit/UI data only and are not blindly loaded into later prompts.

Context compression must preserve this same visible-history rule. Recent real user/assistant messages stay real role-typed messages in model context. Hidden summaries, compaction notes, and context briefs must not be stored as fake user or assistant messages. Raw rows stay in SQLite, and compacted context must point back to exact source handles whenever precision matters.

Compression should run at provider-call boundaries. Do not compress by mutating in-flight tool execution state. Persist the tool output first, then compact or summarize only the model-facing context before the next model call.

The context count used for those decisions must include the exact request being considered for the next provider call: system prompt, visible history, hidden summaries, current-turn tool calls/results, and available tool definitions/schemas. `tokenUsage` remains provider-reported diagnostic/cost usage and must not be substituted for model-facing `contextUsage`.

## 16. Streaming Is Event-Based

Streaming output must use typed events.

This applies to:

- Model deltas.
- Tool progress.
- Shell stdout.
- Shell stderr.
- Transcription progress.
- Read-aloud generation/playback status.
- Feedback creation or updates.
- Approval requests.
- Patch proposals.
- Task completion.

Do not invent separate streaming formats for each feature.

## 17. Voice, Audio, And Feedback Must Be Persisted

Voice input, read-aloud output, and message feedback must use shared contracts, typed events, and database records.

The required model is:

```text
voice input -> transcription -> normal user message
read aloud -> assistant message -> audio output record
feedback -> exact message, turn, or model call being rated
```

Do not hide these flows in frontend-only state.

Do not add large sets of nullable voice/audio/feedback columns to `messages`. Use dedicated tables linked back to messages, turns, model calls, artifacts, and errors.

## 18. Add New Providers Behind The Provider Interface

New model providers must be added as adapters in `packages/providers`.

They must not leak provider-specific response shapes into:

- `packages/core`
- `apps/server`
- `apps/web`

If a provider has unique capabilities, expose only the normalized subset first. Add extensions deliberately.

V1 should use direct AI SDK provider packages behind the Socrates provider abstraction. Do not use Vercel AI Gateway as the default provider path.

## 19. Keep Naming Stable And Boring

Use predictable names.

Examples:

```text
AgentRuntime
ToolRegistry
ModelProvider
Workspace
ApprovalStore
SessionStore
WebSocketEvent
```

Avoid clever names. The repo should be easy to navigate months later.

## 20. Search Before Adding

Before adding any new:

- Utility.
- Schema.
- Event type.
- Tool.
- Provider helper.
- Workspace operation.

Search the repo first.

Use `rg` or `rg --files` before creating new abstractions.

## 21. Documentation Must Track Architecture

If package responsibilities, event contracts, approval policy, or dependency direction changes, update `context-files/`.

Architecture docs are not decorative. They are working agreements.

## 22. The Default Bias Is Reuse

When implementing a feature, the default path is:

1. Find the existing contract.
2. Find the existing package owner.
3. Add the smallest missing reusable function there.
4. Import it where needed.
5. Avoid one-off local implementations.

If a one-off is unavoidable, leave a short comment explaining why it is intentionally not shared.

## 23. Model-Driven Capabilities Must Be Real Agents

Any serious model-driven capability must follow the shared agent pattern instead of becoming a one-off provider call hidden inside a route, store, or UI handler.

Required pattern:

```text
prompt
  -> shared runner
  -> scoped tool registry
  -> executor mapping
  -> structured validation
  -> typed events and persistence
```

This applies to Socrates, the Global Memory Agent, the Skill Writer Agent, and future reusable subagents. Backend stores may coordinate, persist, validate, and apply approved effects, but they must not own private model orchestration for agent-like work.

Agent-to-agent communication should start simple and reusable. The accepted first protocol is a backend-backed notepad:

- Socrates creates `memory_note` with only a human `note` and optional `importance`.
- The backend attaches current-turn lookup refs such as conversation id, message id, turn id, source project, workspace path when available, and a default project-local skill-scope hint.
- The receiving agent reads at most 10 numbered notes through an inbox-style `memory_notes` interface, classifies each lead before acting, chains into `trace_retrieve` when exact evidence is needed, and marks the note done after applying or deliberately skipping it.

Do not expose backend lookup refs as fields that the sending model has to author. They are storage and retrieval plumbing, not a human-facing contract.

Skill writing follows the same rule. The Memory Agent may decide that an approved skill create/update should happen, chooses project/global scope, and uses human-facing skill names. Socrates-originated notes default to project scope unless the Memory Agent deliberately upgrades a procedural skill to global. Final `SKILL.md` authoring belongs to the Skill Writer Agent. `skill_write` is a narrow scoped save/validation tool, not another model or hidden fourth agent.
