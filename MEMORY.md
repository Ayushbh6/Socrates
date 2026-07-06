# Socrates Memory

Repo-local handoff memory for Socrates. Treat this file plus `context-files/` as the maintainer restart surface for future work.

## Current Direction

Socrates is being shaped into a lean, project-first coding agent with active recall and low prompt overhead.

The current architecture now uses:

- A compact base prompt operating kernel in `packages/core/src/prompts/socratesPrompt.ts`.
- Workspace-local project state under `<workspace>/.socrates/`.
- Global Socrates tool guidance and skills under `~/.Socrates/`.
- Exact old conversation/tool evidence through `trace_retrieve`.
- A read-only `user_profile` tool for durable cross-project user preferences and global active context.
- A first-class no-tool `CompressorAgent` with structured output schemas for chat and memory compaction.
- No production diary read/write/search path and no per-turn main-chat wake-context injection.

Accepted next architecture work centers on three reusable agent roles:

- Socrates remains the project-working agent. It owns workspace `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, and `.socrates/repo_docs/*` through `project_docs` and `repo_docs`. It does not write identity, user profile, or skills.
- The Global Memory Agent becomes the learning curator. It keeps `~/.Socrates/user_profile.md`, `~/.Socrates/identity.md`, and skill freshness up to date from completed turns plus Socrates-authored memory notes.
- The Skill Writer Agent becomes a real specialized agent, using the same production agent-runner pattern as Socrates and the Memory Agent. It is an executor for approved skill create/update tasks, not a judge of whether a skill should exist.

## Memory And Docs Layout

Workspace `.socrates`:

```text
.socrates/
  MEMORY.md
  PROJECT_NOTES.md
  repo_docs/
    CORE_IDEA.md
    REPO_NAVIGATION.md
    REPO_RULES.md
    CONTRACTS.md
  skills/
    <skill-name>/SKILL.md
  resources/
  attachments/
```

Global `~/.Socrates`:

```text
~/.Socrates/
  identity.md
  user_profile.md
  tool_usage/
    trace_retrieve.md
    edit_apply_patch.md
    terminal.md
    read_search.md
    memory_agent/
      trace_retrieve.md
      projects.md
      edit_files.md
  skills/
    <skill-name>/SKILL.md
```

Runtime-owned memory docs use Socrates YAML frontmatter plus `<!-- socrates:section ... -->` section markers. The parser builds a section index for workspace project memory/notes, runtime workspace repo docs, global identity/user profile, and global tool docs. Existing unstructured files are preserved in a `legacy_content` section during migration except for `identity.md` and `user_profile.md`, which are rebuilt into their canonical sections without a legacy section. Primary docs must also have exactly one markdown `##` heading inside each section; duplicate inner headings trigger normalization before indexing.

## Model-Visible Tool Surface

Current base tools:

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
memory_note
```

Removed from the model-visible surface:

```text
socrates_memory
project_notes
```

Tool routing:

- `url_fetch` reads one exact HTTP(S) URL as bounded text or metadata. It is for specific docs/pages/JSON/CSV/redirect checks, not broad web search, crawling, saving files, or binary downloads.
- `trace_retrieve` is for prior conversation text and audit evidence: tool calls, shell output, file operations, patches, errors, decisions.
- `current_time` is a read-only no-input tool that returns backend-owned current date, ISO timestamp, and time zone. Use it when the answer or a document entry truly needs today's date/time; do not put changing time in the system prompt.
- `tool_docs` is read/search only for global tool usage guidance.
- `skills` lists and describes visible builtin, global, and project skills through exact ids/names returned by the tool. The main agent cannot write skills through this tool.
- `mcp_registry` lists and describes available MCP servers. `list` returns compact discovery rows; `describe` with an exact listed id/name loads one server and exposes its dynamic `mcp__...` tools for the same turn.
- `project_docs` reads/searches/indexes/edits workspace `.socrates/MEMORY.md` and `.socrates/PROJECT_NOTES.md`; prefer `read_index`, `read_section`, and `patch_section` for structured recall and edits.
- `repo_docs` reads/searches/indexes/edits only the four runtime repo doctrine docs; prefer `read_index`, `read_section`, and `patch_section` for focused repo doctrine changes.
- `soul` reads root `~/.Socrates/identity.md` with `read`, `read_index`, and `read_section`; the main agent cannot write it.
- `user_profile` reads root `~/.Socrates/user_profile.md` with `read`, `read_index`, and `read_section`; the main agent cannot write it.
- `soul` and `user_profile` should use `read_index` before full `read`, then `read_section` for focused context. Runtime caps full reads at 8,000 chars and index/section reads at 10,000 chars even if a larger `charLimit` is requested.
- `user_profile.active_context` is for global user-life context that is currently useful across projects. It may keep a compact source project/conversation label, but the remembered item itself must be globally useful, not project-local task state.
- `user_profile.evidence_index` is a source-anchor section, not a summary bucket. It should store compact traceable anchors for important profile claims: date, project/conversation title or id, turn/message/event id or trace handle when available, the claim supported, and the profile section using that claim.
- `memory_note` is the Socrates-to-Memory-Agent notepad tool. Its model-facing input stays human-sized: `note` plus optional `importance` (`normal` or `high`). The backend automatically attaches the current user message, conversation id, turn id, message id, source project, workspace path when available, and a default project-local skill scope; Socrates should not author ids, skill names, target files, or global/project scope in prose.

## Runtime Notes

- Main chat no longer injects `<socrates_wake_context>` on the first turn or later turns. Stable recall routing now lives in `packages/core/src/prompts/socratesPrompt.ts`, pointing Socrates to `project_docs`, `repo_docs`, `user_profile`, `soul`, `skills`, and `mcp_registry` when the current task needs them.
- Main chat now also has a production memory-routing loop around normal model calls. The pre-turn router and post-evidence router use real provider structured output with Zod schemas from `packages/contracts/src/memoryRouting.ts`, not prompted JSON. Keep this contract human-facing and flat: context booleans, one save target, one short save text, and one reason. Pre-turn routes can load project notes/memory/repo docs/user profile and save explicit remember items before work begins; post-evidence routes can save one concise project/global follow-up before the final answer. The router model is configured through the Memory Router worker setting, defaulting to OpenRouter `deepseek/deepseek-v4-flash` with thinking off.
- Socrates now has explicit CodeAct-style capability-composition guidance in `packages/core/src/prompts/socratesPrompt.ts`: use structured tools first, discover MCPs when appropriate, then use Terminal/code for bounded one-off scripts when no exact tool exists. Terminal remains approval/policy gated for installs, broad network work, large downloads, and risky mutations.
- First-turn project recall is mandatory for light greetings, "continue", "where were we", and broad project-status openers: Socrates must read `project_docs` notes `active_context` before answering so active project loops can surface naturally.
- The Socrates system prompt stays cache-friendly: stable instructions first, with no changing current date/time, workspace scan block, skill/MCP counts, or hidden matched skill/MCP ids in the system prompt.
- Extension discovery is tool-driven, not prompt-matched. Socrates should call `skills({ operation: "list" })` or `mcp_registry({ operation: "list" })`, then use `describe` with an exact listed canonical id/name. The runtime must not grep the user's prompt for skill or MCP names and inject hidden matches.
- Current date/time comes from the `current_time` tool. `project_docs` and `repo_docs` outputs also include `runtime.currentDate`, `runtime.currentDateTime`, `runtime.timeZone`, and `runtime.source: "system"` so docs workflows have an authoritative date source after reads.
- `.socrates/PROJECT_NOTES.md` contains project-scoped active state. The `active_context` section is for open loops, current project-local recall, and things Socrates should remember when this workspace is reopened. It also may contain a backend-owned `runtime_context` section with compact workspace scan facts such as detected stack, package manager, and virtual-environment hints. `runtime_context` is protected from `project_docs` edits, refreshes lazily when `project_docs` touches notes, and intentionally does not persist terminal output, live terminal state, dependency dumps, package lists, or root-script inventories.
- Project docs, repo docs, global tool docs, identity, and user profile updates get backend-owned frontmatter stamps (`updated_at`, `updated_by`, `last_edited_section`) after successful dedicated-tool edits. Model-written prose should not invent "today" when these system stamps are enough.
- Generic `edit` and `apply_patch` writes to `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/*.md`, and `.socrates/skills/**` are rejected; use dedicated docs tools or the approved Skill Writer Agent path.
- Before any `bash`, `edit`, or `apply_patch` can run, Socrates must have read/searched `project_docs` with `area: "notes"` and read/searched `repo_docs` in the same turn. Missing preflight returns recoverable `docs_preflight_required`.
- After any successful `bash`, `edit`, or `apply_patch`, Socrates must read/search `project_docs` with `area: "memory"` before final answer. Memory edits remain optional; the runtime requires review, then Socrates decides whether a durable update is useful.
- Terminal commands are preflight-rejected when they mention Socrates-owned protected paths: workspace `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/**`, `.socrates/skills/**`, and global `~/.Socrates/skills/**`, `~/.Socrates/tool_usage/**`, `identity.md`, or `user_profile.md`. This is an obvious-path guard, not a process sandbox.
- The Global Memory Agent is a scheduled app-level specialized `SocratesAgent` run, not a per-turn project worker. It should also consume Socrates-authored memory notes as high-signal investigation leads, classify each note before acting, and mark each note done after applying or deliberately skipping it.
- The agent reads completed-turn event manifests after the durable `events.sequence` watermark and advances the watermark only after a successful run. Manifest packing now adds completed turns one by one and stops before either 80 turns or 60k estimated tokens. Memory notes are separate notepad items that can point the agent at a specific current-turn source without requiring Socrates to summarize the whole memory update.
- The agent tools are `current_time`, `trace_retrieve` with global search, `projects`, `tool_docs`, `skills`, `memory_notes`, `soul`, scoped profile/identity edit capability, and skill proposal creation through `edit_files target="skill"`. The Memory Agent must be able to inspect full `SKILL.md` content before deciding an exact skill update; if skill content is truncated, it should retrieve the full content before proposing or requesting a write.
- Memory-agent `trace_retrieve` supports `all_projects`, `current_project`, `projectTitle`, `projectId`, `conversationTitle`, and `conversationId`; project/conversation selectors may be strings or lists.
- Memory-agent tool guidance is seeded under `~/.Socrates/tool_usage/memory_agent/` and is readable through the existing `tool_docs` tool.
- The Memory Agent can update `user_profile.md` directly through scoped backend edits and can update `identity.md` only through the existing confirmation policy. For skills, it decides whether the evidence is procedural enough to propose a create/update, chooses project or global scope, and sends the approved request to the Skill Writer Agent; it should not hand-author final `SKILL.md` files itself.
- `memory_notes` is the Memory Agent inbox: `list` returns at most 10 numbered rows with importance, default project/global skill-scope hint, source project/workspace metadata when available, and the first short slice of the note; `read(noteNumber)` returns the full note, attached user-message excerpt, and backend-provided trace lookup ids for immediate `trace_retrieve` chaining; `mark_done(noteNumber, resolution)` closes the item after processing with a one-line human reason describing what was applied, proposed, or skipped.
- Classification is mandatory before action: durable user facts/preferences and global active context usually go to `user_profile.md` (with evidence anchors for important claims), rare Socrates identity/behavior changes go through the identity confirmation path, reusable procedures may become skill proposals, and project-local or weak/current-turn-only notes should be skipped with an explicit resolution. Project-specific active context belongs in workspace `.socrates/PROJECT_NOTES.md`, not in global user profile.
- Mixed evidence turns must be split strictly: if a turn contains both a global user fact and a project-local active plan, the Memory Agent may update `user_profile.md` only for the global fact and must leave repo/workspace sequencing, implementation order, and active project reminders to Socrates/project notes. Profile corrections must update the content section and evidence anchors together so stale evidence does not keep supporting the old claim.
- Socrates-originated notes default to project-local skill scope because Socrates is acting inside a project. The Memory Agent may keep that project scope or deliberately upgrade to global only when the procedure is clearly reusable across projects. Memory-Agent-discovered skill proposals must also choose project or global scope explicitly.
- Section indexes persist in SQLite tables `memory_doc_indexes` and `memory_doc_sections`; these are rebuilt from markdown content during ensure/index operations and are lookup aids, not the source of truth.
- Model identity includes both provider and auth mode. `authMode = "api_key"` covers OpenRouter, OpenAI API, and Google API keys; `authMode = "chatgpt_subscription"` covers the experimental ChatGPT Codex OAuth path for OpenAI subscription models. The current ChatGPT Codex subscription catalog is `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and text-only `gpt-5.3-codex-spark`. `/api/models` is credential-aware and returns only models whose provider/auth mode is configured. If OpenRouter is configured, DeepSeek V4 Pro remains the default available chat model; otherwise the backend chooses the first available curated model. If ChatGPT Codex is connected, the main composer prefers ChatGPT Codex models for new/effective chat selection while API-key models remain selectable.
- OpenAI now has two separate credential statuses: `OpenAI API` and `ChatGPT Codex`. The ChatGPT Codex flow uses PKCE OAuth against `auth.openai.com`, stores Socrates-owned token metadata under local credential storage, refreshes access tokens on demand, and routes subscription requests through the Codex backend auth shim. OpenAI embeddings remain API-key only.
- Project semantic search supports hosted OpenAI embeddings and local Ollama embeddings. The Ollama path is read-only during setup: detect OS/runtime, list installed models, recommend one exact model such as `embeddinggemma:latest`, show official install/manual pull guidance, and never install Ollama or pull a model without a later explicit user action. When a project changes embedding provider/model/dimensions, Socrates keeps only the active embedding index: stale `trace_embeddings` rows for inactive provider/model/dimension tuples or old content hashes are deleted, and in-flight jobs for a deactivated config must not write late vectors.
- Global memory-agent settings live behind `/api/memory-agent` and are surfaced on the Settings page. Defaults are OpenRouter `xiaomi/mimo-v2.5-pro`, thinking off, enabled, cadence 10 minutes, but credential-aware resolution prefers ChatGPT Codex `gpt-5.5` with low reasoning when ChatGPT Codex is connected and the saved setting is still the built-in default or unavailable.
- Worker model settings live behind `/api/worker-model-settings` and are surfaced on the Settings page for Skill Writer, Context Compactor, Title Generator, and Memory Router. Settings persist provider, auth mode, model, and thinking choice. Defaults preserve the current working models, but credential-aware resolution prefers ChatGPT Codex `gpt-5.4-mini` with low reasoning for built-in/default unavailable worker settings when ChatGPT Codex is connected.
- Memory Router provider usage is recorded as `ai_usage_events.source_kind = "memory_router"` and rolled into the existing turn/conversation cost total. Do not add a separate visible router-cost widget unless the product direction changes.
- Socrates' visible voice should be warm, direct, and human. Internal evidence such as tool names, ids, hashes, model names, backend state, empty active-context wording, and commit SHAs should be translated into plain language unless the user asks for exact diagnostics.
- Completed chat turns are indexed for trace retrieval, but they no longer enqueue a per-turn memory job. The scheduler or manual settings-page action wakes the global agent.
- Legacy per-project memory-agent settings remain only as inactive DB/store compatibility baggage; the per-turn worker runtime path has been removed.
- Project skill creation remains user-triggered from the dashboard `Skills +` flow, and global skill creation/deletion remains user-triggered from Memory Center. These flows should route approved skill creation/update work through the Skill Writer Agent instead of a one-off provider stream.
- Memory Agent skill suggestions should be user-visible notifications first: "Socrates proposed this skill/update" with a concise summary. Default behavior is manual approval per skill; a later setting may allow auto-approval. Once approved, the Skill Writer Agent should always do the create/update unless validation or write tooling fails.
- The Skill Writer Agent needs a narrow tool belt: read approved request context, `trace_retrieve`, full `skills` list/describe/read for existing skill content, read-only `user_profile`, read-only `soul`, read-only project/repo docs for project skills, and a scoped `skill_write` tool for final `SKILL.md` creation/update. It must not get shell, arbitrary filesystem reads/writes, project docs writes, repo docs writes, identity/profile writes, or raw path mutation tools.
- Global MCP servers are available to all projects; project MCP servers are workspace-local and inherit global servers. Playwright MCP is bundled and protected from deletion. The model-facing `mcp_registry` path is `list`/`describe`; UI/API flows handle configure, check, enable/disable, and delete.
- Memory Center (`/memory`) is the global memory-agent control surface. It uses a fixed `h-screen` shell: header and footer stay anchored, the middle region scrolls, and desktop splits the main content scroller from the Memory Files rail scroller. Core Memory renders only Identity and User Profile.
- Primary identity/profile migrations never keep a generic legacy block. They route old headings into the canonical sections, drop old scaffolding lines, and compact obvious duplicate migrated bullets.
- Skill writing now routes through the production Skill Writer Agent path with a dedicated prompt, shared Socrates agent runner, scoped tool registry, and `skill_write` validation/write tool.
- Identity proposals through `soul` still require internal confirmation and user-visible notification.
- Legacy project memory from `~/.Socrates/projects/<projectId>/` is migrated into workspace `.socrates/MEMORY.md` and the old project root is removed.
- Legacy six repo docs are migrated by scaffold behavior into the four-doc system; old workspace repo-doc files are removed by initialization.

## Context Compression

- Compression is triggered at 170k estimated model-visible input tokens for both normal Socrates chat calls and backend Global Memory Agent calls.
- Recent completed Q/A tail is kept raw up to about 50k tokens without cutting mid-turn.
- Current active-turn tool pressure keeps the latest tool results by whole tool-call boundary, targeting about 50k tokens and keeping at least the latest five results when possible.
- Older head context is compacted through `CompressorAgent`, not streamed prompted JSON.
- Chat and memory compaction schemas live in `packages/contracts/src/contextCompression.ts`; chat uses `chatCompactionSchema`, and memory-agent context uses `memoryCompactionSchema`.
- Compressor prompts live in `packages/core/src/prompts/socratesCompressorPrompt.ts` and `memoryAgentCompressorPrompt.ts`; the backend memory-agent runner must pass `contextCompression: { enabled: true, mode: "memory" }`.
- Strict Zod validation happens before snapshot activation. Invalid new-schema output never becomes active memory; legacy invalid snapshots are ignored rather than migrated.
- Anchors must start with `Turn <number>:`. If only anchors fail, the compressor repairs anchors through the structured anchor repair schema.
- The server chooses the compressor through the Context Compactor worker setting plus credential-aware model resolution. The built-in default is OpenRouter `deepseek/deepseek-v4-flash` with thinking off. When ChatGPT Codex is connected and the saved worker setting is the built-in default or unavailable, the effective compressor is ChatGPT Codex `gpt-5.4-mini` with low reasoning. Hard-coded OpenRouter fallbacks must not run when OpenRouter is unavailable.

## Release State

- Current GitHub runtime release target is `v0.1.16`; npm launcher source is prepared as `@socrates-ai/cli@0.1.16` for manual npm publish after the GitHub runtime release completes.
- `v0.1.16` preserves the Memory Center / identity-user-profile cleanup from `v0.1.13`, the duplicate-section startup recovery from `v0.1.14`, the evidence-index guidance and duplicate markdown-heading normalization from `v0.1.15`, and adds Ollama embedding setup, CodeAct/url_fetch guidance, the expanded ChatGPT Codex subscription model catalog, and runtime packaging fixes.
- Release tooling remains pinned to the proven `pnpm@9.15.1` path for GitHub runtime builds. The runtime release workflow recreates the tag release and uploads each runtime asset explicitly (`darwin-arm64`, `darwin-x64`, `win32-x64`, then `SHA256SUMS`) so a stale partial draft cannot be reused. The produced runtime archive still bundles Node v20.20.2.
- Shell Tooling pins its Windows leg to `windows-2022`; `windows-latest` moved to Windows Server 2025 / VS 2026, where `node-gyp` cannot identify Visual Studio 18 while building native dependencies such as `better-sqlite3`. Windows still runs install/typecheck plus contracts/workspace/core tests, while the server PTY/WebSocket test suite runs on Ubuntu only because it assumes POSIX bash/PTY behavior.
- `user_profile.evidence_index` should now store compact source anchors for important profile claims, including date, project/conversation title or id, turn/message/event id or trace handle when available, the supported claim, and the profile section using that claim.
- Product stabilization commit `2756e97 Stabilize extension discovery context` is pushed to `origin/main`. It removes per-turn wake context from main chat, moves stable recall/extension routing into the base prompt, and keeps skills/MCPs behind on-demand `list`/`describe` tools.
- Credential-aware model routing and experimental ChatGPT Codex auth commit `6a29dad Add ChatGPT Codex auth model routing` is pushed to `origin/main`. It adds auth-mode-aware model settings, filtered `/api/models`, ChatGPT Codex OAuth/token refresh, Codex request routing, UI credential status, Codex-preferred defaults for chat/workers/memory-agent, and compressor regression coverage for active context, anchors, full fields, and source handles.
- Ollama embedding setup commit `21d9fc9 Add Ollama embedding setup` is pushed to `origin/main`. It adds Ollama model discovery/recommendations, offline setup guidance without automatic pulls, project embedding configuration for Ollama, active-index-only cleanup for `trace_embeddings`, in-flight stale job guards, and updated context files/contracts/tests.

## Next Major Work

- Keep strengthening Socrates' investigation harness based on real Gemini/GPT/OpenRouter runs, especially around overbroad mutations and respecting user-scoped constraints.
- Add a repeated-compaction torture/eval suite covering 5-10 compactions with canaries for strict user rules, file paths, commands, failures, unresolved tasks, anchors, and exact quotes.
- Consider a dedicated safety rule for files whose names clearly ask not to be opened, because the latest Gemini E2E still opened `please_do_not_open.md`.
- Harden the new `memory_note` and Skill Writer Agent flows with more live model runs, especially around skill-update proposals from long trace histories.

## Verification

Latest verified for the root maintainer docs rename to `context-files/` on 2026-06-19:

```text
git diff --check
pnpm --filter @socrates/core typecheck
git status --short --branch
```

Latest verified for the cache-safe runtime context and structured docs update on 2026-06-19:

```text
pnpm --filter @socrates/contracts test -- contracts.test.ts
pnpm --filter @socrates/core test
pnpm --filter @socrates/server typecheck
pnpm --filter @socrates/server test -- server.test.ts
pnpm --filter @socrates/server test -- memoryDocParser.test.ts
git diff --check
```

Latest verified after the stable wake-context, hard notes+repo-doc action preflight, post-action memory review gate, and terminal drain serialization work:

```text
pnpm --filter @socrates/server test -- server.test.ts
pnpm --filter @socrates/core test -- SocratesAgent.test.ts
git diff --check
```

Latest verified for extension discovery, skill/MCP list-describe contracts, and main-chat wake-context removal on 2026-06-25:

```text
CI=true pnpm --filter @socrates/core test -- packages/core/src/test/SocratesAgent.test.ts
CI=true pnpm --filter @socrates/server test -- apps/server/src/test/server.test.ts
CI=true pnpm --filter @socrates/core typecheck
CI=true pnpm --filter @socrates/server typecheck
CI=true pnpm --filter @socrates/contracts test
CI=true pnpm --filter @socrates/mcp test
git diff --check
```

Latest verified for credential-aware model routing and ChatGPT Codex auth on 2026-07-03:

```text
git diff --check
pnpm --filter @socrates/core test
pnpm --filter @socrates/providers test
pnpm --filter @socrates/server test
```

Latest verified for Ollama embedding setup and active-index cleanup on 2026-07-05:

```text
pnpm --filter web typecheck
pnpm --filter @socrates/server typecheck
pnpm --filter @socrates/server test -- server.test.ts --runInBand
browser QA on localhost:3000 with API localhost:4000: Test-Workspace and TU Work switched to ollama / embeddinggemma:latest; semantic trace_retrieve succeeded; stale trace_embeddings rows = 0
git diff --check
```

Latest verified for CodeAct capability composition and URL fetch on 2026-07-05:

```text
pnpm --filter @socrates/contracts test -- contracts.test.ts
pnpm --filter @socrates/contracts build
pnpm --filter @socrates/core typecheck
pnpm --filter @socrates/core test -- SocratesAgent.test.ts
pnpm --filter @socrates/server typecheck
pnpm --filter @socrates/server test -- src/ws/urlFetch.test.ts
pnpm --filter @socrates/server test -- memoryDocParser.test.ts
```

Latest verified for release readiness after Ollama embeddings, CodeAct/url_fetch, ChatGPT Codex model catalog, and runtime packaging fixes on 2026-07-06:

```text
git diff --check
pnpm typecheck
pnpm build
pnpm test
pnpm runtime:archive
live app: http://127.0.0.1:3000/welcome returned 200, http://127.0.0.1:4000/health returned ok
runtime archive produced release-artifacts/socrates-runtime-darwin-arm64.zip, manifest version 0.1.16, bundled Node v20.20.2
```

Live DeepSeek V4 Pro browser E2E on 2026-06-17 used OpenRouter `deepseek/deepseek-v4-pro` with thinking on in `Test-Workspace`. Requests had `NO_STATE_LEDGER`, `NO_LAST_TURN`, and `HAS_STABLE_WAKE`. That E2E predates the 2026-06-25 removal of main-chat wake-context injection. The edit probe confirmed the enforced sequence: `project_docs(area:"notes")`, `repo_docs`, approved `edit`, then `project_docs(area:"memory")` before final. OpenRouter routed to StreamLake; the first two simple chat turns had zero cached input tokens, while same-turn tool continuations produced cache hits.

Run `git diff --check` and a tracked-file sensitive scan before publishing a release tag.
