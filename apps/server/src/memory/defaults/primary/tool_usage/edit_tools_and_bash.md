# Edit Tools And Terminal Usage Guide

This guide covers Socrates' mutation and execution tools:

- `edit`
- `apply_patch`
- `bash` / Terminal

Use these tools to change files, apply coordinated patches, run checks, start servers, inspect command output, and verify that work actually succeeded.

## Core Principle

Words are not actions. If a task requires changing files or running verification, call the appropriate tool and wait for verified output before claiming success.

## Tool Roles

| Tool | Purpose | Best For |
| --- | --- | --- |
| `edit` | Create or modify one file | New files, one targeted replacement, deliberate whole-file overwrite |
| `apply_patch` | Apply structured multi-hunk or multi-file patches | Coordinated edits, multiple files, delete/move operations |
| `bash` / Terminal | Execute commands from the workspace | Tests, builds, package commands, dev servers, git inspection, environment checks |

## Non-Negotiable Safety Rules

- Read existing files before mutating them.
- Do not pass content hashes in tool inputs; freshness is tracked by the harness.
- After a successful mutation, read the file again before mutating it again.
- Do not edit files through Terminal redirection when `edit` or `apply_patch` can do it.
- Do not claim success unless the tool reports success and verification was run when appropriate.
- Preserve user changes. Never revert unrelated changes.
- Writes to `<workspace>/.socrates/PROJECT_NOTES.md` must use `project_notes`, not `edit` or `apply_patch`.
- Writes to `<workspace>/.socrates/repo_docs/*.md` must use `repo_docs`, not `edit` or `apply_patch`.
- Sensitive files require extra care and may be denied or approval-gated.
- When a deliverable, scratch file, or generated file is derived from files in a subfolder, write it with an explicit path in that same subfolder or nearest relevant existing folder.
- Use the workspace root only when the user asks for root output, the artifact is truly project-level, or the task is standalone workspace-level work with no relevant subfolder.
- Before Terminal commands create files or directories, verify the intended parent directory exists and use an explicit relative path or `cwd`.

## `edit`

`edit` is the primary single-file mutation tool.

### Parameter Reference

| Parameter | Meaning | Required | Use When |
| --- | --- | --- | --- |
| `path` | Workspace-relative target path | yes | Every edit call. For subfolder-derived deliverables, use that subfolder or nearest relevant existing folder. |
| `content` | Full content for new file or explicit overwrite | one edit mode | Creating a file or deliberately replacing a whole file. |
| `oldString` | Exact existing text | targeted mode | Replacing a precise snippet. |
| `newString` | Replacement text | targeted mode | Replacing a precise snippet. |
| `replaceAll` | Replace every `oldString` match | no | Every occurrence should change. |
| `overwrite` | Must be `true` for existing-file full rewrite | no | Whole-file rewrite is deliberate. |
| `dryRun` | Preview without writing | no | Inspect diff before mutation. |

Use exactly one mode: `content` or `oldString`/`newString`, never both.

### Create A New File

```json
{
  "path": "scripts/report_status.py",
  "content": "print('ok')\n"
}
```

Use this when the file does not exist.

If the file is a deliverable derived from a subfolder, include that folder in the path:

```json
{
  "path": "DBMS/exercise10_solution.tex",
  "content": "..."
}
```

### Targeted Replacement

```json
{
  "path": "src/example.ts",
  "oldString": "const retries = 1",
  "newString": "const retries = 3"
}
```

Use targeted replacement for most existing-file edits.

Rules:

- `oldString` must match exactly once unless `replaceAll: true`.
- Include enough surrounding context to avoid accidental duplicate matches.
- If the tool says no match, re-read the file and patch from current disk.
- If the tool says multiple matches, retry with a longer `oldString`.

### Replace All

```json
{
  "path": "src/example.ts",
  "oldString": "legacyName",
  "newString": "currentName",
  "replaceAll": true
}
```

Use only when every occurrence must change.

### Whole-File Overwrite

```json
{
  "path": "README.md",
  "content": "# New README\n\n...",
  "overwrite": true
}
```

Use sparingly. Prefer targeted replacement unless the user clearly asked for a full rewrite or the file is generated.

## `apply_patch`

Use `apply_patch` for multi-hunk or multi-file changes. Prefer the structured patch format.

### Parameter Reference

| Parameter | Meaning | Required | Use When |
| --- | --- | --- | --- |
| `patchText` | Structured patch text | yes | Normal model-facing patch input. |
| `dryRun` | Preview without writing | no | Check patch interpretation before applying. |

The backend also accepts normalized legacy `patch`, but models should use `patchText`.

### Structured Patch Template

