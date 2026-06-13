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
- Global Memory Agent retargeted to global tool usage, learned skills, and gated soul edits.
- Backend memory work reuses the core `SocratesAgent` tool-call loop with a specialized prompt and scoped tools: global `trace_retrieve`, `projects`, `tool_docs`, `skills`, `soul`, and `edit_files`.
- Memory runs are scheduled from global settings, process completed-turn event manifests after the durable `events.sequence` watermark, and can be triggered manually from Settings.
- Settings page includes the `Memory Agent` panel for cadence, enabled state, provider/model/thinking, manual run, and recent run logs.

## Next Planned Correction

- Memory Agent manifests must be packed entry by entry and stop before either 80 completed Socrates turns or 60k estimated input tokens, whichever comes first. The next implementation should avoid mid-entry truncation and advance the watermark only to the last included event sequence.
- Context compression needs a full overhaul. The existing compressor uses prompted JSON and parsing, not true structured output; live SQLite snapshots showed schema drift. The next architecture should use shared schemas, structured generation/provider support, dedicated Socrates and Memory Agent compressor prompts, validation before activation, recent-tail preservation, and repeated-compaction evals.

## Important Non-Goals

- Project skill creation is dashboard-triggered through `Skills +`.
- No active diary read/write/search/wake path.
- No main-agent writes to global docs or soul docs.
- No per-turn memory job enqueueing from chat completion; trace indexing remains separate from memory-agent scheduling.
