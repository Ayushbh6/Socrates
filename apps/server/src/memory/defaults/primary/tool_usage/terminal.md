# Terminal

The model-visible tool id is `bash`; product copy calls the surface Terminal.

Use Terminal for tests, builds, git inspection, scripts, dev servers, and diagnostics. Commands start in the active workspace unless a `cwd` is supplied.

## Rules

- Use `cwd` for subfolders instead of prefixing commands with guessed `cd` paths.
- Before commands create files, verify the parent folder or use an explicit relative path.
- Use named long-running Terminals for dev servers/watchers, then poll `status` or `output`.
- If a Terminal is `awaiting_input`, report the needed input and stop until the user supplies it.
- Do not declare a command successful until follow-up output or exit status confirms it.
- Terminal commands that mention Socrates-owned protected paths are rejected before execution. This includes workspace `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, `.socrates/repo_docs/**`, `.socrates/skills/**`, and global `~/.Socrates/skills/**`, `~/.Socrates/tool_usage/**`, `identity.md`, and `operating_principles.md`.

This protected-path check is a cross-platform preflight guard for obvious path mentions. It is not an OS process sandbox and must not be described as one.
