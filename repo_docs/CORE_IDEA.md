# Core Idea

Socrates is a local-first, project-first AI coding partner with a web UI, server runtime, typed contracts, workspace tooling, provider abstraction, trace retrieval, and durable docs/memory.

## Current Direction

The active direction is a lean memory and prompt architecture:

- Keep the base prompt as a compact operating kernel.
- Push detailed tool usage guidance into `tool_docs`.
- Keep project-specific state inside that project's `.socrates/`.
- Keep global identity, principles, tool usage, and learned skills in `~/.Socrates/`.
- Use `trace_retrieve` for exact prior conversation/tool evidence.
- Remove diary from production behavior.

## Current State

The implementation has:

- New model-visible tools: `tool_docs`, `skills`, and `project_docs`.
- Removed model-visible tools: `socrates_memory` and `project_notes`.
- Four repo docs: `CORE_IDEA.md`, `REPO_NAVIGATION.md`, `REPO_RULES.md`, `CONTRACTS.md`.
- Workspace project memory at `.socrates/MEMORY.md`.
- Wake context built from workspace project memory and `CORE_IDEA.md`.
- Background memory worker retargeted to global tool usage, learned skills, and gated soul proposals.
- Backend memory worker now reuses the core `SocratesAgent` tool-call loop with a specialized prompt and restricted read-only tools, including `trace_retrieve`.
- Project dashboard includes a `Memory Agent` panel for the project's memory-agent provider/model/thinking setting.

## Important Non-Goals

- Project skill creation is dashboard-triggered through `Skills +`.
- No active diary read/write/search/wake path.
- No main-agent writes to global docs or soul docs.
