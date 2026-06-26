# Socrates Memory

Repo-local handoff memory for Socrates. Treat this file plus `context-files/` as the maintainer restart surface for future work.

## Current Direction

Socrates is being shaped into a lean, project-first coding agent with active recall and low prompt overhead.

The current architecture now uses:

- A compact base prompt operating kernel in `packages/core/src/prompts/socratesPrompt.ts`.
- Workspace-local project state under `<workspace>/.socrates/`.
- Global Socrates tool guidance and skills under `~/.Socrates/`.
- Exact old conversation/tool evidence through `trace_retrieve`.
- A read-only `user_profile` tool for durable cross-project user preferences.
- A first-class no-tool `CompressorAgent` with structured output schemas for chat and memory compaction.
- No production diary read/write/search path and no per-turn main-chat wake-context injection.

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

Removed from the model-visible surface:

```text
socrates_memory
project_notes
```

Tool routing:

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
- `user_profile.evidence_index` is a source-anchor section, not a summary bucket. It should store compact traceable anchors for important profile claims: date, project/conversation title or id, turn/message/event id or trace handle when available, the claim supported, and the profile section using that claim.

## Runtime Notes

- Main chat no longer injects `<socrates_wake_context>` on the first turn or later turns. Stable recall routing now lives in `packages/core/src/prompts/socratesPrompt.ts`, pointing Socrates to `project_docs`, `repo_docs`, `user_profile`, `soul`, `skills`, and `mcp_registry` when the current task needs them.
- The Socrates system prompt stays cache-friendly: stable instructions first, with no changing current date/time, workspace scan block, skill/MCP counts, or hidden matched skill/MCP ids in the system prompt.
- Extension discovery is tool-driven, not prompt-matched. Socrates should call `skills({ operation: "list" })` or `mcp_registry({ operation: "list" })`, then use `describe` with an exact listed canonical id/name. The runtime must not grep the user's prompt for skill or MCP names and inject hidden matches.
- Current date/time comes from the `current_time` tool. `project_docs` and `repo_docs` outputs also include `runtime.currentDate`, `runtime.currentDateTime`, `runtime.timeZone`, and `runtime.source: "system"` so docs workflows have an authoritative date source after reads.
- `.socrates/PROJECT_NOTES.md` may contain a backend-owned `runtime_context` section with workspace scan facts such as detected Python environments and dependency files. It is protected from `project_docs` edits and intentionally does not persist terminal output or live terminal state.
- Project docs, repo docs, global tool docs, identity, and user profile updates get backend-owned frontmatter stamps (`updated_at`, `updated_by`, `last_edited_section`) after successful dedicated-tool edits. Model-written prose should not invent "today" when these system stamps are enough.
- Generic `edit` and `apply_patch` writes to `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/*.md`, and `.socrates/skills/**` are rejected; use dedicated docs tools or the backend project skill builder.
- Before any `bash`, `edit`, or `apply_patch` can run, Socrates must have read/searched `project_docs` with `area: "notes"` and read/searched `repo_docs` in the same turn. Missing preflight returns recoverable `docs_preflight_required`.
- After any successful `bash`, `edit`, or `apply_patch`, Socrates must read/search `project_docs` with `area: "memory"` before final answer. Memory edits remain optional; the runtime requires review, then Socrates decides whether a durable update is useful.
- Terminal commands are preflight-rejected when they mention Socrates-owned protected paths: workspace `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/**`, `.socrates/skills/**`, and global `~/.Socrates/skills/**`, `~/.Socrates/tool_usage/**`, `identity.md`, or `user_profile.md`. This is an obvious-path guard, not a process sandbox.
- The Global Memory Agent is a scheduled app-level specialized `SocratesAgent` run, not a per-turn project worker.
- The agent reads completed-turn event manifests after the durable `events.sequence` watermark and advances the watermark only after a successful run. Manifest packing now adds completed turns one by one and stops before either 80 turns or 60k estimated tokens.
- The agent tools are `current_time`, `trace_retrieve` with global search, `projects`, `tool_docs`, `skills`, `soul`, and scoped `edit_files`.
- Memory-agent `trace_retrieve` supports `all_projects`, `current_project`, `projectTitle`, `projectId`, `conversationTitle`, and `conversationId`; project/conversation selectors may be strings or lists.
- Memory-agent tool guidance is seeded under `~/.Socrates/tool_usage/memory_agent/` and is readable through the existing `tool_docs` tool.
- `edit_files` is the only write tool for the memory agent. Scheduled runs can write scoped `user_profile.md` and gated `identity.md` edits without exposing raw paths. Scheduled runs may read skills but cannot create or update them, and tool docs remain read-only for models.
- Section indexes persist in SQLite tables `memory_doc_indexes` and `memory_doc_sections`; these are rebuilt from markdown content during ensure/index operations and are lookup aids, not the source of truth.
- Global memory-agent settings live behind `/api/memory-agent` and are surfaced on the Settings page. Defaults are OpenRouter `xiaomi/mimo-v2.5-pro`, thinking off, enabled, cadence 10 minutes.
- Completed chat turns are indexed for trace retrieval, but they no longer enqueue a per-turn memory job. The scheduler or manual settings-page action wakes the global agent.
- Legacy per-project memory-agent settings remain only as inactive DB/store compatibility baggage; the per-turn worker runtime path has been removed.
- Project skill creation is user-triggered from the dashboard `Skills +` flow and writes `.socrates/skills/<skill-name>/SKILL.md`.
- Global skill creation/deletion is user-triggered from Memory Center and writes/removes `~/.Socrates/skills/<skill-name>/SKILL.md`; project skill creation/deletion is scoped to the active workspace. The `skills` tool discovers current disk state when called, so new skills are visible on the next tool call.
- Global MCP servers are available to all projects; project MCP servers are workspace-local and inherit global servers. Playwright MCP is bundled and protected from deletion. The model-facing `mcp_registry` path is `list`/`describe`; UI/API flows handle configure, check, enable/disable, and delete.
- Memory Center (`/memory`) is the global memory-agent control surface. It uses a fixed `h-screen` shell: header and footer stay anchored, the middle region scrolls, and desktop splits the main content scroller from the Memory Files rail scroller. Core Memory renders only Identity and User Profile.
- Primary identity/profile migrations never keep a generic legacy block. They route old headings into the canonical sections, drop old scaffolding lines, and compact obvious duplicate migrated bullets.
- `socrates-skill-writer` is an internal backend builder asset, not exposed as a normal model-visible skill.
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
- Default compressor model order is OpenRouter `deepseek/deepseek-v4-flash`, then `xiaomi/mimo-v2.5-pro`, then `z-ai/glm-5.2`.

