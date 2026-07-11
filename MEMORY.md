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
- A centralized, human-facing Memory Router that chooses which curated docs Socrates should open, splits important new memory into the right writable surfaces, and attaches capped always-apply rule sections through the stable cache prelude every turn.

The semantic retrieval foundation is implemented and architecture-authoritative:

- One reusable retrieval subsystem indexes clean visible Q&A turns and curated memory-document sections. SQLite remains authoritative; LanceDB under `${SOCRATES_HOME}/retrieval/lance` owns reproducible lexical, vector, and hybrid search data.
- Main-agent `trace_retrieve` is strictly active-project scoped. Its advertised modes are `lexical`, `semantic`, `combined`, and `audit`; full-project search is the default, while current/recent conversation narrowing remains optional. Main Socrates must not see `all_projects`, `projectId`, or `projectTitle`. The Global Memory Agent and Skill Writer use the same four modes, query limits, Q&A parents, audit/inspect behavior, and clean result fields; their only broader capability is explicit cross-project scope, project/conversation selectors, and `projectTitle` in each result.
- Lexical trace queries have a 128-character limit and search every supplied term. There is no hidden term-count slicing. Semantic and combined queries have a 1,000-character limit. Invalid/oversized inputs and unavailable semantic indexes return recoverable errors instead of silently changing the query.
- The canonical semantic trace parent is one visible Q&A turn. User and assistant text are role-separated and Markdown-aware chunked at a 500-token target with 150-token overlap. Complete answers, cancelled partials, and user-only failed/cancelled turns are labeled and indexed; mechanical summaries, verbatim duplicates, compaction summaries, tool/shell/file/patch/error material are excluded from the normal vector corpus and remain available through authoritative SQLite audit search.
- Curated memory sections from user profile, identity, project memory, project notes, and repo docs use the same chunking/indexing path. Always-apply sections are not retrieval candidates because they are already attached through the stable cache prelude. Changed section hashes cause section-only reindexing; deleted files/sections are reconciled out.
- Search returns at most eight distinct parent turns/sections. Relevance is primary; recency only reorders normalized results within a 0.05 score band. Model-facing rows use numbered results and human metadata, never scores, vector/chunk/message ids, or embedding internals. Backend SQLite keeps lifecycle-bound retrieval diagnostics.
- Memory Router becomes a real `MemoryRouterAgent` using a reusable structured tool-agent runner, one `memory_search` tool, a three-call cap per pre-turn/post-evidence phase, automatic hybrid prefetch over the current user prompt, and strict Zod output with exact `readTargets` and document-backed `memoryWrites`.
- Every actual Global Memory Agent model run performs evidence-gated self-healing for global user profile and identity: clear misplacements/duplicates may be atomically moved or merged with evidence preserved, ambiguous entries remain untouched, and project/repo corrections remain Socrates-owned leads.
- The supported distribution is the NPM CLI plus backend/frontend runtime archives for `darwin-arm64`, `darwin-x64`, and `win32-x64`. Runtime construction lives under root `scripts/runtime/`; `apps/desktop` only retains a compatibility wrapper. Tauri/Rust/desktop-shell work is dormant and out of scope.
- Backend LanceDB is pinned to `0.22.3`, the newest release line that publishes native packages for all three supported runtime targets. Camel-case Lance predicates use explicitly quoted identifiers for compatibility, and retrieval shutdown closes the native connection eagerly.
- The packaged launcher allows up to 180 seconds for backend readiness because first startup may reconcile and rebuild retrieval indexes before `/health` is ready.
- Main-chat routed writes use a same-turn semantic ledger so equivalent pre/post routes do not write the same durable fact twice. The backend also deduplicates paraphrased same-turn memory notes before insert.
- Atomic profile/identity moves retarget matching `evidence_index used_by` references in the same validated patch. The Memory Agent receives a mandatory audit queue for obvious hard rules outside the always-apply section, must resolve each item, and leaves ambiguous/cap-blocked entries untouched.

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
- `user_profile.evidence_index` is a source-anchor section, not a summary bucket. It should store compact traceable anchors for important profile claims: date, project/conversation title or id, turn/message/event id when available, the claim supported, and the profile section using that claim.
- `memory_note` is the Socrates-to-Memory-Agent notepad tool. Its model-facing input stays human-sized: `note` plus optional `importance` (`normal` or `high`). The backend automatically attaches the current user message, conversation id, turn id, message id, source project, workspace path when available, and a default project-local skill scope; Socrates should not author ids, skill names, target files, or global/project scope in prose. The tool description tells Socrates to prefer one note, create at most two distinct notes per user-turn, and merge related points into one clean note whenever possible.

