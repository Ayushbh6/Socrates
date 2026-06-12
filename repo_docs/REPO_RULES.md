# Socrates Repo Rules

## Package Boundaries

- `apps/web` owns UI rendering and user interactions.
- `apps/server` owns API transport, WebSockets, SQLite stores, local runtime orchestration, and memory/docs persistence.
- `apps/desktop` owns launch/bundling glue only; it must not fork agent/provider/workspace logic.
- `packages/core` owns agent orchestration, prompt construction, and model-visible tool registry.
- `packages/contracts` owns shared Zod schemas and inferred types.
- `packages/workspace` owns local file/search/edit/patch/bash/resource operations.
- `packages/providers` owns model provider abstraction and adapters.
- `packages/shared` owns generic utilities.

## Contract Rules

- Shared API, WebSocket, tool, event, approval, and entity shapes must live in `packages/contracts`.
- Runtime code should import contracts instead of redefining payloads.
- When a tool contract changes, update contracts, core registry, server executors, tests, and docs together.

## Memory And Docs Rules

- Project-specific state lives only in the workspace `.socrates/`.
- Global Socrates knowledge lives only in root `~/.Socrates/`.
- The main agent cannot write global docs or soul docs.
- Use `project_docs` for `.socrates/MEMORY.md` and `.socrates/PROJECT_NOTES.md`.
- Use `repo_docs` for `.socrates/repo_docs/{CORE_IDEA,REPO_NAVIGATION,REPO_RULES,CONTRACTS}.md`.
- Use `tool_docs` for global tool usage guidance.
- Use `skills` for reusable workflows and learned patterns; the main agent reads/applies skills but does not write them.
- Generic `edit` and `apply_patch` must reject `.socrates/skills/**`; project skills are created through the backend/dashboard skill builder.
- Terminal must preflight-reject commands that mention Socrates-owned protected paths, including workspace memory/repo docs/skills and global skills/tool usage/soul docs. This is a cross-platform obvious-path guard, not an OS process sandbox.
- Use `trace_retrieve` for raw prior conversation/tool evidence.
- Diary must not re-enter production read/write/search/wake behavior without a deliberate architecture decision.

## Engineering Rules

- Read relevant files before editing them.
- Preserve unrelated user work.
- Keep changes scoped to the module boundary implied by the request.
- Prefer existing patterns over new abstractions.
- Avoid god classes and one-off implementation loops. If a file is around or above 1,500 lines, prefer a focused extraction instead of adding more responsibility to it.
- Add or adjust focused tests when changing contracts, stores, tool routing, prompt behavior, or workspace guardrails.
- Run the narrowest reliable verification before claiming success.
