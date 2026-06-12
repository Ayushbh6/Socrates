# Legacy Memory v0

This folder records the retired production memory shape.

The old runtime exposed `socrates_memory` and `project_notes`, stored project memory under `~/.Socrates/projects/<projectId>/`, and wrote diary markdown under a per-project diary tree.

That implementation has been removed from production code paths. The current runtime uses:

- `global_docs` for root `~/.Socrates/tool_usage` and `~/.Socrates/useful_patterns`.
- `project_docs` for workspace `.socrates/MEMORY.md` and `.socrates/PROJECT_NOTES.md`.
- `repo_docs` for the four workspace repo docs.
- `trace_retrieve` for exact prior conversation/tool evidence.

Historical code remains available through git history before the lean memory migration.
