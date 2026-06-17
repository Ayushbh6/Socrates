# Socrates Memory

Repo-local handoff memory for Socrates. Treat this file plus `repo_docs/` as the restart surface for future work.

## Current Direction

Socrates is being shaped into a lean, project-first coding agent with active recall and low prompt overhead.

The current architecture now uses:

- A compact base prompt operating kernel in `packages/core/src/prompts/socratesPrompt.ts`.
- Workspace-local project state under `<workspace>/.socrates/`.
- Global Socrates tool guidance and skills under `~/.Socrates/`.
- Exact old conversation/tool evidence through `trace_retrieve`.
- A read-only `user_profile` tool for durable cross-project user preferences.
- A first-class no-tool `CompressorAgent` with structured output schemas for chat and memory compaction.
- No production diary read/write/search/wake-context path.

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
  operating_principles.md
  user_profile.md
  tool_usage/
    trace_retrieve.md
    edit_apply_patch.md
    terminal.md
    read_search.md
    memory_docs.md
    memory_agent/
      trace_retrieve_global.md
      projects.md
      edit_files.md
  skills/
    <skill-name>/SKILL.md
```

## Model-Visible Tool Surface

Current base tools:

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

Removed from the model-visible surface:

```text
socrates_memory
project_notes
```

Tool routing:

- `trace_retrieve` is for prior conversation text and audit evidence: tool calls, shell output, file operations, patches, errors, decisions.
- `tool_docs` is read/search only for global tool usage guidance.
- `skills` lists/searches/reads visible builtin, global, and project skills. The main agent cannot write skills through this tool.
- `project_docs` reads/searches/edits workspace `.socrates/MEMORY.md` and `.socrates/PROJECT_NOTES.md`.
- `repo_docs` reads/searches/edits only the four repo doctrine docs.
- `soul` reads root `~/.Socrates/identity.md` and `~/.Socrates/operating_principles.md`; the main agent cannot write them.
- `user_profile` reads root `~/.Socrates/user_profile.md`; the main agent cannot write it.

## Runtime Notes

- First-turn wake context is stable pointer-only text. It does not paste the state ledger, project memory excerpts, repo-doc excerpts, timestamps, last-turn summaries, turn ids, or assistant previews. It points the agent to `project_docs(area: "notes")` for the active state ledger, `project_docs(area: "memory")` for durable memory, and `repo_docs` for repo doctrine.
- Generic `edit` and `apply_patch` writes to `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/*.md`, and `.socrates/skills/**` are rejected; use dedicated docs tools or the backend project skill builder.
- Before any `bash`, `edit`, or `apply_patch` can run, Socrates must have read/searched `project_docs` with `area: "notes"` and read/searched `repo_docs` in the same turn. Missing preflight returns recoverable `docs_preflight_required`.
- After any successful `bash`, `edit`, or `apply_patch`, Socrates must read/search `project_docs` with `area: "memory"` before final answer. Memory edits remain optional; the runtime requires review, then Socrates decides whether a durable update is useful.
- Terminal commands are preflight-rejected when they mention Socrates-owned protected paths: workspace `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/**`, `.socrates/skills/**`, and global `~/.Socrates/skills/**`, `~/.Socrates/tool_usage/**`, `identity.md`, or `operating_principles.md`. This is an obvious-path guard, not a process sandbox.
- The Global Memory Agent is a scheduled app-level specialized `SocratesAgent` run, not a per-turn project worker.
- The agent reads completed-turn event manifests after the durable `events.sequence` watermark and advances the watermark only after a successful run. Manifest packing now adds completed turns one by one and stops before either 80 turns or 60k estimated tokens.
- The agent tools are `trace_retrieve` with global search, `projects`, `tool_docs`, `skills`, `soul`, and scoped `edit_files`.
- Memory-agent `trace_retrieve` supports `all_projects`, `current_project`, `projectTitle`, `projectId`, `conversationTitle`, and `conversationId`; project/conversation selectors may be strings or lists.
- Memory-agent tool guidance is seeded under `~/.Socrates/tool_usage/memory_agent/` and is readable through the existing `tool_docs` tool.
- `edit_files` is the only write tool for the memory agent. It writes global `tool_usage`, global `skills`, and gated `identity.md` / `operating_principles.md` edits without exposing raw paths.
- Global memory-agent settings live behind `/api/memory-agent` and are surfaced on the Settings page. Defaults are OpenRouter `xiaomi/mimo-v2.5-pro`, thinking off, enabled, cadence 10 minutes.
- Completed chat turns are indexed for trace retrieval, but they no longer enqueue a per-turn memory job. The scheduler or manual settings-page action wakes the global agent.
- Legacy per-project memory-agent settings remain only as inactive DB/store compatibility baggage; the per-turn worker runtime path has been removed.
- Project skill creation is user-triggered from the dashboard `Skills +` flow and writes `.socrates/skills/<skill-name>/SKILL.md`.
- `socrates-skill-writer` is an internal backend builder asset, not exposed as a normal model-visible skill.
- Soul proposals still require internal confirmation and user-visible notification.
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

- Current release target is GitHub runtime release `v0.1.11` with macOS and Windows runtime bundles; npm launcher `@socrates-ai/cli@0.1.11` keeps direct GitHub Release asset lookup so public `npx` installs avoid unauthenticated GitHub API rate limits.

## Next Major Work

- Keep strengthening Socrates' investigation harness based on real Gemini/GPT/OpenRouter runs, especially around overbroad mutations and respecting user-scoped constraints.
- Add a repeated-compaction torture/eval suite covering 5-10 compactions with canaries for strict user rules, file paths, commands, failures, unresolved tasks, anchors, and exact quotes.
- Consider a dedicated safety rule for files whose names clearly ask not to be opened, because the latest Gemini E2E still opened `please_do_not_open.md`.

## Verification

Latest verified after the stable wake-context, hard notes+repo-doc action preflight, post-action memory review gate, and terminal drain serialization work:

```text
pnpm --filter @socrates/server test -- server.test.ts
pnpm --filter @socrates/core test -- SocratesAgent.test.ts
git diff --check
```

Live DeepSeek V4 Pro browser E2E on 2026-06-17 used OpenRouter `deepseek/deepseek-v4-pro` with thinking on in `Test-Workspace`. Requests had `NO_STATE_LEDGER`, `NO_LAST_TURN`, and `HAS_STABLE_WAKE`. The edit probe confirmed the enforced sequence: `project_docs(area:"notes")`, `repo_docs`, approved `edit`, then `project_docs(area:"memory")` before final. OpenRouter routed to StreamLake; the first two simple chat turns had zero cached input tokens, while same-turn tool continuations produced cache hits.

Run `git diff --check` and a tracked-file sensitive scan before publishing a release tag.