## Runtime Notes

- Main chat no longer injects `<socrates_wake_context>` on the first turn or later turns. Stable recall routing now lives in `packages/core/src/prompts/socratesPrompt.ts`, pointing Socrates to `project_docs`, `repo_docs`, `user_profile`, `soul`, `skills`, and `mcp_registry` when the current task needs them.
- Main chat has a production `MemoryRouterAgent` around normal model calls. The complete user prompt is shared-chunked and automatically hybrid-prefetched against eligible memory sections before router reasoning. The router may make at most three additional `memory_search` calls, then tools are disabled and it must return strict Zod `readTargets` and `memoryWrites` with exact valid surface, filename, and section ids. It does not author patches. Socrates opens exact targets, writes project/repo docs through dedicated tools, and sends profile/identity/skill candidates through `memory_note`. Post-evidence routing saves only durable outcomes, open loops, or corrections. A same-turn routed-write ledger suppresses equivalent pre/post writes without changing the stable prompt prefix. The router model is configured through the Memory Router worker setting.
- Always-apply recall stays simple and curated through one centralized always-apply rules list with two lanes. `user_profile.md` has a capped, human-readable `Global Always-Apply Rules` section and workspace project memory has a capped `Project Always-Apply Rules` section; each holds at most 10 rules. The runtime reads both every applicable turn and renders them once in `<socrates_stable_cache_prelude>` before conversation/user text so providers can reuse the same prompt prefix. Fuller repo doctrine still belongs in `.socrates/repo_docs/*`; a short always-apply project rule may point Socrates to the relevant repo-doc contract when needed.
- Socrates now has explicit CodeAct-style capability-composition guidance in `packages/core/src/prompts/socratesPrompt.ts`: use structured tools first, discover MCPs when appropriate, then use Terminal/code for bounded one-off scripts when no exact tool exists. Terminal remains approval/policy gated for installs, broad network work, large downloads, and risky mutations.
- First-turn project recall is mandatory for light greetings, "continue", "where were we", and broad project-status openers: Socrates must read `project_docs` notes `active_context` before answering so active project loops can surface naturally.
- The Socrates prompt envelope stays cache-friendly: stable system instructions first, then the stable always-apply prelude, then conversation/user text, and only then dynamic routed context, tool results, docs checkpoints, and ledgers. No changing current date/time, workspace scan block, skill/MCP counts, or hidden matched skill/MCP ids belong in the system prompt.
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
- Memory-agent `trace_retrieve` searches all projects by default or narrows with `scope="project"` plus `projectId`/`projectTitle`; project selectors may be strings or lists, while conversation id/title selectors are singular. It uses `lexical`, `semantic`, `combined`, and `audit`, rejects legacy `exact`/handles, and inspects by result number, turn id, or project/conversation/turn coordinates.
- Memory-agent tool guidance is seeded under `~/.Socrates/tool_usage/memory_agent/` and is readable through the existing `tool_docs` tool.
- The Memory Agent can update `user_profile.md` directly through scoped backend edits and can update `identity.md` only through the existing confirmation policy. For skills, it decides whether the evidence is procedural enough to propose a create/update, chooses project or global scope, and sends the approved request to the Skill Writer Agent; it should not hand-author final `SKILL.md` files itself.
- Every successful Global Memory Agent run now ends with strict Zod structured output and one row in `memory_agent_journal`. The backend supplies a bounded cross-run briefing containing automatic statistics, recent skill proposal/Writer outcomes, the previous handoff, unresolved investigations, and the latest three run summaries. New unresolved items receive stable `meminv_...` ids; the generated `~/.Socrates/memory_agent/MEMORY_AGENT_LEDGER.md` is a readable snapshot while SQLite remains authoritative.
- The Memory Agent alone receives `read_memory_journal`, a read-only history tool with only `list` and `read`: lists default to 5 and cap at 10 compact rows, reads default to 12,000 characters, and both have a hard 20,000-character cap. Journal history is not embedded in V1.
- `memory_notes` is the Memory Agent inbox: `list` returns at most 10 numbered rows with importance, default project/global skill-scope hint, source project/workspace metadata when available, and the first short slice of the note; `read(noteNumber)` returns the full note, attached user-message excerpt, and backend-provided trace lookup ids for immediate `trace_retrieve` chaining; `mark_done(noteNumber, outcome, resolution)` closes the item after processing. Outcomes are exactly `applied`, `already_represented`, `skipped`, or `proposed_skill`; the one-line resolution says what changed or why no write was needed.
- Classification is mandatory before action: durable user facts/preferences and global active context usually go to `user_profile.md` (with evidence anchors for important claims), rare Socrates identity/behavior changes go through the identity confirmation path, reusable procedures may become skill proposals, and project-local or weak/current-turn-only notes should be skipped with an explicit resolution. Project-specific active context belongs in workspace `.socrates/PROJECT_NOTES.md`, not in global user profile.
- Mixed evidence turns must be split strictly: if a turn contains both a global user fact and a project-local active plan, the Memory Agent may update `user_profile.md` only for the global fact and must leave repo/workspace sequencing, implementation order, and active project reminders to Socrates/project notes. Profile corrections must update the content section and evidence anchors together so stale evidence does not keep supporting the old claim.
- Socrates-originated notes default to project-local skill scope because Socrates is acting inside a project. The Memory Agent may keep that project scope or deliberately upgrade to global only when the procedure is clearly reusable across projects. Memory-Agent-discovered skill proposals must also choose project or global scope explicitly.
- Memory-note creation has backend normalization and hard deduplication before insert. Any duplicate normalized Socrates note returns the existing note instead of creating another row, and a third non-duplicate Socrates note in one source turn is rejected with a recoverable store/tool error. The Memory Agent closes already-covered evidence with outcome `already_represented` rather than triggering another profile, identity, or skill update.
- Section indexes persist in SQLite tables `memory_doc_indexes` and `memory_doc_sections`; these are rebuilt from markdown content during ensure/index operations and are lookup aids, not the source of truth.
- Model identity includes both provider and auth mode. `authMode = "api_key"` covers OpenRouter, OpenAI API, Google API keys, direct DeepSeek API keys, and local Ollama chat models; `authMode = "chatgpt_subscription"` covers the experimental ChatGPT Codex OAuth path for OpenAI subscription models. The current ChatGPT Codex subscription catalog also declares `gpt-5.6-luna` (default Medium thinking for that row), alongside `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and text-only `gpt-5.3-codex-spark`; Luna availability and capabilities remain unverified because the July 2026 eval account returned `Model not found`. `/api/models` is credential-aware and returns only models whose provider/auth mode is configured, plus chat-capable models discovered from a reachable local Ollama runtime. Ollama discovery is read-only and never pulls or installs models. If OpenRouter is configured, OpenRouter DeepSeek V4 Pro remains the default available chat model unless another provider/auth setting is selected. OpenRouter also declares text-only `tencent/hy3` and `z-ai/glm-5.2`; HY3 uses Off/Low/High, while GLM 5.2 uses High/Extra High. Direct DeepSeek API exposes official `deepseek-v4-pro` and `deepseek-v4-flash` rows through the same catalog and worker settings when `DEEPSEEK_API_KEY` is configured. If ChatGPT Codex is connected, the main composer prefers ChatGPT Codex models for new/effective chat selection while API-key models remain selectable.
- OpenAI now has two separate credential statuses: `OpenAI API` and `ChatGPT Codex`. The ChatGPT Codex flow uses PKCE OAuth against `auth.openai.com`, stores Socrates-owned token metadata under local credential storage, refreshes access tokens on demand, and routes subscription requests through the Codex backend auth shim. OpenAI embeddings remain API-key only.
- Project semantic search supports hosted OpenAI embeddings and local Ollama embeddings. The Ollama setup path remains read-only and never installs or pulls models. Provider/model/dimension changes create a clean LanceDB table for the new embedding fingerprint; the previous table is removed only after the replacement is ready, interrupted jobs are marked failed on restart, and SQLite remains authoritative.
- Global memory-agent settings live behind `/api/memory-agent` and are surfaced on the Settings page. Defaults are OpenRouter `xiaomi/mimo-v2.5-pro`, thinking off, enabled, cadence 10 minutes, but credential-aware resolution prefers ChatGPT Codex `gpt-5.5` with low reasoning when ChatGPT Codex is connected and the saved setting is still the built-in default or unavailable. Explicit Ollama selections are preserved when the discovered local model remains available.
- Worker model settings live behind `/api/worker-model-settings` and are surfaced on the Settings page for Skill Writer, Context Compactor, Title Generator, and Memory Router. Settings persist provider, auth mode, model, and thinking choice. Defaults preserve the current working models, but credential-aware resolution prefers ChatGPT Codex `gpt-5.4-mini` with low reasoning for built-in/default unavailable worker settings when ChatGPT Codex is connected. Explicit Ollama selections resolve through the same refreshed model catalog and use Ollama's Off/On thinking toggle.
- Memory Router provider usage is recorded as `ai_usage_events.source_kind = "memory_router"` and rolled into the existing turn/conversation cost total. Do not add a separate visible router-cost widget unless the product direction changes.
- Socrates' visible voice should be warm, direct, and human. Internal evidence such as tool names, ids, hashes, model names, backend state, empty active-context wording, and commit SHAs should be translated into plain language unless the user asks for exact diagnostics.
- Completed chat turns are indexed for trace retrieval, but they no longer enqueue a per-turn memory job. The scheduler or manual settings-page action wakes the global agent.
- Legacy per-project memory-agent settings remain only as inactive DB/store compatibility baggage; the per-turn worker runtime path has been removed.
- Project skill creation remains user-triggered from the dashboard `Skills +` flow, and global skill creation/deletion remains user-triggered from Memory Center. These flows should route approved skill creation/update work through the Skill Writer Agent instead of a one-off provider stream.
- Memory Agent skill suggestions should be user-visible notifications first: "Socrates proposed this skill/update" with a concise summary. Default behavior is manual approval per skill; a later setting may allow auto-approval. Once approved, the Skill Writer Agent should always do the create/update unless validation or write tooling fails.
- Routine memory notifications should behave as a quiet activity log, not a raw diff stream or attention-grabbing alert. They should show clean formatted summaries of what changed, which primary docs were touched, how many memory notes were created/processed, and how many ended as `applied`, `already_represented`, `skipped`, or `proposed_skill`. Pending skill proposals are the main notification type that should be visually action-needed because the user must approve or reject them.
- The Skill Writer Agent needs a narrow tool belt: read approved request context, `trace_retrieve`, full `skills` list/describe/read for existing skill content, read-only `user_profile`, read-only `soul`, read-only project/repo docs for project skills, and a scoped `skill_write` tool for final `SKILL.md` creation/update. It must not get shell, arbitrary filesystem reads/writes, project docs writes, repo docs writes, identity/profile writes, or raw path mutation tools.
- Global MCP servers are available to all projects; project MCP servers are workspace-local and inherit global servers. Playwright MCP is bundled and protected from deletion. The model-facing `mcp_registry` path is `list`/`describe`; UI/API flows handle configure, check, enable/disable, and delete.
- Memory Center (`/memory`) is the global memory-agent control surface. It uses a fixed `h-screen` shell: header and footer stay anchored, the middle region scrolls, and desktop splits the main content scroller from the Memory Files rail scroller. Core Memory renders only Identity and User Profile.
- Primary identity/profile migrations never keep a generic legacy block. They route old headings into the canonical sections, drop old scaffolding lines, and compact obvious duplicate migrated bullets.
- Skill writing now routes through the production Skill Writer Agent path with a dedicated prompt, shared Socrates agent runner, scoped tool registry, and `skill_write` validation/write tool.
- Identity proposals through `soul` still require internal confirmation and user-visible notification.
- Legacy project memory from `~/.Socrates/projects/<projectId>/` is migrated into workspace `.socrates/MEMORY.md` and the old project root is removed.
- Legacy six repo docs are migrated by scaffold behavior into the four-doc system; old workspace repo-doc files are removed by initialization.
- Official DeepSeek API integration belongs in `packages/providers/src/deepseek/` as a native `ModelProvider`, not through the Vercel AI SDK or route/server one-off code. It must preserve Socrates' normalized stream/tool/reasoning/usage events, map DeepSeek `reasoning_content` back into same-turn tool-loop assistant messages, expose only Off/High/Max thinking choices for direct DeepSeek models, and normalize DeepSeek KV-cache usage fields into `cached_input_tokens` / `uncached_input_tokens` accounting.
- Direct DeepSeek function-tool parameters must always leave the adapter as top-level JSON Schema objects. Some Socrates model-visible contracts are Zod unions/preprocess/discriminated unions (`edit`, `trace_retrieve`, `skills`, `project_docs`, `repo_docs`, `mcp_registry`) that DeepSeek rejects if sent as top-level `anyOf` without `type: "object"`. `packages/providers/src/toolJsonSchemas.ts` owns the provider-compatibility object schema normalization; `packages/core` still validates actual tool calls against the original strict schemas from `packages/contracts`.

## Context Compression

- Compression is triggered at 170k estimated model-visible input tokens for both normal Socrates chat calls and backend Global Memory Agent calls.
- Compaction treats at most 60k total rebuilt context as `excellent`, aims for at most 80k as the preferred soft target, accepts 80-120k as `acceptable`, and rejects results above the 120k post-compaction safety ceiling. The provider hard limit remains 180k, and a successful compaction must remove at least 20k tokens (or the proportional small-fixture equivalent in tests).
- Recent completed Q/A tail is kept raw by whole-turn boundary up to the smaller of its 50k cap or the remaining 80k preferred-total budget after reserving the system/tool prefix, current active turn, and maximum structured summary allowance.
- Current active-turn tool pressure keeps the latest tool results by whole tool-call boundary, targeting about 50k tokens and keeping at least the latest five results when possible.
- Older head context is compacted through `CompressorAgent`, not streamed prompted JSON.
- Chat and memory compaction schemas live in `packages/contracts/src/contextCompression.ts`; chat uses `chatCompactionSchema`, and memory-agent context uses `memoryCompactionSchema`.
- Compressor prompts live in `packages/core/src/prompts/socratesCompressorPrompt.ts` and `memoryAgentCompressorPrompt.ts`; the backend memory-agent runner must pass `contextCompression: { enabled: true, mode: "memory" }`.
- Strict Zod validation happens before snapshot activation. Invalid new-schema output never becomes active memory; legacy invalid snapshots are ignored rather than migrated.
- Anchors must start with `Turn <number>:` and may reference only turns actually present in compressor input. If only anchors fail, the compressor repairs anchors through the structured anchor repair schema. Bounded high-value source artifacts are carried forward deterministically even when a model omits them: exact `.socrates/attachments/...` paths enter `relevantFiles`, exact shell commands enter `toolState`, and explicit unresolved/do-not-complete user instructions enter `blocked`.
- An active snapshot is applied before token counting and provider dispatch: its hidden summary is prepended once, raw turns represented by its source handles are omitted from the model request, and the authoritative raw rows remain in SQLite for trace/audit retrieval.
- The server chooses the compressor through the Context Compactor worker setting plus credential-aware model resolution. The built-in default is OpenRouter `deepseek/deepseek-v4-flash` with thinking off. When ChatGPT Codex is connected and the saved worker setting is the built-in default or unavailable, the effective compressor is ChatGPT Codex `gpt-5.4-mini` with low reasoning. Hard-coded OpenRouter fallbacks must not run when OpenRouter is unavailable.

## Stable Socrates Surfaces And Chat Sources

- `packages/contracts/src/socratesSurfaces.ts` is the code-owned registry for the nine durable global/project Socrates surfaces. It drives path guards, storage paths, and the compact generated model-facing surface map; markdown does not duplicate that routing truth.
- Main model assembly keeps a byte-stable prefix: base prompt, compact identity core, global always-apply rules, project always-apply rules, then the generated surface map. User/project metadata, routed memory, runtime facts, tool results, and ledgers follow as dynamic context.
- Inline chat text is capped at 10,000 characters. A larger paste is uploaded as a `text/plain` source under `.socrates/attachments/` and the model receives only a compact provenance manifest until it reads/searches the file.
- One message may reference at most 15 image/text attachments, with 5 MB per attachment and 20 MB combined. Text bytes are never silently injected into every model request; image bytes are sent only to vision-capable models.

## Release State

- Current GitHub runtime release target is `v0.1.17`; npm launcher source is prepared as `@socrates-ai/cli@0.1.17` for manual npm publish after the GitHub runtime release completes.
- `v0.1.17` preserves the `v0.1.16` Ollama embedding setup, CodeAct/url_fetch guidance, expanded ChatGPT Codex subscription model catalog, and runtime packaging fixes, and adds local Ollama chat model discovery/routing across the main composer, worker model settings, title generation, memory router, and Global Memory Agent. Runtime archive packaging also keeps the proven pnpm 9 GitHub path while adding pnpm 10+ local deploy compatibility with legacy deploy and native build-script allowance.
- Release tooling remains pinned to the proven `pnpm@9.15.1` path for GitHub runtime builds. The runtime release workflow recreates the tag release and uploads each runtime asset explicitly (`darwin-arm64`, `darwin-x64`, `win32-x64`, then `SHA256SUMS`) so a stale partial draft cannot be reused. The produced runtime archive still bundles Node v20.20.2.
- Shell Tooling pins its Windows leg to `windows-2022`; `windows-latest` moved to Windows Server 2025 / VS 2026, where `node-gyp` cannot identify Visual Studio 18 while building native dependencies such as `better-sqlite3`. Windows still runs install/typecheck plus contracts/workspace/core tests, while the server PTY/WebSocket test suite runs on Ubuntu only because it assumes POSIX bash/PTY behavior.
- `user_profile.evidence_index` should now store compact source anchors for important profile claims, including date, project/conversation title or id, turn/message/event id when available, the supported claim, and the profile section using that claim.
- Product stabilization commit `2756e97 Stabilize extension discovery context` is pushed to `origin/main`. It removes per-turn wake context from main chat, moves stable recall/extension routing into the base prompt, and keeps skills/MCPs behind on-demand `list`/`describe` tools.
- Credential-aware model routing and experimental ChatGPT Codex auth commit `6a29dad Add ChatGPT Codex auth model routing` is pushed to `origin/main`. It adds auth-mode-aware model settings, filtered `/api/models`, ChatGPT Codex OAuth/token refresh, Codex request routing, UI credential status, Codex-preferred defaults for chat/workers/memory-agent, and compressor regression coverage for active context, anchors, and full structured fields.
- Ollama embedding setup commit `21d9fc9 Add Ollama embedding setup` is pushed to `origin/main`. It adds Ollama model discovery/recommendations, offline setup guidance without automatic pulls, project embedding configuration for Ollama, active-index-only cleanup for `trace_embeddings`, in-flight stale job guards, and updated context files/contracts/tests.
- Memory-front hardening commit `df82d0b feat: harden Socrates memory front` is pushed to `origin/main`. It adds the code-owned nine-surface registry, byte-stable identity/rules/surface prelude, large-paste text attachments and bounded image/text submissions, hardened snapshot reuse and compaction gates, HY3/GLM/Luna catalog updates, and the reproducible `evals/memory-harness/` baseline/report/runner. GPT-5.6 Luna remains declared but the connected July 2026 Socrates OAuth account returned `Model not found gpt-5.6-luna`.
- Context compaction now uses a single-pass soft sizing policy: 60k or less is `excellent`, 80k or less is `preferred`, 80-120k is `acceptable`, and results above 120k are rejected while the 170k trigger and 180k hard provider ceiling remain unchanged. Recent whole-turn history is dynamically fitted into the remaining 80k budget after fixed prompt/tool context, the active turn, and the maximum summary allowance are reserved; this does not add a second compressor call.

## Next Major Work

- Keep strengthening Socrates' investigation harness based on real Gemini/GPT/OpenRouter runs, especially around overbroad mutations and respecting user-scoped constraints.
- Extend the checked-in repeated-compaction harness with more corpora and provider runs; the first sanitized 36-turn golden dataset, five-round DeepSeek baseline, final 8/8 improved DeepSeek confirmation, two-round GLM run, downstream trace/attachment/project-memory/fresh-conversation checks, and cost ledger now live under `evals/memory-harness/` (private generated corpora/results stay gitignored).
- Consider a dedicated safety rule for files whose names clearly ask not to be opened, because the latest Gemini E2E still opened `please_do_not_open.md`.
- The completed 2026-07-10/11 skill-learning evaluation hardened evidence handoff, canonical skill ids, write validation/supporting files, no-op rejection, bounded Writer repair, cross-run structured Memory Agent journaling, backend-authoritative create/update classification, and main-agent discovery for ordered verification/closure workflows. The composed isolated official-DeepSeek E2E passed: an earlier full run proved behavioral pattern proposal -> approved Writer creation -> v1 held-out use, and a deterministic seeded continuation proved a cross-project handoff refinement -> update proposal -> Writer v2 -> actual main-agent `skills list` + `describe` -> 6/6 held-out behavior signals. Use Memory Pro/high plus Writer Flash/off as the experimental default, keep manual proposal approval, and do not claim production-scale reliability from one passing chain.

## Verification

Latest verified for soft-target compaction budgeting and memory-front hardening on 2026-07-11:

```text
pnpm typecheck
pnpm test
  -> CLI 9, contracts 24, MCP 9, providers 89 (+1 intentionally skipped), workspace 102, core 63, server 121; 417 passed total
