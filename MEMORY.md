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
- A first-class no-tool `CompressorAgent` that runs both chat and memory compaction through `StructuredToolAgentRunner`, mode-specific prompts, explicit empty tool registries, and strict structured output schemas.
- No production diary read/write/search path and no per-turn main-chat wake-context injection.
- A centralized, human-facing Memory Router whose pre-turn phase is strictly read-only, whose genuine finalization phase plans bounded `.socrates` reconciliation from lifecycle-wide task evidence, and which attaches capped always-apply rule sections through the stable cache prelude every turn.

The semantic retrieval foundation is implemented and architecture-authoritative:

- One reusable retrieval subsystem indexes clean visible Q&A turns and curated memory-document sections. SQLite remains authoritative; LanceDB under `${SOCRATES_HOME}/retrieval/lance` owns reproducible lexical, vector, and hybrid search data.
- Main-agent `trace_retrieve` is strictly active-project scoped. Its advertised modes are `lexical`, `semantic`, `combined`, and `audit`; full-project search is the default, while current/recent conversation narrowing remains optional. Main Socrates must not see `all_projects`, `projectId`, or `projectTitle`. The Global Memory Agent and Skill Writer use the same four modes, query limits, Q&A parents, audit/inspect behavior, and clean result fields; their only broader capability is explicit cross-project scope, project/conversation selectors, and `projectTitle` in each result.
- Lexical trace queries have a 128-character limit and search every supplied term. There is no hidden term-count slicing. Semantic and combined queries have a 1,000-character limit. Invalid/oversized inputs and unavailable semantic indexes return recoverable errors instead of silently changing the query.
- The canonical semantic trace parent is one visible Q&A turn. User and assistant text are role-separated and Markdown-aware chunked at a 500-token target with 150-token overlap. Complete answers, cancelled partials, and user-only failed/cancelled turns are labeled and indexed; mechanical summaries, verbatim duplicates, compaction summaries, tool/shell/file/patch/error material are excluded from the normal vector corpus and remain available through authoritative SQLite audit search.
- Curated memory sections from user profile, identity, project memory, project notes, and repo docs use the same chunking/indexing path. Always-apply sections are not retrieval candidates because they are already attached through the stable cache prelude. Changed section hashes cause section-only reindexing; deleted files/sections are reconciled out.
- Search returns at most eight distinct parent turns/sections. Relevance is primary; recency only reorders normalized results within a 0.05 score band. Model-facing rows use numbered results and human metadata, never scores, vector/chunk/message ids, or embedding internals. Backend SQLite keeps lifecycle-bound retrieval diagnostics.
- Memory Router is a real `MemoryRouterAgent` using a reusable structured tool-agent runner, automatic hybrid prefetch over the current user prompt, a strictly read-only pre-turn `readTargets` contract, and a genuine end-of-task reconciliation contract. Final routing receives bounded deterministic evidence for the whole user-request lifecycle and may inspect only backend-created `evd_` references.
- Every actual Global Memory Agent model run performs evidence-gated self-healing for global user profile and identity: clear misplacements/duplicates may be atomically moved or merged with evidence preserved, ambiguous entries remain untouched, and project/repo corrections remain Socrates-owned leads.
- Explicit user memory opt-outs are authoritative across main Socrates, the Memory Router, and the Global Memory Agent. Genuine "do not remember/save/store this" intent is interpreted from full semantic meaning rather than literal phrase matching; quoted examples and feature discussions do not trigger it. Clearly scoped opt-outs cover only that content, while broad or ambiguous scope covers the whole source message. Ordinary "do not edit files", "make no workspace changes", or "review only" instructions restrict user workspace artifacts but do not by themselves suppress bounded `.socrates` housekeeping; the user must semantically include Socrates memory, project notes, internal state, `.socrates`, or all changes whatsoever to extend the restriction there. Main Socrates sends no memory note and performs no project-doc write for opted-out content; the Memory Router plans no reconciliation; and the Global Memory Agent must inspect the exact full Q&A parent before any write and must not place opted-out content in identity, user profile/evidence anchors, skill proposals, or its durable journal.
- The product and supported distribution are the normal web frontend plus backend, launched through the NPM CLI and backend/frontend runtime archives for `darwin-arm64`, `darwin-x64`, and `win32-x64`. Runtime construction lives under root `scripts/runtime/`.
- Backend LanceDB is pinned to `0.22.3`, the newest release line that publishes native packages for all three supported runtime targets. Camel-case Lance predicates use explicitly quoted identifiers for compatibility, and retrieval shutdown closes the native connection eagerly.
- The packaged launcher allows up to 180 seconds for backend readiness because first startup may reconcile and rebuild retrieval indexes before `/health` is ready.
- The Memory Router never writes. Socrates owns exact project/repo doc mutations, and final answers are blocked until every planned `.socrates` reconciliation target has been mutated and re-read. The backend also deduplicates paraphrased same-turn memory notes before insert.
- Atomic profile/identity moves retarget matching `evidence_index used_by` references in the same validated patch. The Memory Agent receives a mandatory audit queue for obvious hard rules outside the always-apply section, must resolve each item, and leaves ambiguous/cap-blocked entries untouched.

Accepted next architecture work centers on three reusable agent roles:

