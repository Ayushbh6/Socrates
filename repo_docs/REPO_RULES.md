# Socrates Repo Rules

These rules are strict and non-negotiable. They exist to keep the codebase understandable as Socrates grows into a serious coding agent.

## 1. Keep Package Responsibilities Clear

Each package has one job.

```text
apps/web          -> user interface
apps/server       -> API and WebSocket transport
packages/core     -> agent runtime and orchestration
packages/workspace -> local file, shell, search, git, and patch operations
packages/providers -> model provider abstraction and adapters
packages/contracts -> shared schemas, event types, tool contracts
packages/shared   -> generic reusable utilities
```

Do not place logic in a package just because it is convenient. Put it where it belongs.

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
bash
trace_retrieve
list_project_resources
```

Do not expose separate `glob`, `grep`, `write`, `patch`, `git`, `todo`, `skill`, or sub-agent/task tools in the initial tooling phase. Those may exist as internal implementation helpers, but the model should see the smaller surface above.

Each model-visible tool must live in its own small TypeScript file under `packages/core/tools/`, with a single unified registry that exposes the enabled tools to the agent. Do not put all tools into one large class or one large mixed implementation file.

The `read`, `search`, `trace_retrieve`, and `list_project_resources` tools are read-only. They may be auto-allowed when scoped to the project workspace and bounded by output limits.

`list_project_resources` must use backend project resource records and should be preferred before shell probing when the user asks about uploaded project files under `.socrates/resources/`. Its model-visible input is limited to `kind` and `limit`, and its output must stay to filenames/metadata only.

The `edit` tool is the only V1 model-visible file mutation tool. It must cover creating new files, overwriting files, precise multiline replacement, and patch-style edits. It must show a diff or equivalent preview and require approval unless the user explicitly runs a full-access mode.

When the user asks Socrates to write code, create a script, build a small program, implement something, or build a small app/tool, Socrates should treat that as a request to create or edit a real workspace file with `edit`, not as a request for a long inline code block. This applies even for small scripts when the workspace is write-capable. Generated code belongs in the attached workspace/repo, not in `.socrates/`. Socrates should choose a sensible path when obvious, ask one concise question only when destination/language/intent is genuinely ambiguous, optionally verify with `bash`, and summarize file path plus run instructions in the final answer. If the user says "wherever" or lets Socrates decide, use the repo root for a standalone script, or a small well-named folder only when the task naturally needs multiple files. It should paste a full runnable file in chat only when the user explicitly asks for inline code or when no write-capable workspace is available.

Before installing Python packages or running generated Python code, Socrates receives backend-generated workspace environment hints. If a project-local environment or package-manager workflow is detected, it should use that instead of creating a second environment or running raw global `pip`. If no environment is detected and dependencies are needed, it should ask the user before creating a venv or installing packages unless the user already explicitly requested setup.

Generated plotting/data scripts should save charts or artifacts to files and print their paths by default. Avoid GUI-blocking calls like `plt.show()` unless the user explicitly asks for an interactive window.

`.socrates/` is Socrates-owned memory/runtime/resource storage. It is not the default location for user code, scripts, tests, or normal app/repo changes. The agent should edit `.socrates/` only when the user explicitly asks for Socrates internals, uploaded resources, or runtime/memory storage behavior.

The `bash` tool is the only V1 model-visible command execution tool. It may run git, package managers, test commands, Docker, and other shell commands, but policy decides whether each command is auto-allowed, approval-gated, or denied. Destructive, network, install, git mutation, and outside-workspace commands require approval by default.

Bash commands already start in the active workspace. Commands that begin by changing into a guessed absolute path outside the active workspace, such as `cd /Users/ayush/Test && ...`, must be rejected with a recoverable error. Relative `cd` inside the workspace and absolute paths used as explicit arguments or destinations may still be allowed by policy and approval.

The agent should prefer `read` for file/document/image inspection and `search` for file discovery or content search because those tools provide bounded structured output. This is a preference, not a hard restriction. If `read` or `search` fails or gives poor output, an approved `bash` fallback such as a local extractor, `cat`, `find`, `grep`, or `pdftotext` may still run. Do not deny a legitimate approved bash command solely because a more specialized Socrates tool exists.

Tool outputs must be bounded. `read` uses a default `charLimit` of 20,000 characters, a normal backend per-call cap of 80,000 characters, and explicit truncation metadata when output is cut. Large files, PDFs, documents, slides, command outputs, and trace retrieval results must be paged or summarized instead of dumped wholesale into model context.

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

Only one active turn may run per conversation in V1. The composer must switch from send mode to stop mode while a turn is active, and return to send mode after `turn.completed`, `turn.failed`, or `turn.cancelled`.

When a turn is cancelled after assistant text has streamed, Socrates must persist that visible text as a cancelled partial assistant message and carry it forward in later semantic chat history. Historical tool calls, tool results, and reasoning from the cancelled turn remain audit/UI data only and are not blindly loaded into later prompts.

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

If package responsibilities, event contracts, approval policy, or dependency direction changes, update `repo_docs/`.

Architecture docs are not decorative. They are working agreements.

## 22. The Default Bias Is Reuse

When implementing a feature, the default path is:

1. Find the existing contract.
2. Find the existing package owner.
3. Add the smallest missing reusable function there.
4. Import it where needed.
5. Avoid one-off local implementations.

If a one-off is unavoidable, leave a short comment explaining why it is intentionally not shared.