pnpm build
git diff --check
tracked-change sensitive-data scan
focused compaction regression
  -> adaptive recent-tail budgeting against the 80k preferred total
  -> 60k excellent and 80-120k acceptable size classification
  -> 120k rejection ceiling remains enforced without a second compressor call
evals/memory-harness final official DeepSeek V4 Flash/Off run
  -> five sequential compactions, 8/8 canaries
  -> trace_retrieve exact Turn 5 recovery
  -> selective pasted-text attachment read
  -> project-memory closure, stale-open-state removal, fresh-conversation recovery
```

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

Latest verified for official Direct DeepSeek on 2026-07-08:

```text
CI=true npx --yes pnpm@9.15.1 --filter @socrates/providers test
CI=true npx --yes pnpm@9.15.1 --filter @socrates/providers typecheck
CI=true npx --yes pnpm@9.15.1 --filter @socrates/contracts test -- contracts.test.ts
CI=true npx --yes pnpm@9.15.1 --filter @socrates/server typecheck
CI=true npx --yes pnpm@9.15.1 --filter @socrates/core typecheck
CI=true npx --yes pnpm@9.15.1 --filter web typecheck
browser QA on localhost:3000 with API localhost:4000: Test-Workspace chat conv_02148ef15f534408bb587a92cb7eb71e used direct DeepSeek V4 Pro, High thinking, streamed a visible Thinking part, completed one current_time tool call, and persisted direct deepseek usage with DeepSeek KV cache telemetry (`prompt_cache_hit_tokens` 12544, `prompt_cache_miss_tokens` 239 on the continuation call).
curl /api/models confirmed direct `deepseek-v4-pro` and `deepseek-v4-flash` rows under `DeepSeek API`, each with Off/High/Max thinking and High default.
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