- Socrates remains the project-working agent. It owns workspace `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, and `.socrates/repo_docs/*` through `project_docs` and `repo_docs`. It does not write identity, user profile, or skills.
- The Global Memory Agent becomes the learning curator. It keeps `~/.Socrates/user_profile.md`, `~/.Socrates/identity.md`, and skill freshness up to date from completed turns plus Socrates-authored memory notes.
- The Skill Writer Agent becomes a real specialized agent, using the same production agent-runner pattern as Socrates and the Memory Agent. It is an executor for approved skill create/update tasks, not a judge of whether a skill should exist.

## V2 Seamless Flow Implementation

The isolated experimental V2 Seamless Flow first product cut is implemented behind its own feature boundary. Whole-workspace regression, production builds, normal runtime packaging, and a real browser E2E have passed; extended unattended and cross-platform release validation remain outstanding. Its architecture authority and current limitations live in `context-files/V2_FLOW_ARCHITECTURE.md`.

The permanent boundary until the user explicitly changes it is:

- V1 Classic remains behaviorally untouched by Flow orchestration. Do not retrofit goals, goal capsules, Flow routing, self-pruning context dispositions, automatic topic separation, V2 speech jobs/read-aloud, or other V2 persistence into the V1 conversation/turn/message model or agent path. The one explicitly approved shared capability is conversation-scoped STT in the existing Classic composer: it records on demand, defaults to local Whisper `small.en`, appends the transcript to the unsent draft, never auto-sends, deletes the temporary WAV, and creates no `v2_*` row.
- V2 is a separate Seamless window/mode with `v2.*` contracts/events, `/api/v2/*` and `/v2/ws` transport, V2 services, 29 `v2_*` tables, a separate frontend route tree, and focused tests. Existing V1 conversations are never automatically migrated or reinterpreted as V2 state.
- A directly started source server keeps V2 off unless `SOCRATES_V2_FLOW_ENABLED=true`; `/api/v2/capabilities` remains mounted to report that state. The ordinary NPM/runtime-archive `scripts/runtime/launcher.mjs` starts the packaged backend with the flag defaulted to `true`, so the standard web product exposes Classic/Seamless by default; an explicitly supplied environment value can disable it for rollback.
- V2 inherits the same Socrates agent behavior, providers/model catalog, Ollama, tools, approvals, Terminal primitives, MCP registry, ZIP skill import, attachments, artifacts, workspace serialization, Memory Router implementation, and global Memory Agent. It reads and writes the same workspace `.socrates/` and global `~/.Socrates/` memory/capability surfaces through shared stores.
- The inheritance boundary is below orchestration and persistence: V2 has its own Goal Router, Flow/goal-aware context assembly and maintenance policy, runtime events, turns, tool/Terminal audit rows, and restart state. Shared memory notes carry an exact V2 source trace without adding Classic runtime rows.
- The one shared Global Memory Agent consumes completed V2 turns with project/Flow/goal labels and records processed V2 turn ids in its normal completed-job evidence receipt. V2 memory notes and Memory Agent completion never append Classic runtime events; profile, identity, journal, and skill learning remain one shared application-level system.
- V2 does not run the Classic conversation-title rewriter and does not add a capsule-writing LLM. Goal titles and rich, materiality-gated capsule snapshots are derived deterministically from authoritative V2 state; capsule versions carry the objective, latest request/outcome, constraints, open loops, next actions, and evidence anchors needed to resume safely. The Goal Router has its own `goal_router` worker model and thinking selection and invokes the V2 routing schema through the shared structured-agent runner.
- The explicit V1/V2 bridge is the only intentional Flow-to-Classic conversation write: each V2 focus owns at most one bridge conversation/session, visible completed V2 Q&A is mirrored idempotently, and ownership flips through **Open in Classic** / **Continue in Flow View**. Bridge rows and message links are V2-owned, do not duplicate tools/evidence/usage, and do not migrate unrelated existing Classic chats.
- Goal lifecycle is `foreground`, `parked`, `blocked`, `completed`, or `archived`. The UI exposes switch, pause, finish, reopen, archive, pin, and unpin; only the active work focus may be completed by Socrates through `focus_ledger`, completion commits after the substantive final answer is saved, General Conversation cannot be completed/archived, and unpinned parked work auto-archives after seven inactive days.

The V2 north star is one persistent visible Flow per project. A bounded Goal Router selects one foreground goal, parks other goals as versioned capsules, and assembles a pruned goal-aware working context. Raw PDF pages, tool results, Terminal output, files, messages, and other evidence remain immutable and retrievable even when their expensive copies are removed from the next LLM request.

V2 context items use four dispositions: `keep_exact`, `distill`, `release`, and `unresolved`. The implemented first cut runs a bounded post-turn Context Distiller using the configured Socrates Context Compactor worker selection, then applies deterministic policy for safety, pressure targets, timeouts, and unresolved limits. The initial guardrail is at most five active unresolved items per foreground goal and mandatory review within three subsequent Socrates turns. These are explicit evaluation defaults, not a reason to weaken the never-delete-evidence rule.

Speech shares one replaceable transcription foundation without sharing orchestration. Classic uses the existing composer plus a push-to-talk mic and the temporary conversation endpoint `/api/projects/:projectId/conversations/:conversationId/speech/transcribe`; its current UI defaults to local Whisper `small.en`, appends the result to the draft, never auto-sends, and records no V2 artifact/job/Flow state. V2 Voice V1 sends finalized transcripts through the Goal Router and additionally exposes local Whisper `base.en`/`small.en` or OpenRouter restricted to `nvidia/parakeet-tdt-0.6b-v3`, `microsoft/mai-transcribe-1.5`, and `mistralai/voxtral-mini-transcribe`. Local STT uses exact-pinned `@fugood/whisper.node@1.0.22` by default, with an explicit `whisper-cli` override/recovery path. Granite Speech is not included. A local transcription failure never uploads audio without explicit user selection of the hosted route.

V2 Voice V1 read-aloud is one-off, fully local Kokoro-82M TTS through exact-pinned `sherpa-onnx-node@1.13.4`, with a compatible CLI fallback; it does not require OpenRouter TTS or full-duplex realtime voice. Speech runtimes ship in the packaged server dependency set while Whisper/Kokoro model packs are installed only by an explicit user action with byte and checksum verification. The observed cold start for native Whisper on the tested M3 Mac was roughly 19-20 seconds because of first model/Metal initialization; this is a platform-specific measurement, not a universal latency promise. Ollama remains a supported local chat/embedding option whose quality depends on the user's model and hardware; it is not the V2 STT or TTS runtime.

The implemented V2 browser surface keeps the Classic welcome/projects/dashboard as the only directory and enters a project through **Go to Flow View**. Classic and V2 reuse the same `WorkspaceTopbar`, `ProjectChatSidebar`, `ChatComposer`, `ChatTranscript`, tool/approval rows, and Terminal dock rather than maintaining parallel chat components. The Flow sidebar remains an overlay drawer: it shows project links plus a query outline for the persistent Flow, lets the user deliberately inspect an older exchange or return to the current one, and never pushes or resizes the Flow canvas or composer. The center is a single focus canvas that renders only the selected/current user-and-Socrates exchange; long user requests collapse behind **Show more**, while older loaded history remains reachable from the query outline. The living sphere is one faint background layer during settled reading and becomes prominent only while Socrates is listening, routing, thinking, working, or awaiting input. Two single movable notes expose Live Context and the backend-authoritative Current Focus/Task; neither the query label nor frontend heuristics may substitute for the active goal. Each note moves only from its circular paperclip handle, supports keyboard nudging, clamps responsively, and persists a per-project position. Selecting a note opens the larger Context/Focuses/Activity inspector, which can itself be pinned or dismissed. The V2 composer is the exact Classic composer with the same attachments, image paste/drag-drop, ZIP skill import, model/thinking menus, and 10,000-character large-paste rule; the shared mic is present in both modes.

The focused 2026-07-21 Flow UI pass verified the current-exchange canvas at desktop, 820px, and 390px widths; long-query expand/collapse; query-outline navigation; movable-note input; concise exchange deletion; and an isolated Flow -> Classic -> Flow browser round trip. The disposable browser database contained three natural-language exchanges and was separate from the user's normal `SOCRATES_HOME`. Targeted Flow-store and transcript-window regression tests passed 19/19, web typecheck and the Next production build passed, changed-file lint had no errors, and the browser console was clean. The bridge and deletion stores remain authoritative: deleting a Flow exchange removes its exact linked Classic projection, while Classic `classic_only` versus `everywhere` deletion preserves the explicit user choice.

V2 Flow turns now participate in the same canonical retrieval foundation without fake Classic rows. Completed, failed, and cancelled V2 user/assistant turns are indexed as role-separated Q&A parents in the project LanceDB corpus with `runtimeKind = "v2_flow"` and exact `flowId` filtering, so Flow `trace_retrieve` lexical, semantic, and combined search use the shared ranking/index lifecycle. Queryless recall, exact inspect, and audit resolve through V2-owned raw records and immutable evidence, including tool, Terminal, file/patch, and error material. A durable Terminal continuation's canonical/global exact trace inherits the root user request instead of presenting an orphaned continuation. Exact immutable evidence retrieval by V2 id/handle remains available independently of the semantic index.

Latest V2 runtime validation on 2026-07-17: the whole workspace test run passed, including 200/200 server tests, 89/89 core tests, 32/32 contracts tests, 104/104 workspace tests, 93 provider tests with one deliberate skip, 14/14 MCP tests, and 9/9 CLI tests. Whole-workspace typecheck, server and Next production builds, four focused web V2 API tests, the normal packaged server/web runtime build, and native Whisper/Kokoro binding smoke passed. A disposable real-browser E2E used OpenRouter DeepSeek V4 Pro with thinking off as Socrates and approved OpenRouter Grok 4.5 with low reasoning as Frontier; it proved General Conversation, structured focus resume/continue routing, exact workspace evidence, staged completion with a substantive final, immutable/pruned context counters, approved vision handoff, and the two-way one-focus/one-Classic-conversation bridge. Persisted V2 usage for that run was `$0.196472`, below the `$0.80` ceiling. On 2026-07-18, focused server/contract/web typechecks, server and Next production builds, the Classic temporary-STT route test, visible Classic mic/Flow-view browser checks, responsive V2 layout checks, and the critical drag/overlay interaction passed: opening the 320px project drawer left both the composer and a note at the same viewport coordinates while the drawer covered the note. This is accelerated release evidence, not a measured 24-hour unattended soak; the large `small.en` and Kokoro packs were not downloaded during the browser pass.

One backend may run V1 or V2 work for different projects concurrently, but every active turn/task is a separate provider/LLM call with its own project, Flow/conversation, workspace, Terminal, and evidence scope. Multiple tasks must never be combined into one Socrates prompt merely because they share a backend process.

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
- `skills` lists/describes enabled builtin, global, and project skills, reads exact supporting files, and can preview then approval-install one Agent Skill ZIP from an exact user-supplied public HTTPS URL or current-turn ZIP attachment into project or global scope. Preview is automatic and bounded; `commit_import` is approval-required and atomic. This is installation, not web search, and Terminal must not bypass it.
- `mcp_registry` lists, describes, checks, configures, and deletes MCP servers. Read operations remain automatic; project/global configure and delete require explicit user approval. `describe` or a successful `check` exposes one server's dynamic `mcp__...` tools for the same turn.
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
- Main chat has a production `MemoryRouterAgent` around normal model calls. The pre-turn router is strictly read-only and returns at most eight exact `readTargets`; it cannot return or execute writes. Every user request immediately creates one durable `agent_task`, and automatic Terminal wake/resume turns remain in that task through `agent_task_turns`. At the first proposed final answer, the runtime builds a bounded overview from structured DB evidence and durable task-scoped `evd_` references, then invokes the final router. The router may return at most five `upsert`/`replace`/`remove`/`archive`/`condense` plans for user-maintained project notes, project memory, or repo docs; backend-owned `runtime_context` and `state_ledger` are excluded. Socrates reads, applies, and re-reads every successful target; final output is blocked until verification. Capability entries may carry `capability`, `verified_runtime`, and `verified_at` anchors. Structured router output gets one bounded validation-feedback repair attempt. If either router phase still fails, the ordinary task continues, the failure is persisted in `errors`, every usage item already observed is recorded as failed `ai_usage_events` with phase/error linkage, and Socrates is explicitly forbidden from claiming that routed recall or reconciliation succeeded. There is no pending-reconciliation queue. The router model is configured through the Memory Router worker setting.
- Always-apply recall stays simple and curated through one centralized always-apply rules list with two lanes. `user_profile.md` has a capped, human-readable `Global Always-Apply Rules` section and workspace project memory has a capped `Project Always-Apply Rules` section; each holds at most 10 rules. The backend loads these plus the three bounded identity sections into one per-project stable-prelude snapshot instead of emitting five model-visible tool calls every turn. A stat fast path reuses the snapshot; changed files are content-hashed, same-content rewrites and unrelated-section edits retain the cache, and only a changed standing-section hash rebuilds it. Router targets that duplicate standing sections and exact repeated dynamic targets are hard-deduplicated. The snapshot renders once in `<socrates_stable_cache_prelude>` before conversation/user text; only truly dynamic router reads remain visible tool activity. Fuller repo doctrine still belongs in `.socrates/repo_docs/*`; a short always-apply project rule may point Socrates to the relevant repo-doc contract when needed.
- Socrates now has explicit CodeAct-style capability-composition guidance in `packages/core/src/prompts/socratesPrompt.ts`: use structured tools first, discover MCPs when appropriate, then use Terminal/code for bounded one-off scripts when no exact tool exists. Terminal remains approval/policy gated for installs, broad network work, large downloads, and risky mutations.
- First-turn project recall is mandatory for light greetings, "continue", "where were we", and broad project-status openers: Socrates must read `project_docs` notes `active_context` before answering so active project loops can surface naturally.
- The Socrates prompt envelope stays cache-friendly: stable system instructions first, then the stable always-apply prelude, then conversation/user text, and only then dynamic routed context, tool results, docs checkpoints, and ledgers. No changing current date/time, workspace scan block, skill/MCP counts, or hidden matched skill/MCP ids belong in the system prompt.
- Extension discovery is tool-driven, not prompt-matched. Socrates should call `skills({ operation: "list" })` or `mcp_registry({ operation: "list" })`, then use `describe` with an exact listed canonical id/name. The runtime must not grep the user's prompt for skill or MCP names and inject hidden matches.
- Current date/time comes from the `current_time` tool. `project_docs` and `repo_docs` outputs also include `runtime.currentDate`, `runtime.currentDateTime`, `runtime.timeZone`, and `runtime.source: "system"` so docs workflows have an authoritative date source after reads.
- `.socrates/PROJECT_NOTES.md` contains project-scoped active state. The `active_context` section is for open loops, current project-local recall, and things Socrates should remember when this workspace is reopened. Backend-owned `runtime_context` and `state_ledger` sections are protected from `project_docs` edits. Runtime context refreshes lazily with compact workspace scan facts and intentionally excludes terminal output, live terminal state, dependency dumps, package lists, and root-script inventories. The state ledger is rewritten from structured turn data on completion/failure/cancellation, removes duplicate legacy ledger blocks, and remains one bounded current snapshot rather than agent-authored history.
- Project docs, repo docs, global tool docs, identity, and user profile updates get backend-owned frontmatter stamps (`updated_at`, `updated_by`, `last_edited_section`) after successful dedicated-tool edits. Model-written prose should not invent "today" when these system stamps are enough.
- Generic `edit` and `apply_patch` writes to `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/*.md`, and `.socrates/skills/**` are rejected; use dedicated docs tools or the approved Skill Writer Agent path.
- Before any `bash`, `edit`, or `apply_patch` can run, Socrates must have read/searched `project_docs` with `area: "notes"` and read/searched `repo_docs` in the same turn. Missing preflight returns recoverable `docs_preflight_required`.
- After any successful `bash`, `edit`, or `apply_patch`, Socrates must read/search `project_docs` with `area: "memory"` before final answer. Memory edits remain optional; the runtime requires review, then Socrates decides whether a durable update is useful.
- Terminal commands are preflight-rejected when they mention Socrates-owned protected paths: workspace `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/**`, `.socrates/skills/**`, and global `~/.Socrates/skills/**`, `~/.Socrates/tool_usage/**`, `identity.md`, or `user_profile.md`. This is an obvious-path guard, not a process sandbox.
- Terminal long-run foundation is now event-driven and task-aware: `bash` adds bounded `list` (maximum 12 rows), every raw foreground `run` detaches after the configured 15-second foreground window without restart, and healthy Terminals referenced by a task no longer use the fixed two-hour kill timer. The separate `wait` tool accepts named Terminals plus `completed`/`failed`/`input_required`, persists `agent_tasks` plus `agent_task_waits`, ends the current model execution without a false final response, and resumes the same task through a fresh normal agent invocation only on a requested event. Continuation context includes bounded authoritative evidence for the entire task so a fresh model invocation does not recreate work that already stopped, exited, completed, or failed before the wake. `wait.reason` is required and limited to seven words and 64 characters; it has no model polling interval. Model-facing Terminal output is capped at 16,000 characters, list text at 12,000, current Terminal context at 10,000, and wake output at 8,000.
- Interactive Terminal is now a verified end-to-end contract, not only a PTY primitive. User-interactive requests use a named `start` session with portable Node.js/Python stdin instead of shell-specific `read -p`; when a prompt is visible, required project-memory review and the completed/failed wait are registered deterministically so provider noncompliance cannot strand the turn. Quick foreground commands retain output captured during initial exit rather than double-consuming the model cursor. Current runtime Terminal capabilities override stale project memory that claims interaction is unavailable. The UI renders a resumed suspended phase as `Continued after Terminal completed`. Real DeepSeek V4 Pro, thinking-off browser verification passed two separate inputs (`green`, then `green parrot`), dependent Q2 construction, clean exit, automatic resume, and final answer.
- Terminal UI lifecycle state is versioned and race-safe. `terminal_sessions.state_version` increments only on real lifecycle changes; stdin commits `running` before PTY delivery, prompt timers are tied to the exact input/output generation, unchanged supervisor polls do not emit duplicate status events, and the frontend rejects older WebSocket or hydration snapshots. The real DeepSeek V4 Pro thinking-off two-input test verified that the dependent second prompt remained visibly `awaiting input` before accepting the second answer and exiting cleanly.
- Main-server lifetime is now separate from active Terminal lifetime. Terminal creation is persisted as `starting` before the host launch and committed to `running` only after supervisor ownership and process metadata exist. Normal server close first rejects new Terminal work, aborts and drains active turns, waits for in-flight starts, and then leaves only fully committed supervisor-owned Terminals running; an interrupted start is physically stopped and persisted as `stopped`, while a live persisted `starting` row is recovered on startup or marked `missing` if its host is absent. Supervisors are scoped per Socrates home, serialize shutdown behind in-flight starts, remove unreachable host endpoints from ownership, and self-expire when genuinely idle. Explicit stop, conversation deletion, and workspace switching physically terminate affected hosts; if both normal and targeted stop fail, persistence records `detached` plus the error instead of falsely claiming `stopped`. Ordinary request failures use bounded reconnect attempts and never kill/replace a potentially healthy supervisor; live polling requires three consecutive failures before marking a Terminal `missing`. Startup records `reconnected`, `incomplete_start_recovered`, `incomplete_start_missing`, `process_missing`, or `supervisor_unavailable`; an uncontrollable Terminal wakes its waiting task as `failed` instead of stranding it. A waiting task whose continuation turn was cancelled by interruption is requeued from `running` to `ready` during startup, while an already completed/failed continuation finalizes the task instead of duplicating it; the atomic `ready` to `running` claim still allows only one new attempt. Transparent survival of a supervisor-process crash remains a later reliability pass.
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
- Model identity includes both provider and auth mode. `authMode = "api_key"` covers OpenRouter, OpenAI API, Google API keys, direct DeepSeek API keys, and local Ollama chat models; `authMode = "chatgpt_subscription"` covers the experimental ChatGPT Codex OAuth path for OpenAI subscription models. The ChatGPT Codex subscription catalog lists verified `gpt-5.6-terra` (Medium default thinking, replacing the subscription `gpt-5.4` row), alongside `gpt-5.5`, `gpt-5.4-mini`, and text-only `gpt-5.3-codex-spark`; `gpt-5.6-luna` stays absent because the live Socrates OAuth route returned `Model not found` even though the same account can use it in official Codex. `/api/models` is credential-aware and returns only models whose provider/auth mode is configured, plus chat-capable models discovered from a reachable local Ollama runtime. Ollama discovery is read-only and never pulls or installs models. If OpenRouter is configured, OpenRouter DeepSeek V4 Pro remains the default available chat model unless another provider/auth setting is selected. OpenRouter also declares vision-capable `x-ai/grok-4.5` (mandatory Low/Medium/High reasoning, 500k context), text-only `tencent/hy3` and `z-ai/glm-5.2`; HY3 uses Off/Low/High, while GLM 5.2 uses High/Extra High. Direct DeepSeek API exposes official `deepseek-v4-pro` and `deepseek-v4-flash` rows through the same catalog and worker settings when `DEEPSEEK_API_KEY` is configured. If ChatGPT Codex is connected, the main composer prefers ChatGPT Codex models for new/effective chat selection while API-key models remain selectable.
- OpenAI now has two separate credential statuses: `OpenAI API` and `ChatGPT Codex`. The ChatGPT Codex flow uses PKCE OAuth against `auth.openai.com`, stores Socrates-owned token metadata under local credential storage, refreshes access tokens on demand, and routes subscription requests through the Codex backend auth shim. OpenAI embeddings remain API-key only.
- Project semantic search supports hosted OpenAI embeddings and local Ollama embeddings. The Ollama setup path remains read-only and never installs or pulls models. Provider/model/dimension changes create a clean LanceDB table for the new embedding fingerprint; the previous table is removed only after the replacement is ready, interrupted jobs are marked failed on restart, and SQLite remains authoritative.
- Global memory-agent settings live behind `/api/memory-agent` and are surfaced on the Settings page. Defaults are OpenRouter `xiaomi/mimo-v2.5-pro`, thinking off, enabled, cadence 10 minutes, but credential-aware resolution prefers ChatGPT Codex `gpt-5.5` with low reasoning when ChatGPT Codex is connected and the saved setting is still the built-in default or unavailable. Explicit Ollama selections are preserved when the discovered local model remains available.
- Worker model settings live behind `/api/worker-model-settings` and are surfaced on the Settings page for seven independent roles: Skill Writer, Socrates Context Compactor, Memory Context Compactor, Title Generator, Goal Router, Memory Router, and Frontier. Together with the separately configured Global Memory Agent and main Socrates model, the product exposes nine independent model selections. Settings persist provider, auth mode, model, and thinking choice. Frontier defaults to OpenRouter `x-ai/grok-4.5` with low reasoning because OpenRouter marks Grok 4.5 reasoning as mandatory and rejects disabled/none requests; its valid options are Low, Medium, and High. Saved thinking selections that a model no longer supports resolve to that model's supported default instead of sending an invalid provider request. The main Socrates model is the primary worker and may request `handover_to_frontier({ focus? })` only after real substantive effort reaches a concrete unresolved capability/reliability blocker. Every request requires explicit typed user approval even in approve-all/full-access mode and uses polished `Call Frontier model` UI copy. Approval transfers the complete current task and tool history to Frontier for the remainder of that turn, discards provisional driver answer text, and persists the normal tool call plus `agent.model.handover`. Rejection persists the rejected approval/tool call, blocks another request for the turn, and instructs Socrates to continue and complete the work itself. The next user-authored turn starts on the selected main model again. There is no consult mode, reason field, return handoff, or multi-agent dialogue. Other defaults preserve the current working models, while credential-aware resolution may prefer ChatGPT Codex role defaults when connected. Explicit Ollama selections resolve through the same refreshed model catalog and use Ollama's Off/On thinking toggle.
- Memory Router provider usage is recorded as `ai_usage_events.source_kind = "memory_router"` and rolled into the existing turn/conversation cost total. Do not add a separate visible router-cost widget unless the product direction changes.
- Persisted chat replay must keep every historical tool run visible even when a pre-model context read has no `modelCallId`. The frontend groups those unclaimed reads into a quiet `Intent understood` / `Understanding your intent` disclosure, while model-owned calls retain the normal reasoning-and-tool chronology; hydration must never replace a complete turn-level trace with model steps that omit those calls.
- Socrates' visible voice should be warm, direct, and human. Internal evidence such as tool names, ids, hashes, model names, backend state, empty active-context wording, and commit SHAs should be translated into plain language unless the user asks for exact diagnostics.
- Completed chat turns are indexed for trace retrieval, but they no longer enqueue a per-turn memory job. The scheduler or manual settings-page action wakes the global agent.
- Legacy per-project memory-agent settings remain only as inactive DB/store compatibility baggage; the per-turn worker runtime path has been removed.
- Project skill creation remains user-triggered from the dashboard `Skills +` flow, and global skill creation/deletion remains user-triggered from Memory Center. These flows should route approved skill creation/update work through the Skill Writer Agent instead of a one-off provider stream.
- `Skills +` also supports standards-compatible pre-made Agent Skill ZIP import without invoking the Skill Writer. Import is a staged preview/confirm flow for global or project scope: one top-level directory matching YAML `name`, required `SKILL.md`, at most 30 MB extracted and 200 files, traversal/symlink/encryption/ZIP-bomb guards, bounded security warnings, no execution during import, explicit same-scope replacement, and atomic install with rollback. Imported provenance and enabled state live in `.socrates-skill.json`; disabled skills remain visible to management UI but are excluded from model discovery. External `allowed-tools` never bypasses Socrates approvals.
- Memory Agent skill suggestions should be user-visible notifications first: "Socrates proposed this skill/update" with a concise summary. Default behavior is manual approval per skill; a later setting may allow auto-approval. Once approved, the Skill Writer Agent should always do the create/update unless validation or write tooling fails.
- Routine memory notifications should behave as a quiet activity log, not a raw diff stream or attention-grabbing alert. They should show clean formatted summaries of what changed, which primary docs were touched, how many memory notes were created/processed, and how many ended as `applied`, `already_represented`, `skipped`, or `proposed_skill`. Pending skill proposals are the main notification type that should be visually action-needed because the user must approve or reject them.
- The Skill Writer Agent needs a narrow tool belt: read approved request context, `trace_retrieve`, full `skills` list/describe/read for existing skill content, read-only `user_profile`, read-only `soul`, read-only project/repo docs for project skills, and a scoped `skill_write` tool for final `SKILL.md` creation/update. It must not get shell, arbitrary filesystem reads/writes, project docs writes, repo docs writes, identity/profile writes, or raw path mutation tools.
- Global MCP servers are available to all projects; project MCP servers are workspace-local and inherit global servers. Playwright MCP is bundled and protected from deletion. MCP setup accepts common JSON (`mcpServers`/`servers`) and Codex TOML (`mcp_servers`) plus manual stdio configuration, saves new servers disabled, performs a real handshake/tool-discovery check, and enables only on success. Model-facing chat configure declares only `secretBindings` key names and source; plaintext credentials never enter model tool calls, approval previews, events, or persisted tool arguments/results. The frontend collects one masked credential at a time through typed `credential.input.*` WebSocket events, the backend keeps it only in the active waiter/runtime call, and multi-server/multi-key mutation calls serialize naturally. Exact workspace-env reuse is backend-only and allowed only when the user explicitly requested that source; otherwise the UI asks for input. Generic read/search/Terminal access blocks real env/private-key material while safe templates remain readable. Secret values live in the scope's private `.env`; `mcp.json` stores only secret key names and config GETs return blank values for existing keys. Health/tool counts persist across refreshes, project checks run in the project cwd, existing servers can be edited, and the UI exposes copy/open controls for both config files. The neutral backend `unknown` health state means no persisted check result yet and is intentionally not rendered as a badge; the UI shows only actionable `available`, `failed`, or `missing` status badges while retaining any known tool count. Socrates chat may configure/check/delete project or global servers only through approval-backed `mcp_registry` operations.
- Memory Center (`/memory`) is the global memory-agent control surface. It uses a fixed `h-screen` shell: header and footer stay anchored, the middle region scrolls, and desktop splits the main content scroller from the Memory Files rail scroller. Core Memory renders only Identity and User Profile.
- Primary identity/profile migrations never keep a generic legacy block. They route old headings into the canonical sections, drop old scaffolding lines, and compact obvious duplicate migrated bullets.
- Skill writing now routes through the production Skill Writer Agent path with a dedicated prompt, shared Socrates agent runner, scoped tool registry, and `skill_write` validation/write tool.
- Always apply this creation invariant: every new model-driven agent, router, or worker must use a designated prompt module, the shared runner, an explicitly scoped tool registry/executor mapping, strict Zod contracts, bounded structured-output repair/fallback, dedicated model/thinking settings when independently configurable, typed telemetry/persistence, and focused tests. One-off provider calls, inline production prompts, and borrowing an unrelated worker role are prohibited shortcuts; existing violations must be corrected and never copied.
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
- Older head context is compacted through `CompressorAgent` and `StructuredToolAgentRunner`, never a direct provider call or streamed prompted JSON.
- Chat and memory compaction schemas live in `packages/contracts/src/contextCompression.ts`; chat uses `chatCompactionSchema`, and memory-agent context uses `memoryCompactionSchema`.
- Compressor prompts live in `packages/core/src/prompts/socratesCompressorPrompt.ts` and `memoryAgentCompressorPrompt.ts`; the backend memory-agent runner must pass `contextCompression: { enabled: true, mode: "memory" }`.
- Strict Zod validation happens before snapshot activation. Invalid new-schema output never becomes active memory; legacy invalid snapshots are ignored rather than migrated.
- Anchors must start with `Turn <number>:` and may reference only turns actually present in compressor input. If only anchors fail, the compressor repairs anchors through the structured anchor repair schema. Bounded high-value source artifacts are carried forward deterministically even when a model omits them: exact `.socrates/attachments/...` paths enter `relevantFiles`, exact shell commands enter `toolState`, and explicit unresolved/do-not-complete user instructions enter `blocked`.
- An active snapshot is applied before token counting and provider dispatch: its hidden summary is prepended once, raw turns represented by its source handles are omitted from the model request, and the authoritative raw rows remain in SQLite for trace/audit retrieval.
- The server chooses Classic/Flow compression and V2 Context Distiller calls through the independent Socrates Context Compactor setting; Global Memory Agent and Skill Writer compression use the independent Memory Context Compactor setting. Migration `0028_split_context_compactors.sql` copies the prior shared `context_compactor` choice into both roles before removing the legacy row. Both built-in defaults are OpenRouter `deepseek/deepseek-v4-flash` with thinking off. When ChatGPT Codex is connected and a saved compactor setting is the built-in default or unavailable, its effective model is ChatGPT Codex `gpt-5.4-mini` with low reasoning. Hard-coded OpenRouter fallbacks must not run when OpenRouter is unavailable.
- Classic conversation titles are generated by the no-tool `TitleGeneratorAgent` through `StructuredToolAgentRunner`, the prompt in `packages/core/src/prompts/titleGeneratorPrompt.ts`, an explicit empty registry/executor mapping, and `conversationTitleAgentOutputSchema`. The server adapter only loads bounded image content, invokes the agent, sanitizes the validated title, and persists usage/title effects.

## Stable Socrates Surfaces And Chat Sources

- `packages/contracts/src/socratesSurfaces.ts` is the code-owned registry for the nine durable global/project Socrates surfaces. It drives path guards, storage paths, and the compact generated model-facing surface map; markdown does not duplicate that routing truth.
- Main model assembly keeps a byte-stable prefix: base prompt, compact identity core, global always-apply rules, project always-apply rules, then the generated surface map. User/project metadata, routed memory, runtime facts, tool results, and ledgers follow as dynamic context.
- Inline chat text is capped at 10,000 characters. A larger paste is uploaded as a `text/plain` source under `.socrates/attachments/` and the model receives only a compact provenance manifest until it reads/searches the file.
- One message may reference at most 15 image/text attachments, with 5 MB per attachment and 20 MB combined. Text bytes are never silently injected into every model request; image bytes are sent only to vision-capable models.

## Release State

- Current GitHub runtime release is `v0.1.19`, published non-draft and non-prerelease with the three runtime archives plus `SHA256SUMS`. The npm launcher source is prepared as `@socrates-ai/cli@0.1.19` for the user's security-key-authenticated publish. Until that manual npm step completes, the public registry continues to serve `0.1.18`; that existing launcher still resolves the newest GitHub runtime by default.
- `v0.1.19` preserves the `v0.1.18` provider, retrieval, model-catalog, memory-opt-out, MCP credential, standing-context, and runtime-packaging foundation. It adds bounded Memory Router failure telemetry, explicit one-way Frontier handover, hardened Terminal supervisor lifecycle cleanup, and the isolated V2 Seamless Flow first product cut: one project Flow, bounded Goal Router, 29 namespaced tables, self-pruning context backed by immutable evidence, V2 trace retrieval, focus lifecycle/Classic bridge, the shared Classic/Flow shell and composer, draggable Flow notes/inspector, Classic draft-only speech transcription, and V2 local/OpenRouter transcription plus local Kokoro read-aloud. Runtime packaging now removes the deployed server's self-link back to the checkout, recursively strips environment files, rejects server links outside the runtime root, and fails archive validation if any `.env*` entry remains. The packaged launcher enables Flow by default with an explicit rollback flag. All three supported runtime archives passed their native release builders and smoke checks. The evidence is still accelerated rather than a measured 24-hour unattended soak; large speech-pack runs, accessibility automation, and extended soak evidence remain release follow-ups.
- Release tooling remains pinned to the proven `pnpm@9.15.1` path for GitHub runtime builds. The active workflows use the current Node-24-based Action majors (`actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6`, `actions/upload-artifact@v7`, and `actions/download-artifact@v8`). The runtime release workflow recreates the tag release and uploads each runtime asset explicitly (`darwin-arm64`, `darwin-x64`, `win32-x64`, then `SHA256SUMS`) so a stale partial draft cannot be reused. The produced runtime archive still bundles Node v20.20.2. The ARM builder uses `macos-15` because exact-pinned Whisper 1.0.22 targets macOS 15 or newer.
- Shell Tooling pins its Windows leg to `windows-2022`; `windows-latest` moved to Windows Server 2025 / VS 2026, where `node-gyp` cannot identify Visual Studio 18 while building native dependencies such as `better-sqlite3`. Windows still runs install/typecheck plus contracts/workspace/core tests, while the server PTY/WebSocket test suite runs on Ubuntu only because it assumes POSIX bash/PTY behavior.
- `user_profile.evidence_index` should now store compact source anchors for important profile claims, including date, project/conversation title or id, turn/message/event id when available, the supported claim, and the profile section using that claim.
- Product stabilization commit `2756e97 Stabilize extension discovery context` is pushed to `origin/main`. It removes per-turn wake context from main chat, moves stable recall/extension routing into the base prompt, and keeps skills/MCPs behind on-demand `list`/`describe` tools.
- Credential-aware model routing and experimental ChatGPT Codex auth commit `6a29dad Add ChatGPT Codex auth model routing` is pushed to `origin/main`. It adds auth-mode-aware model settings, filtered `/api/models`, ChatGPT Codex OAuth/token refresh, Codex request routing, UI credential status, Codex-preferred defaults for chat/workers/memory-agent, and compressor regression coverage for active context, anchors, and full structured fields.
- Ollama embedding setup commit `21d9fc9 Add Ollama embedding setup` is pushed to `origin/main`. It adds Ollama model discovery/recommendations, offline setup guidance without automatic pulls, project embedding configuration for Ollama, active-index-only cleanup for `trace_embeddings`, in-flight stale job guards, and updated context files/contracts/tests.
- Memory-front hardening commit `df82d0b feat: harden Socrates memory front` is pushed to `origin/main`. It adds the code-owned nine-surface registry, byte-stable identity/rules/surface prelude, large-paste text attachments and bounded image/text submissions, hardened snapshot reuse and compaction gates, HY3/GLM catalog updates, and the reproducible `evals/memory-harness/` baseline/report/runner. The subsequent catalog correction replaces ChatGPT Codex `gpt-5.4` with verified `gpt-5.6-terra`, removes the broken Luna row, and adds OpenRouter Grok 4.5.
- Terminal lifecycle, Memory Router telemetry, and Frontier handover hardening commit `60a7d4e feat: harden memory routing and frontier handover` is pushed to `origin/main`. It keeps router failures bounded and non-blocking while persisting failure/usage evidence, adds one-way same-turn Frontier transfer with complete task context, and requires explicit approval for every transfer. A rejection persists the rejected action, removes the handover tool for the rest of that turn, and returns control to the main Socrates model.
- Context compaction now uses a single-pass soft sizing policy: 60k or less is `excellent`, 80k or less is `preferred`, 80-120k is `acceptable`, and results above 120k are rejected while the 170k trigger and 180k hard provider ceiling remain unchanged. Recent whole-turn history is dynamically fitted into the remaining 80k budget after fixed prompt/tool context, the active turn, and the maximum summary allowance are reserved; this does not add a second compressor call.

## Next Major Work

- Continue V2 release validation without widening its scope: formal accessibility automation, accelerated concurrency/restart stress, real `small.en`/Kokoro pack runs, and a measured extended soak. Supported-target v0.1.19 release archives are complete, but do not describe the current implementation as proven for 24-hour unattended operation until that soak has actually run.
- Finish release-level validation of V2 retrieval rebuild/upsert/delete behavior, exact continuation-turn inspection, and Global Memory Agent recall across restarts; keep the shared `runtimeKind = "v2_flow"` corpus isolated from Classic conversation rows.
- Keep strengthening Socrates' investigation harness based on real Gemini/GPT/OpenRouter runs, especially around overbroad mutations and respecting user-scoped constraints.
- Extend the checked-in repeated-compaction harness with more corpora and provider runs; the first sanitized 36-turn golden dataset, five-round DeepSeek baseline, final 8/8 improved DeepSeek confirmation, two-round GLM run, downstream trace/attachment/project-memory/fresh-conversation checks, and cost ledger now live under `evals/memory-harness/` (private generated corpora/results stay gitignored).
- Consider a dedicated safety rule for files whose names clearly ask not to be opened, because the latest Gemini E2E still opened `please_do_not_open.md`.
- The completed 2026-07-10/11 skill-learning evaluation hardened evidence handoff, canonical skill ids, write validation/supporting files, no-op rejection, bounded Writer repair, cross-run structured Memory Agent journaling, backend-authoritative create/update classification, and main-agent discovery for ordered verification/closure workflows. The composed isolated official-DeepSeek E2E passed: an earlier full run proved behavioral pattern proposal -> approved Writer creation -> v1 held-out use, and a deterministic seeded continuation proved a cross-project handoff refinement -> update proposal -> Writer v2 -> actual main-agent `skills list` + `describe` -> 6/6 held-out behavior signals. Use Memory Pro/high plus Writer Flash/off as the experimental default, keep manual proposal approval, and do not claim production-scale reliability from one passing chain.

## Verification

Latest verified for the published v0.1.19 runtime release on 2026-07-18:

```text
pnpm typecheck
pnpm test
pnpm build
pnpm runtime:archive
  -> local darwin-arm64 archive passed bundled Node, SQLite, LanceDB, Whisper, Kokoro, archive-layout, and packaged-launch smoke checks
Shell Tooling run 29647193881
  -> current Action majors passed on ubuntu-latest and windows-2022
Release npm Runtime run 29647367894
  -> darwin-arm64, darwin-x64, win32-x64, and publish jobs all passed
gh release view v0.1.19
  -> published, non-draft, non-prerelease release with three runtime archives and SHA256SUMS
npm view @socrates-ai/cli dist-tags version --json
  -> public npm latest remains 0.1.18 pending the user's security-key-authenticated 0.1.19 publish
```

Latest verified for Terminal lifecycle hardening, bounded Memory Router failure telemetry, one-way Frontier handover, and explicit Frontier approval on 2026-07-17:

```text
pnpm typecheck
pnpm test
  -> CLI 9, contracts 24, MCP 14, providers 93 (+1 intentionally skipped), workspace 104, core 76, server 154; 474 passed total
pnpm --filter web build
  -> production frontend build passed
focused Frontier approval integration
  -> approval is required in every permission mode, including approve-all/full-access
  -> rejection is persisted, emits no handover/model-call event, removes the tool for the turn, and tells Socrates to continue
focused Memory Router failure integration
  -> one bounded repair, persisted error and failed usage telemetry, ordinary task continues without a false success claim
git diff --check
```

Latest verified for the isolated Memory Router gate evaluation and clean handoff on 2026-07-15:

```text
pnpm eval:memory-router-gate --dry-run
  -> 30 synthetic fixtures, balanced 15/15, 3 rounds, 90 planned attempts, OpenRouter DeepSeek V4 Flash, thinking off
pnpm --filter @socrates/server exec tsc --noEmit --skipLibCheck --module ESNext --moduleResolution Bundler --target ES2022 --types node scripts/run-memory-router-gate-eval.ts
pnpm --filter @socrates/server build
  -> normal server entries only; no Memory Router gate runner or classifier text in dist
pnpm typecheck
pnpm test
  -> CLI 9, contracts 24, MCP 14, providers 92 (+1 intentionally skipped), workspace 104, core 71, server 142; 456 passed total
gh release view v0.1.18 --json tagName,isDraft,isPrerelease,publishedAt,url
  -> published, non-draft, non-prerelease GitHub release
npm view @socrates-ai/cli version
  -> 0.1.18
git diff --check
tracked-change sensitive-data scan
```

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
registry/lock matrix -> @lancedb/lancedb 0.22.3 publishes darwin-arm64, darwin-x64, and win32-x64-msvc native packages; runtime-release.yml executes the same archive smoke natively on macos-15, macos-15-intel, and windows-2022; macOS 15+ is required by the exact-pinned Whisper 1.0.22 native addon
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