```text
*** Begin Patch
*** Update File: src/example.ts
@@
 const oldValue = true
-const timeoutMs = 1000
+const timeoutMs = 5000
*** End Patch
```

### Add File

```text
*** Begin Patch
*** Add File: docs/new-guide.md
+# New Guide
+
+Content here.
*** End Patch
```

Every content line in an add-file hunk starts with `+`, including blank lines.

### Delete File

```text
*** Begin Patch
*** Delete File: obsolete.txt
*** End Patch
```

### Move Or Rename

```text
*** Begin Patch
*** Update File: old/path.ts
*** Move to: new/path.ts
*** End Patch
```

### Move And Edit

```text
*** Begin Patch
*** Update File: old/path.ts
*** Move to: new/path.ts
@@
-export const name = "old"
+export const name = "new"
*** End Patch
```

## Patch Format Rules

- Include `*** Begin Patch` and `*** End Patch`.
- For update hunks, start with `@@`.
- Unchanged/context lines start with one space.
- Removed lines start with `-`.
- Added lines start with `+`.
- A blank unchanged line is a line containing a single leading space.
- `@@` labels are optional hints, not line numbers.
- Include enough exact old lines to locate the change.

## Terminal / `bash`

The model-visible tool id is `bash`, but user-facing copy should say Terminal.

### Parameter Reference

| Parameter | Meaning | Required | Use When |
| --- | --- | --- | --- |
| `operation` | `run`, `start`, `status`, `output`, or `stop`; defaults to `run` | no | Choose blocking command, long-running terminal, inspect, or stop. |
| `command` | Command string | for `run` and `start` | Execute or start a process. |
| `name` | Human terminal name | no | Name a new long-running terminal. |
| `target` | Human terminal name/target | when multiple terminals exist | Inspect or stop the intended terminal. |
| `cwd` | Working directory | for subfolder commands | Use a safe workspace-relative/current-workspace path instead of prefixing the command with `cd`. |
| `timeoutMs` | Timeout up to 600,000 ms | no | Longer finite commands. |
| `charLimit` | Output cap up to 80,000 chars | no | Control output size. |

Use Terminal for:

- tests
- builds
- package manager commands
- scripts
- git inspection
- database migrations
- dev servers
- environment checks
- command output investigation

For commands that create files or directories:

- Verify the parent directory first with a bounded inspection command or prior `read`/`search` evidence.
- Use `cwd` when the command should run inside a subfolder.
- Use explicit relative output paths so generated files do not accidentally land in the workspace root.
- Do not rely on `cd some/folder && ...` when the tool's `cwd` field can express the working directory.

Do not use Terminal for:

- creating files via heredoc
- `cat > file`
- `tee file`
- `printf ... > file`
- broad file reads when `read` is better
- broad grep when `search` is better

## Blocking Commands

Use `operation: "run"` for finite commands.

```json
{
  "operation": "run",
  "command": "pnpm --filter @socrates/server test",
  "timeoutMs": 120000
}
```

For a finite command inside a subfolder:

```json
{
  "operation": "run",
  "command": "pandoc exercise10_solution.tex -o exercise10_solution.pdf",
  "cwd": "DBMS",
  "timeoutMs": 120000
}
```

## Long-Running Commands

Use `operation: "start"` for dev servers, background workers, watchers, long installs, or commands likely to run for more than 15 seconds.

For app bring-up and monitoring, start each independent long-running process as its own named Terminal, such as `backend`, `frontend`, `worker`, or `celery`. Keep talking to the user while those Terminals run in the background, and inspect health with `operation: "status"` or `operation: "output"` by human Terminal name.

```json
{
  "operation": "start",
  "command": "pnpm dev",
  "name": "web-dev"
}
```

Then inspect:

```json
{
  "operation": "output",
  "target": "web-dev",
  "charLimit": 8000
}
```

Stop when done:

```json
{
  "operation": "stop",
  "target": "web-dev"
}
```

If exactly one active Terminal exists, omit `target`.

## Awaiting User Input

If a Terminal result has `terminal.status: "awaiting_input"` or `awaitingInput: true`, treat it as a hard human handoff.

- Tell the user what the prompt is asking for and that they should type into the Terminal panel.
- Stop your response and wait for the next user turn.
- Do not call `stop`, `status`, or `output` just to finish an interactivity test.
- Do not claim interactivity worked until user input has actually been sent and follow-up Terminal output confirms the command reacted to that input.
- Do not invent stdin. Terminal input is user-only.

## Terminal Working Directory

Terminal already starts in the active workspace.

Correct:

```json
{
  "command": "pnpm test"
}
```

Incorrect:

```json
{
  "command": "cd /guessed/path/to/repo && pnpm test"
}
```

Use relative paths from the active workspace. Do not guess absolute workspace paths.

For subfolder commands, prefer the `cwd` parameter:

```json
{
  "command": "pnpm test",
  "cwd": "packages/core"
}
```

Before commands create files or directories, verify the intended parent directory exists and use an explicit relative output path or `cwd`.

## Platform Rules

Terminal is platform-native:

- macOS/Linux: POSIX shell.
- Windows: PowerShell first, then fallback.

Do not assume Unix-only syntax on Windows. Use platform-appropriate commands if environment guidance indicates Windows.

## Environment Rules

Terminal uses a sanitized workspace environment.

Do not assume:

- Socrates server environment variables.
- provider API keys.
- `NODE_ENV`.
- package manager omit/production flags.
- CI variables.

If a command intentionally needs an env var, set it explicitly in that command.

## Verification Workflow

For code changes:

1. Read relevant files.
2. Edit or patch.
3. Run the smallest meaningful check.
4. If the check fails, inspect the current failure before editing again.
5. Report changed files and verification result.

Example:

```text
read src/parser.ts
edit src/parser.ts
bash pnpm --filter parser test
final answer with file path and test result
```

## Handling Tool Errors

### `edit_stale_content`

The file changed since it was read.

Response:

1. Read the file again.
2. Rebuild the edit against current content.
3. Retry.

### `edit_use_targeted_replace`

The model attempted a whole-file write without explicit overwrite.

Response:

1. Use `oldString`/`newString`, or
2. use `overwrite: true` only for a deliberate full rewrite.

### `project_notes_dedicated_tool_required`

The model tried to mutate `.socrates/PROJECT_NOTES.md` through generic mutation tools.

Response:

1. Use `project_notes` with `operation: "patch"`.
2. Do not retry with `edit` or `apply_patch`.

### `repo_docs_dedicated_tool_required`

The model tried to mutate `.socrates/repo_docs/*.md` through generic mutation tools.

Response:

1. Use `repo_docs` with `operation: "patch"`.
2. Select one allowlisted repo-doc filename.
3. Do not retry with `edit` or `apply_patch`.

### Patch grammar errors

Response:

1. Use structured patch format.
2. Include exact context lines.
3. Avoid hand-calculating unified diff hunk counts.

### Terminal timeout

Response:

1. If command is expected to keep running, use `operation: "start"`.
2. If it should finish, inspect output and rerun with a focused command or longer timeout.

## FAQ

### Should I use `edit` or `apply_patch`?

Use `edit` for one new file, one targeted replacement, or one deliberate whole-file overwrite. Use `apply_patch` for multiple files, multiple hunks, deletes, moves, or when a patch expresses the change more clearly.

### Should I ever write files with Terminal?

No, not when `edit` or `apply_patch` can do the mutation. Terminal file writes hide diffs and bypass mutation safety.

### Can I edit `.socrates/PROJECT_NOTES.md` with `edit`?

No. Use `project_notes.patch`.

### Can I edit `.socrates/repo_docs/*.md` with `edit`?

No. Use `repo_docs.patch`.

### What if I need to run a dev server?

Use `bash` with `operation: "start"` and a human `name`, then inspect with `operation: "output"` or stop with `operation: "stop"`.

### What if tests fail after my edit?

Read the current failure and relevant files before editing again. Do not guess from stale assumptions.

## Good Mutation Templates

### Single precise code edit

```json
{
  "path": "src/config.ts",
  "oldString": "export const limit = 10\n",
  "newString": "export const limit = 20\n"
}
```

### Multi-file patch

```text
*** Begin Patch
*** Update File: src/config.ts
@@
-export const limit = 10
+export const limit = 20
*** Update File: src/config.test.ts
@@
-expect(limit).toBe(10)
+expect(limit).toBe(20)
*** End Patch
```

### Test command

```json
{
  "operation": "run",
  "command": "pnpm --filter @socrates/server test",
  "timeoutMs": 120000,
  "charLimit": 12000
}
```

### Dev server

```json
{
  "operation": "start",
  "command": "pnpm --filter web dev",
  "name": "web"
}
```

## Final Answer Template

```text
Changed <file/path> to <what changed>.

Verified with:
- <command>: passed

Remaining risk:
- <only if real>
```

## Checklist Before Final Answer

- Did every claimed file change come from a successful mutation tool?
- Did I run a meaningful verification command if possible?
- Did I avoid overwriting user changes?
- Did I avoid Terminal file writes?
- Did I handle project notes through `project_notes`?
- Did I handle repo doctrine through `repo_docs`?
- Did I stop or report any long-running Terminal sessions?