Latest verified for release readiness after Ollama chat model support on 2026-07-06:

```text
git diff --check
pnpm typecheck
pnpm --filter @socrates/providers test
pnpm --filter @socrates/contracts test
pnpm --filter @socrates/core test
pnpm --filter @socrates/server test
CI=true pnpm --filter web typecheck
pnpm build
pnpm runtime:archive
live app: http://127.0.0.1:3000, API http://127.0.0.1:4000/health ok
browser E2E: Test-Workspace fresh chat selected qwen3.5:4b / Ollama Local, thinking Off, sent "hi", received a completed answer with one project_docs tool call and no browser console errors
DB proof: ai_usage_events recorded main_model_call provider_id=ollama, model_id=qwen3.5:4b, status=completed, routed_provider=ollama, cost_source=unknown
runtime archive produced release-artifacts/socrates-runtime-darwin-arm64.zip, manifest version 0.1.17, runtimeKind cli, bundled Node v20.20.2
```

Latest verified for the semantic retrieval foundation on 2026-07-10:

```text
pnpm --filter @socrates/contracts --filter @socrates/core --filter @socrates/server --filter @socrates-ai/cli test
  -> CLI 9, contracts 21, core 50, server 114; all passed
pnpm typecheck
pnpm build
pnpm retrieval:benchmark
  -> 10,000 chunks / 32 dimensions / 12 runs
  -> lexical median 0.63 ms, p95 0.74 ms
  -> exhaustive vector median 1.42 ms, p95 1.64 ms
  -> hybrid RRF median 3.34 ms, p95 3.69 ms
node scripts/runtime/build-runtime-archive.mjs release-artifacts
  -> packaged LanceDB FTS/vector/hybrid smoke passed
  -> release-artifacts/socrates-runtime-darwin-arm64.zip, 519.9 MB
  -> SHA-256 17f804b55221360e4bb2ba09d179d3b50a7963c3c689a493bc8beeec8a3231c0
registry/lock matrix -> @lancedb/lancedb 0.22.3 publishes darwin-arm64, darwin-x64, and win32-x64-msvc native packages; runtime-release.yml executes the same archive smoke natively on macos-14, macos-15-intel, and windows-2022
```

