# Socrates Memory

Repo-local handoff memory for Socrates. Treat this file plus `repo_docs/` as the restart surface for future work.

## Current Direction

Socrates is being shaped into a lean, project-first coding agent with active recall and low prompt overhead.

The current architecture now uses:

- A compact base prompt operating kernel in `packages/core/src/prompts/socratesPrompt.ts`.
- Workspace-local project state under `<workspace>/.socrates/`.
- Global Socrates tool guidance and skills under `~/.Socrates/`.
- Exact old conversation/tool evidence through `trace_retrieve`.
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
  tool_usage/
    trace_retrieve.md
    edit_apply_patch.md
    terminal.md
    read_search.md
    memory_docs.md
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

## Runtime Notes

- First-turn wake context includes compact excerpts from workspace `.socrates/MEMORY.md` and `.socrates/repo_docs/CORE_IDEA.md`.
- Generic `edit` and `apply_patch` writes to `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/*.md`, and `.socrates/skills/**` are rejected; use dedicated docs tools or the backend project skill builder.
- Terminal commands are preflight-rejected when they mention Socrates-owned protected paths: workspace `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/**`, `.socrates/skills/**`, and global `~/.Socrates/skills/**`, `~/.Socrates/tool_usage/**`, `identity.md`, or `operating_principles.md`. This is an obvious-path guard, not a process sandbox.
- The background memory worker is an async specialized `SocratesAgent` run with a memory-agent system prompt, restricted read-only memory tools, `trace_retrieve`, and final JSON patch proposals. It targets only global `tool_usage`, global `skills`, and rare gated `soul` proposals.
- Each project has persisted memory-agent settings. New projects default to OpenRouter `xiaomi/mimo-v2.5-pro` with thinking off, surfaced in the dashboard `Memory Agent` panel.
- Memory jobs are triggered after completed chat turns. App startup does not automatically dump all historical project chats into the memory agent; older evidence is pulled through `trace_retrieve` only when the memory agent asks for it.
- Memory-agent implementation is split out of `memoryStore.ts` into focused runner/output/soul/skill helper modules. `memoryStore.ts` is still above the ideal size threshold and should next shed docs/search helper code rather than gain new responsibilities.
- Project skill creation is user-triggered from the dashboard `Skills +` flow and writes `.socrates/skills/<skill-name>/SKILL.md`.
- `socrates-skill-writer` is an internal backend builder asset, not exposed as a normal model-visible skill.
- Soul proposals still require internal confirmation and user-visible notification.
- Legacy project memory from `~/.Socrates/projects/<projectId>/` is migrated into workspace `.socrates/MEMORY.md` and the old project root is removed.
- Legacy six repo docs are migrated by scaffold behavior into the four-doc system; old workspace repo-doc files are removed by initialization.

## Verification

Latest verified after the lean memory/prompt migration:

```text
pnpm --filter @socrates/contracts test -- --run
pnpm --filter @socrates/workspace test -- --run
pnpm --filter @socrates/core test -- --run
pnpm --filter @socrates/server test -- --run
```

Still run `pnpm --filter web typecheck` and `git diff --check` before final closeout on code changes.