## Release State

- Current release target is `v0.1.15`.
- `v0.1.15` preserves the Memory Center / identity-user-profile cleanup from `v0.1.13`, the duplicate-section startup recovery from `v0.1.14`, and adds memory-agent evidence-index guidance plus duplicate markdown-heading normalization for primary docs.
- `user_profile.evidence_index` should now store compact source anchors for important profile claims, including date, project/conversation title or id, turn/message/event id or trace handle when available, the supported claim, and the profile section using that claim.
- Product stabilization commit `2756e97 Stabilize extension discovery context` is pushed to `origin/main`. It removes per-turn wake context from main chat, moves stable recall/extension routing into the base prompt, and keeps skills/MCPs behind on-demand `list`/`describe` tools.

## Next Major Work

- Keep strengthening Socrates' investigation harness based on real Gemini/GPT/OpenRouter runs, especially around overbroad mutations and respecting user-scoped constraints.
- After `v0.1.15` is tagged and published, verify the GitHub latest runtime points at `v0.1.15` and npm latest reports `@socrates-ai/cli@0.1.15`.
- Add a repeated-compaction torture/eval suite covering 5-10 compactions with canaries for strict user rules, file paths, commands, failures, unresolved tasks, anchors, and exact quotes.
- Consider a dedicated safety rule for files whose names clearly ask not to be opened, because the latest Gemini E2E still opened `please_do_not_open.md`.

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

Live DeepSeek V4 Pro browser E2E on 2026-06-17 used OpenRouter `deepseek/deepseek-v4-pro` with thinking on in `Test-Workspace`. Requests had `NO_STATE_LEDGER`, `NO_LAST_TURN`, and `HAS_STABLE_WAKE`. That E2E predates the 2026-06-25 removal of main-chat wake-context injection. The edit probe confirmed the enforced sequence: `project_docs(area:"notes")`, `repo_docs`, approved `edit`, then `project_docs(area:"memory")` before final. OpenRouter routed to StreamLake; the first two simple chat turns had zero cached input tokens, while same-turn tool continuations produced cache hits.

Run `git diff --check` and a tracked-file sensitive scan before publishing a release tag.