Real packaged Test-Workspace verification:

```text
conversation conv_9c32a8f5f50548969b0840d419f35326, turn turn_d2341781f3df4df894f5bb741dac2af0
router: direct DeepSeek V4 Flash, thinking off; two validated calls with 512 and 640 cached input tokens
main: direct DeepSeek V4 Pro, thinking high; streamed to completion with 4 successful tools and 3,840 / 12,160 cached input tokens across its calls
tools: current_time, project_docs notes active_context, project_docs memory index, repo_docs index
result: exact Vienna time, concise verification doctrine, and the unresolved AI Deepplay ordering constraint from project context
retrieval diagnostics: automatic memory combined runs completed through LanceDB; Test-Workspace index ready with 213 Q&A parents / 1,102 chunks and 54 memory parents / 60 chunks
Memory Agent job memjob_e590b8b36e0b4c10b2d398e0012d2f53: direct DeepSeek V4 Pro high moved the misplaced Code Implementation hard rule into Global Always-Apply Rules, removed the collaboration-style duplicate, preserved evidence, and stayed under the 10-rule cap
```

Latest verified for unified Global Memory Agent trace retrieval on 2026-07-10:

```text
pnpm test
  -> CLI 9, contracts 21, MCP 9, providers 88 (+1 skipped), workspace 102, core 51; server rerun 115/115 after a documentation-search wording fix
pnpm typecheck
pnpm build
pnpm runtime:archive
  -> packaged LanceDB FTS/vector/hybrid smoke passed
  -> release-artifacts/socrates-runtime-darwin-arm64.zip, 520 MB
focused global retrieval E2E test
  -> lexical/semantic/combined share LanceDB, audit/inspect share authoritative project retrieval paths
  -> clean projectTitle-bearing rows, cross-project selection/isolation, result-number inspect, no exact/handle/internal-id surface
packaged browser E2E on localhost:3000/4000
  -> Test-Workspace direct DeepSeek V4 Pro High streamed and completed memory_note #12
  -> Memory Agent memjob_aa4a85e91c464da0a07bc0d190265957 used direct DeepSeek V4 Pro High, inspected trace_retrieve by turnId, returned one clean global Q&A parent, and marked the note already_represented with no file action
  -> 11,392 cached / 709 uncached input tokens on 12,101 prompt tokens
```

Live DeepSeek V4 Pro browser E2E on 2026-06-17 used OpenRouter `deepseek/deepseek-v4-pro` with thinking on in `Test-Workspace`. Requests had `NO_STATE_LEDGER`, `NO_LAST_TURN`, and `HAS_STABLE_WAKE`. That E2E predates the 2026-06-25 removal of main-chat wake-context injection. The edit probe confirmed the enforced sequence: `project_docs(area:"notes")`, `repo_docs`, approved `edit`, then `project_docs(area:"memory")` before final. OpenRouter routed to StreamLake; the first two simple chat turns had zero cached input tokens, while same-turn tool continuations produced cache hits.

Run `git diff --check` and a tracked-file sensitive scan before publishing a release tag.
