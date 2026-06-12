# Repo Rules

This file records durable engineering rules for this workspace. Keep it short, current, and practical.

## Engineering Rules

- Prefer checked-in files and these repo docs over stale chat memory.
- Keep changes scoped to the user's request and the surrounding module boundary.
- Follow existing language, framework, naming, formatting, and test patterns.
- Preserve user work; do not revert unrelated changes.
- Verify meaningful changes with the narrowest reliable test or build command.

## Tool And Workflow Rules

- Read current files before editing them.
- Use targeted edits or structured patches for existing files.
- Use `project_docs` for `.socrates/MEMORY.md` and `.socrates/PROJECT_NOTES.md`.
- Use `repo_docs` for `.socrates/repo_docs/*.md`.
- Do not claim success until the relevant command/tool confirms it.

## Update This When

- A stable repo convention is discovered.
- A recurring mistake needs a guardrail.
- The preferred verification workflow changes.
