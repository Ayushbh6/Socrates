# Socrates Agent Harness

## Objective

Build a production coding-agent harness with:

- a small, stable model-facing tool surface;
- a long-running tool loop that can finish real tasks;
- model- and provider-independent core behavior;
- strong prompt caching;
- goal-scoped context and safe, fully specified compaction with a fixed universal token budget;
- Skills and MCP tools loaded only when relevant;
- straightforward code with one implementation for each concern.

The target combines the focused core of OpenCode and Codex, DeepSeek's evidence that broad tools can support a capable loop, and Oh My Pi's separation between permanent and discoverable capabilities.

## The permanent tool surface

Socrates begins with exactly ten model-facing tools.

### Filesystem

#### 1. `read`

Read a bounded, line-addressable window from one UTF-8 text file.

```json
{
  "path": "string",
  "offset": "integer >= 1 | optional",
  "limit": "integer >= 1 | optional"
}
```

`offset` is the 1-based first line and defaults to `1`. `limit` defaults to `2,000` lines. A read window ends at whichever comes first: the line limit, or the universal `10,000`-token per-result ceiling (see "Bounded ingestion"). Individual lines longer than `2,000` characters are cut with an explicit marker, so a pathological file or line cannot consume the model context. Reaching the ceiling is paging, not loss: the result sets `truncated: true` and `next_offset`, and the agent continues from there.

Successful output is structured and rendered to the model with line numbers:

```json
{
  "path": "src/server.ts",
  "offset": 501,
  "lines": [
    { "number": 501, "text": "export function startServer() {" }
  ],
  "total_lines": 912,
  "truncated": true,
  "next_offset": 502
}
```

`truncated` is true whenever more readable text remains or a byte or line-length bound shortened the requested window. `next_offset` is present only when another sequential window exists. Empty files return an empty `lines` array and `total_lines: 0`.

The initial contract performs no LLM-generated summary and no automatic code folding. It returns exact text. Structural code outlines may be added later as an explicitly requested mode only if evaluations show that they improve large-code navigation without hiding important content.

Directory discovery does not belong in `read`; use `glob`. UTF-16 files with a byte-order mark are read as text. Binary files, directories, invalid UTF-8, and files outside the granted workspace fail with corrective errors rather than returning damaged text. A PNG, JPEG, GIF or WebP image is the exception: `read` shows it to a model that can see ("Images").

#### 2. `glob`

Find paths by filename or path pattern.

```json
{
  "pattern": "string",
  "path": "string | optional",
  "sort": "modified | path | optional",
  "include_ignored": "boolean | optional",
  "limit": "integer >= 1 | optional",
  "cursor": "string | optional"
}
```

`path` is the directory to search and defaults to the selected workspace. `pattern` uses one documented glob dialect: ripgrep's gitignore-style globs, where a pattern without `/` matches file names at any depth, `**` crosses directories, and braces offer alternatives (`*.{ts,tsx}`). Results are files only and include hidden files. They exclude files ignored by the workspace's `.gitignore` (whether or not the workspace is a git repository), repository metadata (`.git`), Socrates' protected folders and inaccessible paths. The pattern filters the ignore-respecting file list, so an inclusion pattern can never bring an ignored file back; `include_ignored: true` lists ignored files too (such as `node_modules` or build output), but never `.git` or protected folders. `sort` defaults to `modified`, most recently modified first, as the reference harnesses do, since recent files are usually the relevant ones; `path` gives stable path order. `limit` defaults to `200` (at most `1,000`). `cursor` continues the exact bounded result set created by the preceding call; callers do not construct cursors.

```json
{
  "root": ".",
  "matches": ["apps/server/src/index.ts", "packages/core/src/index.ts"],
  "returned": 2,
  "truncated": false,
  "next_cursor": null
}
```

An empty match is a successful result, with a note that ignored files were not listed. A truncated result always carries `next_cursor`; Socrates never silently samples a large result because sampling makes exact repository discovery difficult to reason about. One listing collects at most `50,000` paths and says so when it stops there. Every search (`glob` and `grep`) stops after `60` seconds with the corrective error `search_timeout`, which says to narrow the path, type or glob; the agent's own cancellation stays a cancellation.

#### 3. `grep`

Search file contents.

```json
{
  "pattern": "string",
  "path": "string | optional",
  "glob": "string | optional",
  "type": "string | optional",
  "output": "content | files | count | optional",
  "context_before": "integer 0-50 | optional",
  "context_after": "integer 0-50 | optional",
  "context": "integer 0-50 | optional",
  "multiline": "boolean | optional",
  "case_sensitive": "boolean | optional",
  "literal": "boolean | optional",
  "sort": "path | modified | optional",
  "include_ignored": "boolean | optional",
  "limit": "integer >= 1 | optional",
  "cursor": "string | optional"
}
```

`pattern` is a regular expression by default, in ripgrep's Rust regex syntax (no lookaround or backreferences). `literal: true` treats it as exact text, and `multiline: true` lets it span lines (`.` then matches newlines too); a pattern that needs it without asking fails with that correction. `case_sensitive` defaults to `true`; the tool never uses an implicit smart-case rule. `path` may be one file or directory and defaults to the selected workspace.

**Filters:**
- `type` is a ripgrep file type (`ts`, `py`, `rust`, `go`, `md`, …); an unknown one is the corrective error `invalid_type`.
- `glob` is one filter applied the same way as `glob`'s pattern, with braces for alternatives or a leading `!` to exclude (`!**/fixtures/**`).
- Like `glob`, `grep` searches hidden files and skips `.gitignore`-ignored files, `.git` and protected folders. Neither a filter nor an explicit file brings an ignored file back: a file named as `path` is searched only if the ignore-respecting listing from the workspace root includes it. `include_ignored: true` searches ignored files too.

`output` chooses the shape:

- **`content`** (the default): each matching line with its path and line number, in path order, so a file's matches stay together. `context_before` and `context_after` (or `context` for both) add up to `50` lines around each match as `before` and `after`. A line between two close matches is context for both, so each match reads on its own. A multiline match also carries `end_line`.
- **`files`**: only the paths of files that match, most recently modified first.
- **`count`**: each matching file with its number of matching lines, most recently modified first.

`sort` overrides the order.

```json
{
  "output": "content",
  "matches": [
    {
      "path": "src/server.ts",
      "line_number": 84,
      "text": "const server = await startServer()",
      "before": ["// Start once configuration is loaded."],
      "after": ["server.listen(port)"]
    }
  ],
  "returned": 1,
  "truncated": false,
  "next_cursor": null
}
```

`files` returns `files: ["src/server.ts"]` and `count` returns `counts: [{ "path": "src/server.ts", "count": 3 }]` in place of `matches`. `limit` defaults to `100` and allows at most `500` matches or `1,000` files per page; `cursor` continues the stable bounded result set from the preceding call. One search collects at most `5,000` matches or `50,000` files and says so when it stops there.

Returned lines are bounded at `500` characters. A longer line (a minified file, say) shows a window that contains the match, marked with how much was cut before and after it, so a match at column 3,000 is still visible. A multiline match is shown up to `2,000` characters. A file that is not UTF-8 is still searched: its lines are shown with replacement characters and marked `encoding: "not_utf8"`. Binary files are skipped. No match is a successful empty result, with a note that ignored files were not searched; an invalid expression is a corrective error.

`glob` and `grep` remain separate because path discovery and content search are simple, different operations used consistently across the reference harnesses.

### Editing

#### 4. `edit`

Perform precise replacements in one file, or create a new one.

```json
{
  "path": "string",
  "old_text": "string | optional",
  "new_text": "string | optional",
  "replace_all": "boolean | optional",
  "edits": "array<{ old_text, new_text, replace_all? }> | optional"
}
```

**One replacement:** `old_text` and `new_text`. `replace_all` defaults to `false`. With that default, the replacement succeeds only when `old_text` occurs exactly once. It fails safely when the text is absent or ambiguous, naming the lines involved. With `replace_all: true`, every occurrence is replaced, but zero occurrences still fail.

**Several replacements:** `edits` (up to `50`) replaces one file in several places in one call, as Claude Code's multi-edit and a multi-hunk patch do. The edits apply in order, each to the text the previous one left, and either all succeed or nothing is written. An error names the failing edit (`edits[2]: …`) and says that nothing was written. Passing both forms, or neither, is `invalid_parameters`.

**Creating a file:** an empty `old_text` with the whole content as `new_text` creates a file that does not exist, with missing folders, and with `new_text` written exactly. It never overwrites: on a file with content it fails with `old_text_empty`, and a file that appears meanwhile is `file_exists`. An empty existing file can be filled the same way. A missing file with a non-empty `old_text` is `file_not_found`, with similar paths and how to create it.

Matching is exact first. Only when nothing matches exactly, whole lines are compared with increasing tolerance for the drift models commonly introduce: trailing whitespace, then indentation, then typographic punctuation (curly quotes, dashes, non-breaking spaces). Each tier still compares every line, so there is no similarity scoring and a match can never land on a block that merely resembles the request; uniqueness applies at whichever tier matched. When an indentation-tolerant match finds one consistent shift, the same shift is applied to `new_text`; with `replace_all`, each occurrence gets its own shift. If the given lines' relative indentation differs from the file's, so no single shift exists, the edit fails with `old_text_indentation_mismatch` instead of guessing. The result's `match` field reports the tier (`exact`, `trailing_whitespace`, `indentation`, or `unicode_punctuation`), or `edits` lists each edit's replacements and tier.

When `old_text` is not found, the error names the closest block of the file and how it differs. Each line of `old_text` votes for the blocks where the same line (ignoring indentation and typographic punctuation) sits at the same place, and the block most lines agree on (at least half) is shown. Up to three differing lines are quoted, the file's beside `old_text`'s: "The closest text is at lines 12–15, which differs at line 13: the file has … where old_text has …". It is a suggestion for the next try, never applied.

The backend verifies the current file version under the mutation lock. Every successful `read`, `edit`, and `apply_patch` records the file's content hash for the task; if the file changed after the task last observed it, the edit fails as stale and tells the agent to reread it. A file the task has never observed can be edited, because the exact `old_text` match already proves the expected content. This prevents a successful read followed by a racing overwrite.

**Writing it back faithfully:**
- The file's encoding is kept: UTF-8, or UTF-16 (little- or big-endian) recognised by its byte-order mark.
- The byte-order mark is kept.
- Each line keeps its own ending. In a file that mixes `\r\n` and `\n`, unchanged lines keep theirs, lines that replace others take the endings of the lines they replace, and other new lines take the ending of the line before them; a uniform file stays uniform.
- A path through a symlink edits the link's target and leaves the link.
- Files up to `20` MB can be edited.

```json
{
  "path": "src/server.ts",
  "replacements": 1,
  "changed": true,
  "match": "exact",
  "diff": "*** bounded unified diff ***"
}
```

The returned diff is bounded but the complete mutation and before/after versions are recorded in the event log. A replacement that produces identical content succeeds with `changed: false` and records no filesystem mutation. A created file returns `created: true`. When approvals are asked, the preview shows every replacement, or the new file's content.

#### 5. `apply_patch`

Apply a grammar-constrained patch that can update, create, move, or delete one or more files.

```text
*** Begin Patch
*** Update File: path/to/file
...
*** End Patch
```

The normalized tool contract carries the patch as one JSON string field, `{ "patch": "*** Begin Patch\n..." }`, so every provider that supports ordinary function calling can use it. A provider adapter may expose it as a native freeform tool, where the model sends the patch text directly, as an optimization; the core never depends on it. Paths are workspace-relative. Absolute paths, paths outside granted roots, malformed hunks, stale context, and unsupported file types fail before mutation.

The complete patch is validated first and then committed as one unit under the workspace mutation lock: either every declared file change succeeds or none does. During the commit each file is checked again immediately before it is touched: a source must still have the content the patch was computed from, and a new or move-destination path must still be free (new files are linked into place, which fails rather than overwrites). If any check or write fails, every file already written is restored, except a file that changed yet again during the rollback, which is left as it is and named in the error. A move cannot overwrite an undeclared destination, and a delete must match an existing file. Parent directories for declared new files may be created by the backend.

```json
{
  "files": [
    { "path": "src/server.ts", "action": "updated" },
    { "path": "src/config.ts", "action": "created" }
  ],
  "changed_files": 2,
  "diff": "*** bounded unified diff ***"
}
```

Updated files keep their encoding, byte-order mark and each line's ending, as with `edit`, and a rollback restores the exact original bytes. The output diff is bounded while the complete patch and mutation evidence remain in the event log. `edit` is preferred for one exact replacement; `apply_patch` is preferred for new files, coordinated multi-file work, moves, deletes, or several hunks.

There is no separate `write` tool. `edit` with an empty `old_text` and `apply_patch` already create files without adding another permanent schema. A dedicated `write` tool should be added only if evaluations show a concrete reliability problem with large new files.

### Execution

#### 6. `terminal`

Run a command in the selected project workspace and, when necessary, publish it as a persistent terminal session.

```json
{
  "command": "string",
  "cwd": "string | optional",
  "env": "object<string, string> | optional",
  "timeout_ms": "integer >= 0 | optional",
  "yield_ms": "integer >= 250 | optional",
  "pty": "boolean | optional",
  "background": "boolean | optional",
  "name": "string | optional",
  "ready": {
    "pattern": "string | optional",
    "port": "integer | optional",
    "timeout_ms": "integer >= 1 | optional"
  }
}
```

`cwd` defaults to the selected workspace and is resolved through the same access policy as filesystem tools. `env` augments the controlled process environment without requiring fragile shell quoting. `pty` defaults to `false` and should be enabled only for interactive programs: prompts, REPLs, installers that ask questions, editors and other full-screen programs.

**PTY sessions:**
- `pty: true` runs the command in a `120`×`40` pseudo-terminal through `node-pty`, which is native and loaded on first use. A machine where it cannot load reports `pty_unavailable` and keeps pipes. The prebuilt binaries cover macOS and Windows; elsewhere it is compiled at install.
- The terminal is `xterm-256color` with the same pager and credential-prompt settings.
- Its output reaches the agent as plain text: colours, cursor movement and window titles are removed, `\r\n` and a lone `\r` (a redrawn progress line) become line breaks, and backspaces are applied. A sequence split between two chunks waits for its end.
- What the user types is echoed back, as in any terminal.
- A terminal session reports `pty: true` and `input_required`.

`yield_ms` controls only how long the current call waits before returning a live session; it defaults to `10,000` and is capped at `30,000`. It is not a process deadline. `timeout_ms` is the actual execution deadline: ten minutes by default for ordinary foreground commands and none for `background: true` services, while `0` explicitly requests no deadline and asks for approval. A command that reaches its deadline is stopped and reported with `status: "timed_out"`.

Commands run through `bash -c` (PowerShell on Windows) in a non-interactive environment: `NO_COLOR`, `TERM=dumb`, `PAGER=cat` and the git and GitHub pagers disabled, and `GIT_TERMINAL_PROMPT=0`, so nothing blocks on a pager or a credential prompt. The harness's own model-provider credentials are removed from the inherited environment; a command that needs a key receives it through `env`. At most sixteen sessions are live per workspace; launching another fails with `too_many_terminals` and names them, rather than silently stopping one.

While a `terminal` call or a `terminal_control wait` waits on a session, the user sees what it prints: the call's handler reports the newest `4,000` characters the agent has not yet read, at most every `200` ms, through the call scope's `onOutput` (by the call's evidence handle), and stops before the call returns. The agent sends them as `output` drafts ("Drafts"); they are never shown to a model, and the call's result replaces them.

`background: true` returns as soon as the process has been created, or after the optional readiness condition resolves. A process still running after `yield_ms` is published automatically even when `background` is false. `name` is an optional stable, human-readable project-local name such as `dev-server` or `test-watch`; names are unique among live sessions.

`ready` is for services and watchers. `pattern` watches retained output and `port` watches local TCP readiness; when both are supplied, both must pass. Readiness never means that process creation alone succeeded. The launch specification is retained so a named terminal can later be restarted.

Completed result:

```json
{
  "status": "completed",
  "terminal": null,
  "exit_code": 0,
  "signal": null,
  "output": "Tests: 24 passed",
  "truncated": false,
  "wall_time_ms": 1834
}
```

Persistent result:

```json
{
  "status": "running",
  "terminal": "dev-server",
  "session_id": "term-3",
  "ready": true,
  "pty": false,
  "output": "Local: http://localhost:3000",
  "cursor": "c7",
  "truncated": false,
  "wall_time_ms": 10012
}
```

`terminal` is the preferred selector and equals the supplied name when present; otherwise the backend returns a short readable session id. Output is bounded to a head-and-tail excerpt within the universal per-result ceiling (see "Bounded ingestion"), treated as untrusted text, and retained separately for cursor-based reads (the most recent four million characters per background session; older output is reported as `output_lost`). The output of a finished foreground command, up to sixteen million characters, is stored with its call; beyond that the result reports `output_lost` and how many leading characters were dropped. A running session survives model turns, HTTP requests, task suspension, and user steering. The project terminal supervisor runs each session in its own process group and owns process-tree cleanup: when a command's shell exits, processes it left running in its group are stopped (a service belongs in a `background: true` session instead), and all sessions are stopped when the application exits. The process group of every running session is also listed, with its leader's start time, in the data folder's `terminals.json`. A server that crashed leaves its groups listed, and the next start stops those still running before anything new starts, so nothing escapes supervision. A group is stopped only when its leader still has the recorded start time, so a reused process id never names someone else's process. Reconnecting to sessions across an application restart is a later extension. A test run's outcome is derived from the session's exit, whenever it happens, and recorded for the launching task. The agent never kills an unverified operating-system PID directly.

#### 7. `terminal_control`

Discover, inspect, wait on, interact with, restart, or stop persistent terminal sessions. This is the compact control plane for all processes created by `terminal`; it does not execute arbitrary shell commands itself.

The input is a discriminated union selected by `action`:

```json
{ "action": "list" }
```

```json
{
  "action": "read",
  "terminal": "string",
  "cursor": "string | optional",
  "limit_lines": "integer >= 1 | optional",
  "filter": "string | optional"
}
```

```json
{
  "action": "wait",
  "terminal": "string",
  "event": "ready | output | input_required | exit | pattern",
  "pattern": "string | optional"
}
```

```json
{
  "action": "write",
  "terminal": "string",
  "input": "string | optional",
  "submit": "boolean | optional",
  "keys": "array<ENTER | TAB | ESCAPE | BACKSPACE | DELETE | UP | DOWN | LEFT | RIGHT | HOME | END | PAGE_UP | PAGE_DOWN | CTRL_C | CTRL_D | CTRL_L | CTRL_Z> | optional"
}
```

```json
{
  "action": "signal",
  "terminal": "string",
  "signal": "SIGINT | SIGTERM | SIGHUP | SIGTSTP | SIGKILL"
}
```

```json
{ "action": "terminate | restart", "terminal": "string" }
```

```json
{ "action": "resize", "terminal": "string", "cols": "integer 20-500", "rows": "integer 5-200" }
```

`terminal` accepts either the stable project-local name or returned short session id. The model never needs an operating-system PID.

- `list` returns every owner-visible live session plus a bounded number of recently exited sessions. Each row includes name/id, command summary, cwd, state, readiness, whether the session waits for input, start time, and exit information. A PTY session waits for input when it is running, has printed nothing for `750` ms since it was last written to, and either its last line is unfinished, as a prompt is (`Password: `, `Continue? [y/N] `), or it has hidden the terminal's cursor, as a menu or setup wizard does while it waits for a key (`npm create vite@latest`: the line ends, so the cursor is the sign). Over pipes it is `null`: programs rarely prompt there, and an idle partial line is more often progress output.
- `read` returns retained output after `cursor` (by default, after the output this agent last received), paged forward by `limit_lines` (default `200`) within the ceiling, together with a new cursor and explicit truncation or output-loss metadata. A single line longer than one page is paged through in pieces, never skipped. `filter`, a regular expression, keeps only the matching lines (`ERROR`, `FAIL`, `warning`), and the cursor still moves past the lines it skipped. Reads are non-destructive, so the UI and model do not steal output from one another. Pages and the head-and-tail cut of long output never split a character.
- `wait` blocks the same tool call without polling the model until the requested terminal event, cancellation, or an operational failure. `pattern` is required only for the `pattern` event. `input_required` resumes when a PTY session waits for input (see `list`); over pipes it is the corrective error `needs_pty`. On a PTY session every other wait also ends with `event: "input_required"` the moment the program asks for input, since it cannot go on until it gets some: an agent that waits for `exit` on a wizard is told about its next question, not left to the deadline. There is deliberately no model-facing polling interval. A configurable policy maximum bounds one wait; reaching it returns the current state with `event: "timeout"`, and the agent may wait again. Surviving an application restart while waiting (a durable event dependency that resumes the task) is a later extension.
- `write` sends text and/or named keys through the session's serialized input stream. `submit` defaults to `true` when `input` is supplied.
  - **In a PTY,** text and every key go to the terminal as the bytes a keyboard sends: Enter is a carriage return, arrows are escape sequences, and `CTRL_C` is the interrupt character the terminal turns into `SIGINT` for the program in front.
  - **Over pipes,** text goes to stdin, `ENTER` writes a newline, `CTRL_C` sends `SIGINT` to the process group, and `CTRL_D` closes stdin. Keys that need a terminal fail with `needs_pty`, which says to start the program with `pty: true`. Writing to a session whose stdin is closed fails.
- `signal` targets the verified foreground process group. `SIGKILL` requires normal approval policy and is never the default shutdown path.
- `terminate` performs graceful process-tree shutdown followed by bounded hard-kill if necessary.
- `restart` reuses the retained launch and readiness specification (and its PTY) and preserves the stable name while returning a new `session_id`.
- `resize` sets a PTY session's columns and rows; the program sees the new size as a terminal resize. Over pipes it is `needs_pty`.

Representative list output:

```json
{
  "terminals": [
    {
      "terminal": "dev-server",
      "session_id": "term-3",
      "status": "running",
      "ready": true,
      "input_required": false,
      "cwd": ".",
      "command": "npm run dev",
      "started_at": "2026-08-25T12:04:11Z",
      "exit_code": null,
      "signal": null
    }
  ]
}
```

Every action returns its discriminant, resolved terminal identity, current monotonic `state_version`, and only the fields relevant to that action. Delayed output or lifecycle notifications with an older `state_version` cannot overwrite newer state.

Representative `read` or resumed `wait` output:

```json
{
  "action": "read",
  "terminal": "dev-server",
  "session_id": "term-3",
  "status": "running",
  "event": null,
  "output": "GET /health 200",
  "cursor": "c9",
  "truncated": false,
  "output_lost": false,
  "exit_code": null,
  "signal": null,
  "state_version": 4
}
```

`wait` uses the same output with `action: "wait"` and `event` set to the event that resumed the task. `write`, `signal`, and `terminate` return the resolved terminal identity, whether the operation was accepted, the resulting status and `state_version`, plus exit information when settled. `restart` additionally returns the replacement `session_id`, readiness state, initial bounded output, and cursor. A terminal-control error never fabricates a successful state transition.

The split remains intentional: `terminal` has one job—launch and initially observe execution—while `terminal_control` owns the longer lifecycle. This combines Codex's automatic foreground-to-session handoff, Oh My Pi's named service supervision and readiness, and DeepSeek's explicit terminal discovery, retained scrollback, owner isolation, and process-group signalling.

Keeping execution and process control separate gives long-running commands a clear lifecycle without turning `terminal` into an oversized tool.

### Historical context

#### 8. `context_retrieve`

Discover goals and tasks in the SQL-backed ledger, search exact historical Q&A, or inspect one selected record. The exact event store remains authoritative; this tool only creates safe, bounded model-facing views of it.

`context_retrieve` has three actions with deliberately different jobs:

- `ledger_search` discovers the goal/task structure from compact metadata;
- `search` searches exact Q&A text within a selected target; and
- `inspect` expands one selected goal, task, turn, checkpoint, handover, or evidence reference.

#### `ledger_search` — discover goals and tasks

```json
{
  "action": "ledger_search",
  "query": "payment integration | optional",
  "entity": "goals | tasks | both | optional",
  "scope": "current_goal | all_goals | optional",
  "status": "open | completed | superseded | any | optional",
  "from": "date | optional",
  "to": "date | optional",
  "match": "hybrid | exact | optional",
  "limit": "integer | optional",
  "cursor": "string | optional"
}
```

The ledger is implemented in SQL with relational links and appropriate full-text and semantic indexes, but the model never writes raw SQL. It fills this validated filter contract; the backend performs the query under access policy.

`entity` defaults to `both`, `scope` defaults to `current_goal`, `status` defaults to `any`, `match` defaults to `hybrid`, and `limit` defaults to `10` with a hard cap of `25`. With no query or filters, results are the most recently updated visible rows in stable order. A cursor continues the exact frozen result set of the preceding call; changing filters while presenting a cursor fails with a corrective error.

The search covers bounded goal/task metadata: titles, objectives, status, continuation notes, dates, workspace, anchor manifests, and mechanically derived file/test/capability facts. It does not return exact message bodies or unrestricted tool evidence.

```json
{
  "action": "ledger_search",
  "query": "mobile layout",
  "scope": "all_goals",
  "results": [
    {
      "kind": "goal",
      "selector": "g7",
      "title": "Andy Website development",
      "updated_at": "2026-09-02T09:10:00Z"
    },
    {
      "kind": "task",
      "selector": "g7/t4",
      "goal": "g7 — Andy Website development",
      "title": "Fix homepage hero on mobile",
      "objective": "Make the homepage hero correct at supported mobile widths.",
      "status": "completed",
      "note": "Hero overflow fixed and mobile viewport checks pass."
    }
  ],
  "returned": 2,
  "more_matches": false,
  "next_cursor": null
}
```

`gN` and `tN` are permanent human-facing ordinal selectors, not database identifiers. Task numbers are local to their goal: `t4` means task 4 of the current goal, while `g7/t4` explicitly selects task 4 of goal 7. Search-result handles such as `r1` are short run-scoped references. Evidence handles such as `e1` are permanent within their task: the backend assigns them in order as tool calls are persisted, so the same `e12` keeps naming the same call in later turns, in history checkpoints, and in compound-part handoffs.

The working agent has no router-style three-call cap. It may refine a query, follow stable cursors, and inspect results as needed; the ordinary step, time, token, and output safeguards still apply.

#### `search` — search exact Q&A

Search input:

```json
{
  "action": "search",
  "query": "string | optional",
  "match": "hybrid | exact | optional",
  "target": "current_task | current_goal | all_goals | gN | tN | gN/tN | optional",
  "from": "date | optional",
  "to": "date | optional",
  "top_n": "number | optional",
  "cursor": "string | optional"
}
```

Search defaults and validation:

- `query` is optional: a pure temporal search ("what did we do last week") may omit it and search by `from`/`to` range alone. When `query` is omitted, at least one of `from`/`to` must be present.
- `match` defaults to `hybrid`.
- `target` defaults to `current_task`. `current_goal` searches all tasks of the current goal; `all_goals` searches all goals visible to the user; `gN` searches one goal; `tN` searches one task of the current goal; and `gN/tN` selects a task in another goal explicitly.
- `from` and `to` bound the search to exchanges completed within the range, inclusive, by date in the user's time zone. Both are optional and independent.
- `top_n` defaults to `5` and cannot exceed `10`.
- `cursor` continues the exact frozen result set of the preceding search. A truncated result always returns `next_cursor`; the model can keep paging or narrow its query without requesting an unbounded dump.
- `hybrid` fuses the BM25 (SQLite FTS5) ranking with the meaning ranking from the embedding index, plus a small recency boost (see "Embeddings and hybrid retrieval"). A meaning match on an exchange or on one of its tool calls finds the exchange. Without an embedding index, or while the embedder is unreachable, it is BM25 plus recency.
- `exact` performs literal, case-insensitive text matching after the same Unicode normalization of query and text, and never silently falls back to hybrid retrieval.
- Search covers exact user messages and visible Socrates responses. It returns Q&A pairs, not tool calls or tool results.

Task selectors never widen silently. A bare `t4` resolves only inside the current goal and successful output identifies that resolution:

```json
{
  "resolved_target": {
    "goal": "g7 — Andy Website development",
    "task": "g7/t4 — Fix homepage hero on mobile"
  },
  "scope_note": "A task selector without a goal defaults to the current goal. Use gN/tN to select a task from another goal."
}
```

If `t4` does not exist in the current goal, the tool fails closed with `task_not_found_in_current_goal` and directs the agent to use `ledger_search`, then retry with a selector such as `g2/t4`. It never searches other goals for a matching task number or guesses the intended goal.

Search output:

```json
{
  "action": "search",
  "query": "my problems with German cases",
  "match": "hybrid",
  "target": "current_goal",
  "results": [
    {
      "ref": "r1",
      "project_turn": 184,
      "date": "2026-08-12",
      "goal": "Ongoing German learning",
      "user_message": "I keep confusing accusative and dative after two-way prepositions.",
      "socrates_response": "The main problem is that you are deciding from the verb...",
      "complete": true,
      "omitted": null
    }
  ],
  "returned": 1,
  "more_matches": false,
  "next_cursor": null
}
```

`complete: false` means that an unusually large Q&A pair was represented by an explicitly bounded preview. `omitted` then states how much content was withheld, while `ref` still resolves to the exact stored turn.

#### `inspect` — expand one exact record

Inspection accepts exactly one human-facing selector or short reference:

```json
{
  "action": "inspect",
  "ref": "r1"
}
```

or:

```json
{
  "action": "inspect",
  "turn_number": 184
}
```

There is deliberately no inspection query. Inspection is deterministic: `gN` opens a bounded goal record, `tN` opens a task in the current goal, `gN/tN` opens a task in another goal, short refs open the selected search result or evidence, and a qualified `gN/tN/eM` opens evidence `eM` of another task (the form the compound-part handoff uses). The agent uses `ledger_search` or `search` to locate relevant material before inspecting it.

Inspection also resolves compaction artifacts. A history checkpoint handle such as `hc-3` opens the exact stored checkpoint, and a tool-call evidence handle such as `e1` opens the bounded view of that call and its complete stored result. Compaction therefore never creates unreachable content: everything the prompt summarizes or linearizes remains resolvable through this tool under the same output bounds.

Handles are backend-assigned. `rN` is scoped to the current run. `eN` and `hc-N` are permanent within their task and resolve against the task binding of the current turn; the same label in a different task names a different stored object, which the qualified `gN/tN/eM` form reaches explicitly. Permanent selectors (`gN`, `tN`, `gN/tN`) follow the goal-local task rules above. A stale, unknown, inaccessible, or foreign-task reference fails with a corrective error directing the agent to search again.

Inspection output:

```json
{
  "action": "inspect",
  "turn": {
    "ref": "r1",
    "project_turn": 184,
    "date": "2026-08-12",
    "goal": "Memory system review"
  },
  "user_message": {
    "content": "Could the compaction fix lose tool results?",
    "complete": true,
    "omitted": null,
    "ref": null
  },
  "tool_activity": [
    {
      "ref": "e1",
      "tool": "terminal",
      "status": "completed",
      "input": "Run the focused memory tests",
      "output": "Relevant failures and final test summary...",
      "complete": false,
      "omitted": "485,300 estimated tokens omitted"
    }
  ],
  "final_response": {
    "content": "The affected compaction path can still lose...",
    "complete": true,
    "omitted": null,
    "ref": null
  },
  "bounded": true
}
```

Inspection exposes the exact user message, tool calls, tool results, and visible final response when they fit. It never exposes private model chain-of-thought. When any component is oversized, it returns a bounded execution view rather than dumping the full turn into the model context.

The backend enforces one aggregate output bound for every `context_retrieve` action. The returned model-facing content stops at whichever limit is reached first:

- `2,000` lines;
- `50 KiB` of UTF-8 text;
- `10,000` tokens (the universal per-result ceiling in "Bounded ingestion"); or
- the remaining safe tool-output allowance for the current model request.

All three actions pass through one limiter at the end: if a result would still exceed any bound, its longest text is shortened and then its longest lists are cut, each with an explicit omission marker, until it fits. Ledger and Q&A searches apply every filter (scope, status, dates in the user's time zone) before their collection limit of 500 rows; when more rows match, the result says so. The agent cannot request raw output, set its own token allowance, use offsets to reconstruct an unbounded dump, or disable truncation. For an oversized inspection, the backend prioritizes turn identity, the user message, the visible final response, a compact tool-call inventory, and bounded beginning-and-end excerpts. Every omission is explicit and receives a short evidence reference such as `e1`. Inspecting that reference is bounded again by the same policy, so repeated calls never unlock a single unrestricted dump.

The backend owns canonical goal, task, message, turn, and event identifiers. Model-facing structure uses permanent human-facing selectors (`gN`, goal-local `tN`, and `gN/tN`); search results use short run-scoped handles such as `r1`; nested evidence uses handles such as `e1`; and `project_turn` is a permanent chronological number that is never renumbered. Exactness comes from backend resolution, not from asking the model to copy opaque identifiers.

### Conditional capabilities

Socrates uses three progressive discovery layers. It does not place every installed Skill or MCP schema in the base prompt, and it does not rely entirely on the model remembering to search.

#### Stable Skill shelf

At most five compact Skill summaries appear in the dynamic context before the current user message:

```text
<AVAILABLE_SKILLS>
- pdf: Read, render, inspect, and create PDF files.
- spreadsheets: Analyze and edit spreadsheet files.
</AVAILABLE_SKILLS>
```

Each entry contains only the exact name and one description bounded to `200` characters. Full instructions, paths, dependencies, and resources remain unloaded. Explicit user pins are selected first, followed by deployment defaults (both supplied by the application), then the Skills this user has activated most often across all goals, then by name. The resolved shelf is frozen for the goal as a `skill_shelf_frozen` event so ordinary turns remain cache-stable; usage changes affect a future goal, not every request. An empty shelf is not frozen, so Skills installed later still reach the goal, and a frozen Skill that is uninstalled drops out of the rendering. If five or fewer Skills are installed, all appear. To use a shelf Skill, the agent searches its exact name and activates the returned ref.

MCP tools never enter this shelf. Even small MCP descriptions multiply quickly, and a description without its live schema does not make the tool callable.

#### Automatic likely candidates

Before the first working-agent call of every user turn (each compound part separately, from that part's request), deterministic retrieval may suggest at most one inactive, available Skill and one inactive, available MCP tool. Candidates are hints, not activations; each carries a run-scoped ref that `capability_control` activates directly:

```text
<CAPABILITY_CANDIDATES>
- skill c1: pdf — Read, render, inspect, and create PDF files. (named in the message)
- mcp c2: playwright.browser_navigate — Navigate the browser to a URL. (matched: browser, navigate)
</CAPABILITY_CANDIDATES>
```

The retriever uses the same keyword ranking as `capability_search`: exact names, aliases, name words, tags, and description words, with common stop words ignored. Each kind has its own keyword threshold (`40` for a Skill, `60` for an MCP tool, so an MCP server's name alone never qualifies a tool) and may return no candidate; an MCP result cannot crowd out a stronger Skill result or vice versa. With an embedding index, a capability whose name and description match the message in meaning at the `suggest` floor also qualifies (shown as "similar in meaning"), and the keyword and meaning rankings are fused. It performs no LLM call. Attachment types join the signals when attachments exist.

Long prompts are not scored as one undifferentiated query. The retriever preserves the exact prompt for the agent but scores overlapping windows of `48` words (stride `24`) independently and keeps each capability's best window. This allows a relevant sentence buried in a long specification to match, while words scattered across the whole request cannot add up to a false match.

The Main Coding Agent decides whether to activate a candidate. A false-positive suggestion costs only a short metadata line. Explicitly naming a Skill, an MCP catalog name (`server.tool`), a public name, or a distinctive tool name (one containing `_` or `-`) creates an exact candidate that always qualifies when available, but still does not bypass activation, authentication, permissions, or policy.

#### Capability sources

Skills and MCP servers are global: they come from the user's Socrates folder (`$SOCRATES_HOME`, default `~/.socrates-v2`; see `server.md`, "Data folder"), never from a workspace, because a goal need not have a project folder (a learning journal has none). The application opens the installed catalog once and passes it to Socrates; `Socrates.close` stops every server connection it opened.

- **Skills** live in `skills/<name>/SKILL.md`. YAML frontmatter holds `name` (letters, digits, `-` and `_`, at most 64, equal to the folder name), `description` (required, at most `1,024` characters), and optional `tags`, `aliases`, and `dependencies` (catalog names). The body after the frontmatter is the instructions. The version is a short hash of the whole file, and the file is read again on every load, so an edited Skill is detected by its digest. Invalid folders are skipped with an internal diagnostic. The folder is rescanned during part setup. Revalidation clears cached Skill bodies before loading: changed, missing, invalid or unreadable Skills are withheld and named as stale, with a search/reactivate instruction. A stale version is never silently replaced.
- **MCP servers** are listed in `mcp.json` in the common `mcpServers` format. It is the user's own file, so its servers are trusted and starting them needs no approval. An entry with `command` (plus optional `args`, `env`, `cwd`) runs over stdio; an entry with `url` (plus optional static `headers`) uses streamable HTTP; `disabled: true` keeps an entry without starting it. `${NAME}` in any value is replaced by that environment variable, which keeps secrets out of the file. A server whose referenced variables are unset, or that answers `401`/`403`, is `authentication_required`; OAuth sign-in is a later addition. Each server is validated on its own; an invalid one is skipped with a diagnostic. Changes to `mcp.json` take effect when the catalog is opened again.
- Servers connect through the official MCP SDK when first needed — activating one of their tools, restoring an active tool, or a call — and the connection is reused. Each connection reads the server's complete `tools/list`, and every listing that differs from the server's previous one is recorded as an `mcp_tools_listed` event. Search reads these recorded listings and never connects, so a server's tools stay searchable in a new process before it is reached, and a resumed task sees exactly what was advertised. The exception is first discovery: opening the catalog, and subsequent part setup after the 30-second backoff, connect servers that have no recorded listing yet. A transient first failure therefore recovers without restarting; known servers remain lazy and search never connects. A `tools/list_changed` notification refreshes the listing the same way. Activation requests `tools/list` again; later steps read the live connection's listing.
- A server that fails to connect is `offline` for `30` seconds and is then retried on first use; a dropped connection is reconnected on next use. Connection timeout is `15` seconds; a tool call may run `10` minutes, extended by progress notifications. A protocol error or timeout is the tool's error result; only an unreachable server fails the call as `capability_unavailable`. Server stderr is kept as bounded internal diagnostics.
- An MCP tool result is rendered as text: text blocks verbatim, images, audio, and resources as one descriptive line, and structured content when nothing else was returned. Its image blocks are also shown to a model that can see ("Images"): a PNG, JPEG, GIF or WebP up to `5` MB (the bytes decide the format, not the declared type), the first `4` of a result; a model that cannot see is told the image's content is unknown. A browser tool's screenshot is therefore a picture the model looks at, not a line about one.

#### MCP approvals

A tool whose server marks it `readOnlyHint` runs freely. Any other MCP tool asks the user through the application's `approve` callback before its first call in each goal; a granted approval is recorded with the tool's catalog name and remembered for that goal, while a denial is a corrective `approval_denied` error and the next call asks again. Approval is separate from activation, and a non-read-only tool also counts as a mutation for the first-mutation gate. Under an access policy, "Access" replaces this approval (see "Access").

#### On-demand search

The agent uses `capability_search` when the shelf and automatic candidates are insufficient or when a new need emerges during work. For example, a coding task may require only permanent tools initially and discover the need for Playwright after a local server is running.

#### 9. `capability_search`

Search the lightweight catalog of available Skills and MCP tools without loading their instructions or schemas into the model context.

```json
{
  "query": "string",
  "kind": "any | skill | mcp | optional",
  "limit": "integer >= 1 | optional"
}
```

`kind` defaults to `any`. `limit` defaults to `3` and cannot exceed `5`. Search ranks exact names first, then aliases, tags, descriptions, and declared use cases. It is deterministic catalog retrieval, not another model call. With `kind: any`, ranking reserves representation for both kinds when both have relevant matches; a large MCP catalog cannot starve Skill results. The agent uses `kind: skill` or `kind: mcp` when it knows which class of capability it needs.

The catalog contains only bounded discovery metadata:

- Skill name, description, tags, provider, and current availability;
- MCP server and tool identity, short description, connection/authentication state, and trustworthy capability annotations when supplied;
- whether the result is already active for the current goal.

Full Skill instructions, Skill resource listings, MCP input schemas, and MCP output schemas are excluded from the permanent prompt and search result. The only always-present capability metadata is the bounded five-Skill shelf described above. One MCP server with twenty tools produces twenty separately searchable capability records; finding one tool never exposes the other nineteen.

Successful output:

```json
{
  "query": "read a GitHub issue",
  "kind": "any",
  "matches": [
    {
      "ref": "c1",
      "name": "github.get_issue",
      "kind": "mcp",
      "description": "Read one GitHub issue",
      "server": "github",
      "tool": "get_issue",
      "availability": "available",
      "active": false
    },
    {
      "ref": "c2",
      "name": "github_issue_workflow",
      "kind": "skill",
      "description": "Investigate an issue and compare it with a repository",
      "provider": "user",
      "availability": "available",
      "active": false
    }
  ],
  "returned": 2,
  "more_matches": false
}
```

`ref` is a short result-local selector issued by the backend. It resolves the exact catalog record seen by this search and prevents collisions between similarly named Skills, servers, and tools. The backend retains canonical provider and server identifiers privately. Ordinary MCP catalog names remain `server.tool`. When a component needs escaping (including a dot or percent sign), the canonical name is `mcp:<encoded-server>/<encoded-tool>`, with dots inside components encoded as `%2E`. This namespace contains no literal dot and cannot collide with a legacy dotted name. Search retains the original server and tool fields and the dotted display alias. References, active state, approval subjects and dispatch all use the exact canonical name. Legacy ambiguous activations and approvals are not reinterpreted; search/activate the exact tool again and deactivate an obsolete record if present.

`availability` is one of `available`, `authentication_required`, `offline`, `disabled`, or `unavailable`. Catalog presence is not proof of a live MCP connection. Searching performs no connection, authentication, permission request, Skill load, or tool activation. An empty search is successful and may suggest a narrower query; it never dumps the whole catalog as a fallback.

#### 10. `capability_control`

Activate one exact search result, list the current goal's active capabilities, or deactivate one capability that is no longer needed.

```json
{
  "action": "activate",
  "ref": "string"
}
```

```json
{ "action": "list" }
```

```json
{
  "action": "deactivate",
  "name": "string"
}
```

Activation is idempotent. Repeating an active `ref` succeeds with `status: "already_active"` and does not duplicate instructions, schemas, connections, or prompt entries. A stale, unknown, foreign-goal, or superseded reference fails with a corrective error directing the agent to search again. `list` returns only the bounded active set, never the full installed catalog. `deactivate` uses the exact active public name returned by activation; it removes goal-local prompt exposure without uninstalling a Skill or globally disconnecting an MCP server.

Skill activation output:

```json
{
  "kind": "skill",
  "name": "github_issue_workflow",
  "status": "activated",
  "version": "v3",
  "instructions": "The SKILL.md body after its frontmatter...",
  "resource_base": {
    "kind": "directory",
    "path": "/Users/me/.socrates/skills/github_issue_workflow"
  },
  "dependencies": [
    {
      "kind": "mcp",
      "name": "github.get_issue",
      "status": "inactive"
    }
  ]
}
```

For a Skill, the tool result itself carries the complete validated instruction body and a short model-facing version, so the next model step can follow it without a duplicate synthetic message. The backend retains the content digest privately. An oversized or invalid Skill fails activation instead of silently supplying partial instructions. `resource_base` may instead be a URL or bounded opaque provider description. Referenced scripts, templates, examples, and supporting files are loaded only when the Skill instructions require them; activation does not enumerate or ingest an entire Skill directory. The active context retains `resource_base` and declared dependencies alongside the instructions after history linearization and restart. `read` accepts an absolute path inside a valid active Skill directory, including on a goal with no workspace. This exception is read-only and goal-scoped: it revalidates the Skill, resolves real paths, rejects traversal and symlink escapes, and disappears on deactivation or stale content. It does not extend edit, patch, search or terminal permissions; scripts execute under the existing workspace/approval policy.

A Skill may declare dependencies, but activation never silently activates MCP tools or installs software. The result reports each dependency as active, inactive, unavailable, or authentication-required. The agent uses `capability_search` and `capability_control` for each required inactive capability before following the dependent step.

MCP activation output:

```json
{
  "kind": "mcp",
  "name": "github.get_issue",
  "status": "activated",
  "server": "github",
  "tool": "get_issue",
  "public_name": "mcp__github__get_issue",
  "connection": "connected",
  "schema_version": "v2",
  "available_on_next_step": true
}
```

For an MCP tool, the harness connects or reconnects to the configured server when necessary, performs a fresh MCP `tools/list`, resolves the exact advertised tool selected by `ref`, validates and bounds its real JSON Schema, assigns a collision-safe public name (`mcp__server__tool`, with a short hash of the exact identity whenever a name had to be rewritten or shortened), and appends only that one tool schema to the next model request. Calls to that public name go through the same tool runner as the permanent tools: input validation, corrective errors (the server's complete error output stays in the event log), bounded results with evidence handles, and derived capability facts. A new process restores the goal's active tools by fetching their schemas again; a changed schema is recorded as a replacement, and a tool that cannot be reached is left out and fails closed when called. Active Skills are revalidated by content digest before their instructions are used again. Activation does not invoke the MCP tool and does not count as approval for a later mutating call.

Authentication-required activation returns a structured non-success state telling the agent to have the user configure the server's credentials; it never asks the model to handle credentials. Offline or failed servers retain bounded internal diagnostics, while the model receives a corrective operational error without secrets or raw stack traces.

Activated capabilities are scoped to the current goal:

- an activated Skill's exact version and instructions remain available to subsequent steps in that goal;
- an activated MCP tool remains in the goal's dynamic tool set while its server and policy permit it;
- switching goals removes those dynamic instructions and schemas from the next request without uninstalling or globally disconnecting anything;
- returning to a goal restores its still-valid active set after revalidating provider versions, connection state, and permissions;
- deactivation removes the Skill body or MCP schema from the next request while retaining exact historical calls and results.

The backend caps the number and aggregate schema size of simultaneously active MCP tools: at most sixteen tools and `16,000` schema tokens per goal, with each schema at most `4,000` tokens. A Skill's instructions are at most `8,000` tokens. When the cap would be exceeded, activation fails truthfully and returns the bounded active set so the agent can deactivate tools it no longer needs. It never silently drops an active schema that the model may call.

MCP connection generations are supervised. If an active server reconnects with an unchanged tool schema, the public tool remains stable. If its schema changes, the next model step receives one replacement schema and records the new digest. If the tool disappears or the server becomes unavailable, dispatch fails closed, the active entry is marked unavailable, and the model is told to search or activate again. A stale schema is never executed against a different tool.

### Dynamic capability surfacing

The ten permanent schemas remain the stable prompt prefix. The bounded shelf and likely candidates appear later in dynamic context. Full conditional capabilities enter only after the model calls `capability_control`:

```text
Permanent schemas: capability_search + capability_control
    ↓
Up to five Skill summaries + zero to two likely candidates
    ↓
Agent may activate a candidate, search for another, or use neither
    ↓
capability_control(action: activate, ref: c1/c2)
    ├─ Skill: full instructions arrive as this tool result
    └─ MCP: one validated native tool schema is appended next step
    ↓
The same Main Coding Agent continues with the new instructions or tool
```

Skills and MCP tools are deliberately surfaced differently:

- a Skill is instructions and resources, not a callable function schema;
- an MCP tool remains a native callable tool with its real validated schema, annotations, approval handling, and result content;
- MCP resources and resource templates are not implicitly converted into tools or loaded by capability activation;
- Skill instructions cannot weaken the core prompt, workspace access policy, approval rules, or tool error boundary;
- provider catalogs, connection state, active-set changes, calls, results, and errors are persisted as exact events so a resumed task reconstructs the same model-visible world.

Dynamic MCP schemas are appended after the permanent schemas in deterministic public-name order. Skill instructions and goal-specific capability state appear after the stable prefix with the other dynamic goal context. Adding, replacing, or removing a conditional capability never reorders or rewrites the ten permanent tool definitions. It does change the request's tool list, which most providers include in the cached prefix, so an activation or deactivation costs one cache miss on the next request. That cost is accepted: activations are rare, goal-scoped, and usually happen early in a task. Where a provider offers native deferred tool loading that keeps the cached prefix intact, the provider adapter uses it as an optimization; the core never depends on it.

This design takes deferred native-schema exposure from Codex, bounded Skill catalogs and exact on-demand loading from DeepSeek and OpenCode, and OMP's separation between permanent and discoverable tools. It does not copy OMP's `xd://` dispatch transport because hiding an MCP call inside generic read/write would discard native schema visibility, approval identity, and clear tool evidence.

## Corrective tool errors

Helpful, actionable tool errors are a high-priority harness-wide requirement. Every permanent tool and every dynamically activated MCP tool passes through the same normalized error boundary. Each individual tool defines its domain-specific error codes, while the harness guarantees one consistent model-facing shape:

```json
{
  "error": {
    "code": "turn_not_found",
    "message": "Project turn 184 does not exist.",
    "correction": "Use context_retrieve search, or inspect an existing project turn between 1 and 126.",
    "retryable": true
  }
}
```

Rules:

- Expected mistakes such as invalid parameters, missing files, ambiguous edits, unknown references, absent turns, expired terminal sessions, unavailable capabilities, and permission denials return a normal failed tool result in this shape. They do not crash the agent loop.
- `code` is stable and machine-readable; `message` explains the specific failure in plain language; `correction` gives the smallest safe next action; and `retryable` tells the agent whether another call can reasonably succeed.
- Corrections use human-facing paths, names, turn numbers, ranges, or short handles. They never require the model to reconstruct opaque backend identifiers.
- Errors must be truthful and bounded. A tool may show a few valid alternatives or a valid range, but it must not dump a large catalog, transcript, stack trace, or sensitive backend detail.
- Invalid calls have no side effects. A tool never reports partial work as success.
- Unexpected infrastructure failures remain distinguishable from correctable usage errors. They return a safe operational error and are logged with full internal diagnostics, but the model receives no secret values or raw stack trace.
- Provider-native MCP failures are normalized into this contract when possible without discarding the original provider error from the internal execution record.

This contract is implemented once in the shared tool runner and covered by contract tests for every tool. Tool-specific handlers supply facts and recovery hints; they do not invent separate error-envelope formats.

## Why the working agent has no user-question tool

When the agent lacks information that only the user can provide, it asks a concise question as its normal assistant response and ends the current run. The next user message re-enters through the Goal Router and continues the same task.

The Goal Router is the one deliberate exception: it owns the structured `ask_user` tool described in `Goal-router.md`, because routing disambiguation has enumerable candidates and benefits from schema-enforced constructive questions. The working agent's questions are ordinary conversational turns and need no tool.

A structured question tool for the working agent can be added later if the interface needs forms or multiple-choice interactions. It is not necessary for the initial coding loop.

## One agent loop

There is one foreground working agent. It continues until it produces a final response, needs user input, is cancelled, or reaches a configured safety limit.

```text
Send model the working context and available tool schemas
    ↓
Model returns either tool calls or a final response
    ↓
Validate every tool call
    ↓
Execute permitted calls
    ↓
Persist calls and results
    ↓
Append bounded results to the model context
    ↓
Repeat
```

The loop supports multiple tool calls in one model response when the provider supports them and the calls are independent. `read`, `glob`, `grep`, `context_retrieve`, and `capability_search` may run in parallel. `edit`, `apply_patch`, `terminal`, `terminal_control`, `capability_control`, and every MCP tool run one at a time in emitted order, because a shell command or external tool cannot be proven free of side effects. Adjacent parallel-safe calls run together; a serial call is a barrier, so a `read` emitted after an `edit` sees the edit. Results are always returned to the model in the order the calls were emitted, and every emitted call is executed and recorded, even after a cancellation (where it is refused).

A transient provider failure (rate limit, server, or network) is retried twice, after one and four seconds. Any other failure, or a third transient one, ends the turn as interrupted with reason `failed` and an operational warning; nothing partial is presented as an answer.

There is no separate planner agent, answer-writing agent, state-writing agent, or tool-selection agent in the initial architecture. The same Main Coding Agent returns its visible answer and a short hidden continuation note in one final result.

Tool submission order is scoped to each turn. Independent lane turns execute independently, including approvals and foreground terminal calls; a long command or pending approval in one turn cannot block another turn's tools. File mutations still share the workspace lock around their freshness check and write.

## Exact per-turn lifecycle

1. Receive the user message.
2. Persist it exactly.
3. Run the Goal Router described in `Goal-router.md`: it selects the workspace, goal, and task.
4. Bind the turn to the selected goal and task. A goal created without a workspace is bound to the application's workspace when the application supplies one (for example, the folder Socrates was launched in); the binding is permanent. Otherwise the turn runs without a workspace (see "Safety and long-running work").
5. Resolve the goal's frozen Skill shelf and retrieve zero to two likely capability candidates for this turn. (The shelf is frozen per goal; candidates are per turn.)
6. Assemble the working context for that task in the canonical order defined in "Working-agent context."
7. Start the model/tool loop with the ten permanent tools.
8. Let the agent activate a candidate, search for another capability, or use neither.
9. Continue until the model returns a final response or asks the user a question.
10. Require the final message to be one valid `FinalAnswer` (see "Final result"): the visible answer, a short task-local continuation note, an optional goal-note update, an optional task-completion proposal, and optional anchor proposals.
11. Persist those fields and all exact tool evidence.
12. Throughout the loop, attach history per the three-tier policy and, whenever the `160,000`-token trigger is crossed before a model request, compact per the "Context and compaction" section: one history-checkpoint LLM call when completed history lies outside the verbatim window, then mechanical in-turn linearization if still needed. The turn continues naturally. Compaction is strictly task-local; when the trigger would fire for the sixth time in the same chat, the harness performs the automatic rollover described in `Goal-router.md` instead.

## Working-agent context

This is the one canonical layout of every working-agent request. `Goal-router.md` ("Context assembly after goal and task selection") describes how each section's content is selected; it does not define a second layout.

Blocks are ordered from most stable to most volatile, so that the provider prompt cache covers as much of the request as possible. Anything that changes on every turn sits after the history, because a change early in the request invalidates the cache for everything after it.

```text
[STABLE PREFIX — identical for every request]
system prompt · fixed behavioral rules · the ten permanent tool schemas
(dynamically activated MCP tool schemas are appended after the permanent ones)

[GOAL-STABLE — changes only when the goal, its anchors, or its active set change]
<GOAL>
title: Socrates memory system
objective: A memory system that never loses what the user asked for or what the work established.
workspace: socrates
anchors:
- architecture/agent-harness.md — harness architecture and compaction design
</GOAL>

<AVAILABLE_SKILLS>
At most five frozen name-and-description entries.
</AVAILABLE_SKILLS>

<ACTIVE_CAPABILITIES>
Full instructions of Skills activated for this goal, and the names of active MCP tools.
</ACTIVE_CAPABILITIES>

[CHAT HISTORY — frozen or append-only within this task chat]
<HISTORY_CHECKPOINT ref="hc-2" turns="1–9">
summary: Reviewed the memory system and identified the compaction gap.
outstanding_requests:
- turn 3: "Also check whether the recovery path validates source references."
</HISTORY_CHECKPOINT>

[TURN 10]
USER:
Can you review the memory system?

SOCRATES:
The current implementation compacts large tool results...

[TURN 11 — full]
USER:
Why are the memory tests failing?
TOOL CALL read memory/compact.ts (lines 1–120) → full bounded result
TOOL CALL terminal: pytest tests/memory/ → full bounded result
SOCRATES:
Two tests fail because compact_history() drops source_ref...

[TURN-VOLATILE — rebuilt for every user turn]
<GOAL_STATE>
note: Ongoing review and hardening of the memory and compaction system.
open_tasks:
- t3 Preserve large tool results in compaction — active
</GOAL_STATE>

<CURRENT_TASK>
title: Preserve large tool results in compaction
objective: Ensure compaction never loses large tool results.
completion_criteria: Every compacted result stays recoverable through a validated evidence reference, proven by tests.
status: active
note: Reviewed compaction. The remaining concern is preserving large tool results.
</CURRENT_TASK>

<RECENT_ACTIVITY>
Only for the general task: the same ledger-derived notepad the router sees.
</RECENT_ACTIVITY>

<LANES>
Only in the main conversation, when lanes run or recently finished:
lane 2 · working since 14:02 · g3/t1 "Fix flaky tests" in goal "Server" · workspace server
  latest step: terminal: npm test
  note: Two flaky tests isolated; rerunning the suite.
</LANES>

<ACCESS>
Only when the application sets an access policy (see "Access"):
files: /Users/me/acme, /Users/me/notes. Any other path, including the
workspace when it is not listed, asks the user first, who may refuse.
approvals: the user approves each edit, patch, command and changing MCP
call before it runs, and may refuse. Reading and searching need no approval.
</ACCESS>

<EVIDENCE_FROM_PART_1>
Only for a dependent compound part (see "Compound tasks").
</EVIDENCE_FROM_PART_1>

<RETRIEVED_HISTORY>
Older exact exchanges of this task, and at most one strongly related
exchange of another task in this goal, oldest first with their dates.
</RETRIEVED_HISTORY>

<PROJECT_CONTEXT>
anchor architecture/agent-harness.md — harness architecture and compaction design (1509 lines; outline, relevant sections below)
- Context and compaction (line 1032)
- …
--- architecture/agent-harness.md › Context and compaction (lines 1032–1060)
The current text of the sections that matter for this message, and at most
two strongly related sections of other workspace files.
</PROJECT_CONTEXT>

<CAPABILITY_CANDIDATES>
At most one Skill and one MCP hint for this turn.
</CAPABILITY_CANDIDATES>

<CURRENT_USER_MESSAGE>
Can you fix the information-loss problem?
</CURRENT_USER_MESSAGE>

[IN-FLIGHT TURN — native tool calls and results, appended step by step]
```

Rules:

- The current user message appears exactly once and is the final block before the in-flight turn. There is no separate `latest exchange` field because it would duplicate the newest entry in history.
- Goal-stable blocks contain only content that changes rarely: the goal title, objective, workspace, and anchor manifest; the frozen Skill shelf; and the active capability set. A Skill activated mid-turn arrives first as the activation tool result; from the next user turn it and its resource metadata are carried in `<ACTIVE_CAPABILITIES>`, and history always renders the activation call in its one-line linear form so the instructions are never present twice. When compaction rebuilds the context mid-turn, `<ACTIVE_CAPABILITIES>` is rebuilt from the current active set, so a Skill activated earlier in the turn keeps its instructions after its activation step is linearized.
- The tool list is read again after every step: an MCP tool activated mid-turn is callable on the next step, and a deactivated one disappears.
- Chat history follows the three-tier attachment policy in "Context and compaction." It contains at most one active checkpoint—or, in a continuation chat, the handover capsule in the same position—followed by `[TURN k]`-labelled completed turns. Within a turn's tool loop, ordinary steps leave everything before the in-flight turn unchanged. A capability state change updates only the capability block. Deactivated or superseded Skill bodies are removed from in-flight activation rendering as well; exact stored evidence remains retrievable. An intact current activation result carries its body once, and context reconstruction excludes a duplicate body from the prefix.
- Turn-volatile blocks hold everything that is rewritten between user turns: the goal note and open-task index, the task's continuation note, and per-turn retrieval. Each optional block is omitted entirely when empty.
- `<LANES>` appears only in the main conversation, when an open lane is working, waiting, or finished or stopped within the last `24` hours (see "Lanes"). It is a snapshot taken when the turn starts, at most `1,500` tokens. Running lanes take priority, then lanes starting or waiting for an answer, then recently finished lanes. Each entry is bounded so a long note cannot hide other running lanes; omitted lanes are counted.
- `<ACCESS>` appears only when the application sets an access policy. It is taken when the turn starts; the tools apply the policy current at each call, so a change made during a turn applies to its next call.
- `<RECENT_ACTIVITY>` appears only when the turn is bound to the `general` task. It lets Socrates answer an opening "Hi, how's it going?" with a short recap of recent work and an offer to continue it.
- Completed turns are sent as harness-formatted text, so the frozen N−1 rendering stays byte-stable for caching and no provider-specific reasoning content has to be replayed across turns. Only the in-flight turn uses native tool-call and tool-result messages. The block order above is binding either way.
- Everything up to `<CURRENT_USER_MESSAGE>` is one user message made of parts: the goal-stable blocks, one part per completed turn, and the turn-volatile blocks. Part boundaries are where cache breakpoints may fall (see "Prompt caching").
- The general task receives `<RECENT_ACTIVITY>` instead of `<GOAL_STATE>` and `<CURRENT_TASK>`; it has no durable goal state and is never completed, so its `goal_note` and `task_complete` are ignored.
- `<CURRENT_USER_MESSAGE>` holds the user's original message exactly. When the router asked a clarification first, one line after it records the question and the user's answer. In a compound part it still holds the whole message, and `<CURRENT_TASK>` names the part this run handles (`this_turn: part 2 of 2 …`).
- `<PROJECT_CONTEXT>` (at most `3,000` tokens) shows every active and provisional anchor of the goal: one under `1,500` tokens whole, a larger one as an outline of its headings with their line numbers, followed by at most `3` of its sections. Sections are chosen by fusing a keyword ranking with a meaning ranking; both read the message together with the current task's title and continuation note, because a request such as "let's start today's lesson" names no day while the note "Day 9 completed" does. At most `2` sections of other workspace files follow, on a `strong` meaning match against the current request alone (without the task title or continuation note), labelled `related file`. Text is always read from disk when the context is assembled; the index only picks sections, and a vector of content that has changed since it was indexed selects nothing. A missing anchor is reported in one line, and an anchor that may hold credentials (the same patterns the index skips) is named but never shown. Without a workspace, or with nothing to show, the block is omitted.

## Lanes

Socrates is one assistant with one main conversation. Work that should run alongside it goes into a **lane**: a run of the same Socrates, with the same memory, working one task in its own panel. Lanes are not separate chats; every goal, task, note, anchor and Skill is shared, and the ledger records everything once.

- **Where a message goes.** The application chooses per message: the main conversation (the default), a new lane, or an open lane. The main conversation handles one message at a time; a message sent while it is busy is held by the application until it is free ("Queue"). At most `4` lanes run at once; a fifth is refused before anything is recorded. A lane's work is queued, never refused. Accepted messages are recorded once immediately; routing and execution then run in order within the lane, including messages arriving before its first routing decision. Cancellation before a queued message starts leaves its recorded request intact and makes no model call.
- **Routing.** A lane's first message, and an answer to a lane's own clarification, go through the Goal Router like any message; the router sees the main conversation's exchanges and the lane's own, never another lane's, and until the lane has a task its "current" is the main conversation's, where it was started. A lane's later messages continue the lane's task directly, without a routing call. A compound message sent to a lane runs its parts in order inside that lane.
- **"Current" stays per conversation.** The main conversation's current task is the task of its own most recent turn; a lane's turns never change it (`Goal-router.md`, "Workspace resolution").
- **One run per task.** A task is worked by one run at a time. A message for a task that is already running waits for that run to finish its turn. A main-conversation message whose task is queued or running in a lane is handed to that lane: its turn moves to the lane (`turn_moved_to_lane`), it runs there next, and a single-part main message frees the main conversation immediately. A compound main message keeps its main reservation until all of its ordered parts finish, including parts that stay in main. A message handed to a running lane is picked up after the lane's current turn, not in the middle of it.
- **Approvals and cancellation per run.** Each approval request carries its goal, task, turn and lane, so the application shows it in the panel that asked. Anchor confirmations belong to the conversation that asked; unrelated lane activity neither approves nor expires them. Each message has its own cancellation; stopping one lane leaves the main conversation and the other lanes running. Runs of the same goal share its active capabilities; only the first concurrent run resets the goal's capability cache.
- **Shared services.** Runs share the event log, the ledger, the embedding index, the terminal supervisor, MCP connections, and the per-workspace mutation lock; two lanes working in one repository take turns writing, and the stale-edit check stops silent overwrites.
- **The main conversation sees its lanes.** Each main-conversation turn gets `<LANES>`: per lane, its status (working since a time, waiting for the user's approval, waiting for the user's answer to its question, finished or stopped at a time), its task with its `gN/tN` selector, goal and workspace, its latest tool call as one line while it works (queued or cancelled follow-ups never hide an unfinished turn), its continuation note (labelled as from before this run while the lane works), and the start of its answer when it finished. The main conversation answers questions about a lane from it and opens a lane's exact work with `context_retrieve`; a lane's task is worked in that lane. The Goal Router sees the lanes too (`Goal-router.md`, "LANES"), so an instruction for a lane given in the main conversation routes to the lane's task and is handed to it, while a question about a lane's progress goes to the `general` task, which sees `<LANES>` too, and never disturbs the lane. A lane does not see the lanes; its `<CURRENT_TASK>` says which lane it is and, for a message handed over from the main conversation, that the user wrote it there, so "tell the lane to …" is understood as addressed to it.
- **Notices.** A message whose work ran in a lane (sent there, or handed to it) returns `notices`, one line per lane part with that part's own outcome. `notice` is the newline-joined convenience rendering, or null for entirely main-conversation work. A failure in another part never changes a completed lane part to stopped. Examples: "Lane 2 finished: Fix flaky tests — …", "Lane 2 stopped: …", or "Lane 1 needs an answer: …".
- **Lifecycle.** Lanes are numbered for good (`lane_opened`, `lane_closed`); an idle lane can be closed and its history stays in the ledger. After a restart, open lanes return as idle panels with their history. Lane summaries use the host's active turn when available: an empty inactive lane is idle, routing or queued work is starting, and an unfinished turn from a previous process is stopped, never reported as still working. This does not rewrite historical events.

## Compound tasks

A `compound` route creates one stored user turn with multiple ordered work units. Each part is a task (in the goal/task/chat model): part 1 runs in its task, part 2 in its own.

The same Main Coding Agent runs them in order:

1. Assemble the selected task context for part 1 and run its tool loop.
2. Save part 1's exact evidence, updated continuation note, and finalize part 1's ledger entry.
3. Assemble part 2's task context, including only the evidence explicitly passed from part 1.
4. Run part 2's tool loop.
5. Return one visible answer covering both outcomes and save one continuation note for each affected task.

Each part's final answer is stored as that part's response, so every task's history holds only its own answer. The user sees the split acknowledgment followed by one numbered section per part, and the stored exchange shows the parts' answers in order. If a part is interrupted, later parts do not start; they are recorded as interrupted with no tool calls.

The original user message is stored once and linked to every affected task. Socrates does not duplicate the message or merge unrelated task histories.

### Split acknowledgment

Before part 1 starts, the harness renders a one-line acknowledgment of the split, derived mechanically from the router's `parts` array — no LLM call, no extra latency:

```text
Two things here — I'll finish the GitHub issue #42 update first, then run the security review.
```

The user sees the plan the moment routing completes instead of sitting through a silent multi-part run. The agent's single final response then covers both outcomes in clearly numbered sections matching the parts.

### Evidence handoff between parts

What part 2 receives from part 1 is defined by the dependency structure, not chosen freely at assembly time:

- **Independent parts** (`depends_on` empty): part 2 receives nothing from part 1 except the shared original user message. Its goal context is assembled exactly as if the parts ran in separate tasks.
- **Dependent parts** (`depends_on: [n]`): part 2's context gains one bounded `<EVIDENCE_FROM_PART_N>` block, assembled mechanically from part 1's ledger entry:

```text
<EVIDENCE_FROM_PART_1 goal="Investigate GitHub issue #42">
files_changed: src/auth/middleware.ts, src/auth/session.ts
tests: pytest tests/auth/ → 24 passed
note: Reconnect fix implemented; issue update drafted.
evidence: g4/t2/e7 (terminal), g4/t2/e12 (terminal)
</EVIDENCE_FROM_PART_N>
```

The block is built from the ledger entry's derived fields and pointers — the harness selects it, not the model. Each compound part is a task with its own ledger entry, and part 1's entry is finalized when part 1 completes, before part 2's context is assembled — so the handoff always reads a real, finalized entry, never an in-flight one. The block is bounded like any other context block: derived lists at their ledger caps, at most four evidence refs (the part's first call and its last three), qualified as `gN/tN/eM` because they belong to another task, and the continuation note verbatim. Exact expansion of any ref happens through `context_retrieve` under the normal output bounds, so the handoff cannot become an unbounded dump.

The handoff is deliberately one-directional and explicit: part 2 sees what part 1 *recorded*, not part 1's working context. If part 2 needs more, it retrieves it from the event log through its own tools.

## Context and compaction

The persistent event log is the source of truth. The model prompt is a temporary working view.

**Compaction is strictly task-local.** It compresses the history of the current task's chat only; it never summarizes multiple tasks or goals together. Switching tasks is context replacement, not compaction — the new task's prompt is assembled fresh from its own history plus concise goal context. Checkpoint handles (`hc-*`) are therefore scoped to the task's chat chain.

The harness stores:

- exact user and assistant messages;
- tool calls and complete tool results;
- terminal session events;
- file mutations;
- goal bindings;
- the latest continuation note and goal note produced by the Main Coding Agent.

Large tool outputs may be replaced in the active prompt by a short result plus a retrievable reference, but the complete result remains stored.

Every received working-agent response is stored as an `agent_message` event before interpretation or tool execution, tagged `work`, `wrap_up`, or `repair`. This includes intermediate text, invalid candidates, tool-call grouping, usage and native replay content. The accepted visible answer remains a separate `assistant_response`. Turn inspection exposes bounded assistant text; native reasoning/signatures remain internal. Responses that arrive after an aborted await has ended are consumed without changing the finished turn.

### Token budget and trigger points

Compaction is governed by one universal, model-independent budget. The harness does not scale its budget to the served model's context window; a fixed ceiling gives one compaction implementation, one test suite, and consistent cost behavior across providers. Practical agent quality is best between roughly 180k and 250k tokens of context regardless of the advertised window, so a larger window is never used beyond the ceiling.

Every token number in either architecture document is an absolute value under this ceiling. No budget, bound, or allowance is expressed as a percentage of the served model's context window. Consequently, Socrates supports only models whose context window is at least `200,000` tokens, which leaves room for the `180,000`-token ceiling plus output.

| Value | Meaning |
|---|---|
| `180,000` tokens | Hard ceiling. The harness must never send a request at or above this size. |
| `160,000` tokens | Compaction trigger. Measured before every model request in the tool loop. |
| `80,000` tokens | Post-compaction target. Compaction runs until the prompt is at or below this size. |
| `30,000` tokens | Verbatim history window. When layer 1 runs, the newest completed turns up to this size stay exactly as they were attached. |
| `30,000` tokens | Intact in-turn window. When layer 2 runs, the newest tool calls and results of the current turn up to this size stay intact. |
| `20,000` tokens | N−1 attachment budget. Turn N−1 is fitted to this size by the reduction ladder in "Fitting turn N−1"; its user query and final response are always complete. |

The `20,000`-token gap between the trigger and the ceiling is a reserve, the same size the established harnesses keep (OpenCode reserves 20,000 tokens below the input limit, Pi 16,384; Codex compacts at 90% of the window). It absorbs any remaining counting error, such as the first requests to a newly used model before its ratio is calibrated, since the provider's tokenizer can count noticeably more than `o200k` on code. The model's own reply is covered separately by the `200,000`-token minimum window. Raising the trigger toward `170,000` would halve that reserve, so the trigger stays at `160,000`.

The gap between trigger and target is the hysteresis: after compaction, the prompt must grow by at least 80k tokens before the trigger fires again, so compaction never runs on consecutive steps. The harness enforces this directly: the next compaction of a turn waits until the request has grown by the trigger–target gap beyond the size the last compaction produced. A compaction that could not reach the target therefore does not fire again on every step.

All of these values are one configurable budget object (`trigger`, `target`, `ceiling`, `verbatimWindow`, `intactWindow`, `previousTurn`, the `8,000`-token checkpoint and capsule bound, the `8,000`-token `<RETRIEVED_HISTORY>` bound, and five compactions per chat). Production uses the values above; tests and evaluations shrink them so compaction happens within a few cheap turns.

Token counting uses one harness-standard tokenizer for every model: `tiktoken` with the `o200k` encoding. Budgets that shape the prompt—the verbatim window, the intact in-turn window, the N−1 budget, and the per-result ceiling—are measured with it directly. They need only be consistent, not exact. Byte-pair encoding is superlinear in the length of a single unbroken run, so runs of 64 or more non-space characters (a progress bar, padding, a long URL) are encoded in 32-character pieces split at code-point boundaries. The cost stays linear and decoding stays exact. Text without such runs is counted exactly; a long run is over-counted, which is the safe direction for every budget (measured: about 1% for base64, up to 25% for long URLs, up to 2× for one repeated character).

The safety-critical decision is whether the next request crosses the `160,000`-token trigger or the `180,000`-token ceiling. That measurement is calibrated against the provider's own count, without any provider-specific tokenizer:

- Every provider reports token usage for each request. The provider adapter normalizes it into one number: total prompt tokens, including cache-read and cache-write tokens.
- After each response, including invalid compactor candidates, the harness records the ratio between that provider count and the `o200k` count of the same request, smoothed per model. Worker and compactor calls share this calibration map, with separate ratios for different model IDs. The full next request is remeasured before every summarizer attempt, including the prior reply, native replay content and validation errors on retry.
- Before each request, the measured size is the `o200k` count multiplied by that ratio. Until the first response for a model arrives, the ratio is `1.0` and the `20,000`-token reserve described above absorbs the difference.

This is one code path for every provider. Supporting a new provider adds no tokenizer, only the usage normalization the adapter already performs. OpenCode and Pi likewise trigger compaction on provider-reported usage.

### When compaction runs

Compaction is synchronous and runs mid-turn, between tool execution and the next model request. This is the primary case, not the edge case: a long turn crosses the trigger on its twelfth or eightieth tool result, and the turn must continue naturally afterward. Compaction is never a background job and never defers to the next turn.

The unit being measured is the full next model request: stable prefix, history, capability context, and the current in-flight turn with all tool calls and results so far.

### Three-tier history attachment

History attaches to the working prompt in three tiers. This policy decides the *shape* of each turn on every request; it does not impose a size cap. Until the compaction trigger fires, every completed turn of the current task chat is attached in its tier shape. Size is managed only by compaction.

1. **Current turn (in flight).** Everything: the full user query, full tool calls, and full bounded results. This is the agent's active working state.
2. **Turn N−1 (just completed).** The full user query, its tool calls with their results, and the full final response, fitted to the `20,000`-token N−1 budget. The previous turn is the most likely referent of the next user message, so its working evidence stays in view. When the full rendering is larger than the budget, only the large or reproducible parts are reduced, step by step, as described in "Fitting turn N−1" below.
3. **Turns N−2 and older.** The full user query and full final response only. No tool calls and no tool results. Tool evidence remains in the event log, reachable through `context_retrieve`.

#### Fitting turn N−1

When a turn completes, it is rendered as N−1 until it becomes N−2. The rendering is computed from the event log alone and is deterministic, so the same turn always yields the same text and stays cache-stable without storing a copy. If the full rendering fits the `20,000`-token budget, it is used unchanged. Real working turns are often larger: a turn with three reads, two edits, two searches, and a test run is typically 25–35k tokens in full. Reduction is therefore graduated, never all-or-nothing. The harness applies these steps in order and stops as soon as the turn fits:

1. **Collapse what is reproducible or stale.** These calls become one line in the linearization grammar, with their evidence handle:
   - `edit` and `apply_patch`, because the change is already on disk: `TOOL CALL [e12] edit memory/compact.ts (+3 −1)`;
   - a `read` of a file that a later call in the same turn modified, because its content is out of date;
   - `glob`, `grep`, `context_retrieve`, `capability_search`, `capability_control`, and `terminal_control` calls, as one line with their counts or outcome;
   - `terminal` commands that succeeded, as one line with the exit status and the final output line.
2. **Trim the largest remaining results evenly.** The harness computes one cap such that every remaining result larger than the cap is cut to it and the turn fits; smaller results are untouched. Reads keep the beginning of their window; failed commands keep their head and tail. Each trimmed result states what was cut and carries its evidence handle. The cap never goes below `1,500` tokens.
3. **Collapse the oldest remaining calls.** Only if the turn still does not fit with every result at the floor, the oldest remaining calls are collapsed to one line, oldest first, until it fits.

In the rendering, a full call is its `TOOL CALL [eN] tool {input}` line followed by its bounded result; a trimmed result's cap includes its omission marker. A turn that ended without an answer shows that instead of a response, for example `(The user stopped this turn after 14 tool calls; no answer was given.)`, so the next turn never mistakes it for finished work. A turn stopped while its answer was being written shows that text followed by `(The user stopped this turn after 14 tool calls, while this answer was being written; it is incomplete.)`, so "go on" can pick up from it.

The user query and the final response are never reduced. Oversized user messages are already bounded at ingestion.

Example: three reads of about 9k tokens each, two edits, two greps, and a passing test run total about 35k. Step 1 collapses the edits, greps, and test run into five lines (about 0.3k). Step 2 trims each read to about 6k. The turn fits within 20k with all three reads still largely visible.

The order reflects what the next message usually needs. Edits are already reflected in the files, searches and passing commands can be repeated cheaply, while what the agent read and what failed are the evidence a follow-up most often builds on. Every collapsed or trimmed call remains one `context_retrieve` `inspect` away.

Dropping tool activity from older turns is deliberate. Their final responses carry what the work established, re-sending every historical tool call and result wastes most of the context, and the agent works better without that noise. Nothing is lost: every attached turn carries a visible `[TURN k]` label with its permanent `project_turn` number, and that label is a requirement, not decoration. It is what lets the agent call `context_retrieve` `inspect` with `turn_number: k` to recover that turn's exact tool calls and results whenever it needs them.

Complete Q&A pairs are always attached whole; a user query is never separated from its final response. Obligation continuity does not depend on keeping every historical message forever: when compaction runs, the checkpoint's `outstanding_requests` field extracts every unanswered request verbatim, and those quotes remain visible in the prompt until resolved. Oversized user messages (for example, a pasted specification) are already handled by bounded ingestion at entry time.

### Layer 1: history checkpoint (one LLM call)

When the trigger fires, the harness first compacts completed history:

1. Starting with turn N−1 and walking backward, keep the newest complete turns, in the exact shape they were attached, while they fit within the `30,000`-token verbatim history window. N−1 counts at its attached size. The window is turn-atomic: a turn that does not fit whole is not kept.
2. Every completed turn older than the window, together with the prior active checkpoint when one exists, becomes the compacted span.
3. The compacted span is sent to one dedicated compactor model call, which produces the new history checkpoint.

This is the only LLM call compaction ever makes; it is a bounded request, not a second agent. The compactor is the working agent's model unless the application configures another: copying unanswered requests verbatim out of a long span needs the stronger model. A span that would itself reach the ceiling is not sent; the mechanical fallback below applies.

History is a property of the task, not of one chat: it is the newest checkpoint or capsule followed by every ended turn of the task after the turns it covers, across the task's chain of chats. Turns omitted by a failed compaction (below) are part of the next span even though they are not shown.

Layer 1 is skipped when there is no completed turn older than the verbatim window—for example, during the first turn of a task chat, or when the first long turn is still in flight. The trigger then proceeds directly to layer 2.

#### Compactor input contract

The harness sends the compactor structured, turn-numbered input. Every Q&A pair is wrapped in an explicit turn marker using the permanent `project_turn` number—the same numbering `context_retrieve` uses, never renumbered:

```text
<COMPACTED_SPAN turns 1–10>

[TURN 1]
USER: Here are 10 questions I need help with: (1) ... (2) ... (3) ...
SOCRATES: Starting with question 1: ...

[TURN 2]
USER: next one
SOCRATES: Question 2: ...

[PRIOR CHECKPOINT ref="hc-0" — included only when one exists]
outstanding_requests:
- turn 1: "(7) How do I handle the edge case where..."
</COMPACTED_SPAN>
```

Each turn of the span also lists its tool activity in the one-line grammar of layer 2, at most thirty lines, so the compactor sees the files, commands, and evidence handles it may cite in `key_evidence`.

The prior checkpoint, when present, is always part of the input so the compactor can carry its unresolved obligations forward and check them against the newer turns. Turn numbers flow straight through into the output: the model copies them from the labeled input and never invents numbers.

#### Checkpoint schema

The compactor returns strict structured output validated against one predefined schema:

```ts
const HistoryCheckpoint = z.object({
  summary: z.string(),        // narrative of what happened across these turns
  turns_covered: z.object({
    from: z.number(),         // project turn number
    to: z.number(),
  }),
  progress: z.string(),       // verified accomplishments
  decisions: z.array(z.object({
    decision: z.string(),
    rationale: z.string(),
  })),
  constraints: z.array(z.string()),      // user preferences and rules that must persist
  files_touched: z.array(z.string()),    // deduplicated paths
  open_threads: z.array(z.string()),     // unresolved work mentioned but not done
  outstanding_requests: z.array(z.object({
    turn: z.number(),      // project turn where the request was made
    quote: z.string(),     // VERBATIM quote of the unanswered request
  })),
  more_outstanding_turns: z.array(z.number()).optional(), // turns of unanswered requests beyond the ten quoted
  next_steps: z.array(z.string()),
  key_evidence: z.array(z.object({
    ref: z.string(),          // e-style handle into the event log
    note: z.string(),         // one line: what this evidence shows
  })),
})
```

`outstanding_requests` is the obligation carrier. It exists because a user message may contain a list of requests ("here are 10 questions") that are answered across many later turns; when compaction compresses those turns, the remaining unanswered items must survive verbatim or the agent forgets its own task list. Rules:

- A request is outstanding if no subsequent turn in the compacted span fully addressed it, or if it was carried forward as outstanding from the prior checkpoint and remains unresolved.
- The quote is copied verbatim, never paraphrased. For a partially answered message, the granularity is the unanswered sub-request, not the whole message.
- Hard bounds: at most `10` entries, each quote at most `200` tokens, aggregate at most `2,000` tokens. If more than 10 exist, the turns holding the rest are listed in `more_outstanding_turns`, and the prompt tells the agent to read those turns with `context_retrieve inspect turn_number`.
- The next compaction's compactor receives the prior checkpoint, resolves entries that newer turns answered, and carries the rest forward. Obligations survive chained compactions until genuinely done.

The schema is flat, all-required, and one level deep for structured-output reliability across providers. The compactor prompt instructs it to preserve exact identifiers—paths, test names, error strings—verbatim inside string fields and never paraphrase them.

#### Checkpoint handles, chaining, and goal scoping

Every checkpoint is stored in the event log and receives a short handle such as `hc-3`. Handle rules:

- **Handles are backend-assigned.** The compactor model produces only schema content; the harness assigns the handle at storage time, exactly like `r1` and `e1` handles. The model never generates or needs to know its own checkpoint's handle.
- **Handles are task-scoped.** `hc-5` always means checkpoint 5 of the current task's chat chain. The working prompt is always assembled for exactly one task, so resolution is unambiguous. A handle from another task fails with a corrective error directing the agent to search again.
- **Checkpoints chain and supersede.** When compaction fires again later, the existing checkpoint is part of the old history being compacted; the new checkpoint absorbs it, and its `turns_covered` range subsumes the old one. Superseded handles remain resolvable in the event log but leave the prompt. The working prompt contains at most one active checkpoint.

The agent can resolve any checkpoint handle through `context_retrieve` under the same bounded output policy as any other evidence reference. A capsule may carry obligations newer than its historical coverage; a subsequent checkpoint retains those citations without widening its covered range. Carried obligations outside the newly compacted span must remain quoted or explicitly referenced in `more_outstanding_turns`, because the span cannot establish that they were resolved. New out-of-range citations are rejected.

#### Resolution ladder

Checkpoint content is coarse by design; detail is recovered by walking down three rungs:

```text
Active checkpoint (in the prompt, always present, coarsest)
  → superseded checkpoints (inspect hc-1, hc-2, ...; finer-grained)
    → evidence refs (inspect e-*; the exact raw events)
```

The active checkpoint needs no inspection—it is already verbatim in the prompt. Inspection exists for superseded checkpoints and evidence drill-down: when the active summary compressed away a needed detail, the agent inspects an earlier checkpoint, or more commonly follows a `key_evidence` ref directly to the exact underlying event. The harness validates that a checkpoint's `turns_covered` range and cited turn numbers match the input it was built from, so a checkpoint can never claim coverage it does not have.

The harness validates every checkpoint before storing it: the schema; `turns_covered` exactly equal to the span it sent (from the prior checkpoint's first turn, or the span's first turn, to the span's last turn); every outstanding quote found verbatim in the user text of the cited turn, which must be a turn of this task inside the range (only whitespace and quote style may differ), or an exact carried quote from the prior checkpoint/capsule through the current turn; every `more_outstanding_turns` entry likewise, including turns already carried as quotes or overflow references; every `key_evidence` ref resolving to stored evidence (`eN` of this task, or a qualified `gN/tN/eM`); and the rendered checkpoint at most `8,000` tokens. Checkpoints and capsules are stored as `history_record_created` events under task-scoped `hc-N` handles; `context_retrieve inspect hc-N` returns the exact stored content and whether it is still the active one.

If the checkpoint call fails or returns invalid output, the harness retries once, sending the exact validation errors back, and then falls back to purely mechanical trimming, recording an operational warning and a `history_omitted` event for the span. Compaction never blocks the turn on a failing compactor. The mechanical fallback still protects obligations and makes the gap visible:

- the prior active checkpoint, when one exists, stays in the prompt unchanged, so its `outstanding_requests` remain visible verbatim;
- the turns of the compacted span leave the prompt and are replaced by one omission marker such as `[TURNS 11–25 OMITTED — compactor unavailable; use context_retrieve inspect turn_number to recover them]`;
- the next successful compaction receives the omitted span again as part of its input, so its obligations are extracted then.

### Layer 2: in-turn linearization (mechanical, no LLM)

If the prompt is still above the target after the history checkpoint—or layer 1 was skipped because no completed history lies outside the verbatim window—the harness compacts inside the current turn. This layer is purely mechanical: older tool calls are rewritten into one-line activity entries. No model call, no schema, no latency, fully deterministic. The current user query itself is never linearized or summarized.

This is how a single enormous turn is handled. When the first message of a task drives sixty tool calls and crosses the trigger, there is no history to checkpoint; the turn itself is made lean by linearizing its older calls while the newest work stays intact.

Walking backward from the newest model step, steps (one model response with all of its tool calls and their results) stay intact while they fit within the `30,000`-token intact in-turn window. The newest step always stays intact, even when it alone is larger, because it holds the results the agent is about to use; linearizing it would only make the agent fetch them again. Every older call is linearized with one bounded line, and the lines are placed together in one block right after `<CURRENT_USER_MESSAGE>`, so the in-flight turn reads as the user's request, the linearized earlier activity, then the newest intact steps:

| Tool | Linear form |
|---|---|
| `read` | `read src/server.ts (lines 501–912)` |
| `glob` | `glob src/**/*.ts → 47 matches` |
| `grep` | `grep "source_ref" → 12 matches in 4 files` |
| `edit` | `edit memory/compact.ts (+3 −1)` |
| `apply_patch` | `apply_patch → 2 files changed` |
| `terminal` | `terminal: pytest tests/memory/ → 2 failed (assert source_ref is None)` |
| `terminal_control` | `terminal_control wait dev-server → ready` |
| `context_retrieve` | `context_retrieve search "compaction" → 3 results` |
| `capability_control` | `capability_control activate github.get_issue → activated` |

Rules for the grammar:

- The call input (command, path, pattern) is verbatim; the outcome is one bounded clause.
- For failures, the first error line is included because that is the signal the agent needs.
- Every line carries the evidence handle for that call, written as `TOOL CALL [e14] tool …`. Everything else—the complete input and the complete result—is behind that handle and resolvable through `context_retrieve` `inspect`.

Linearization reduces a hundred-call turn from potentially 80–150k tokens to roughly 3–4k. It is lossless where it matters—inputs stay exact—and it works because tool outputs are already bounded at ingestion (see below). A representative linearized block:

```text
[TURN 12 — earlier tool activity of this turn, linearized; context_retrieve inspect recovers each handle]
- TOOL CALL [e10] read memory/compact.ts (lines 1–120 of 340)
- TOOL CALL [e11] terminal: pytest tests/memory/ → exit 1 · last line: "2 failed"
- TOOL CALL [e12] edit memory/compact.ts (+3 −1)
- TOOL CALL [e13] edit memory/rebuild.ts (+2 −0)
- TOOL CALL [e14] terminal: pytest tests/memory/ → exit 0 · last line: "24 passed"
```

The same grammar renders the calls that "Fitting turn N−1" collapses in tier 2 of history attachment.

Linearization runs only when the trigger fires, never proactively on every step. Rewriting earlier calls on each step would change the middle of the prompt on every request and invalidate the provider prompt cache each time; trigger-based linearization changes it once per compaction.

### Bounded ingestion

Every tool result is bounded when it enters the prompt, before any compaction decision. No unbounded content ever enters the working prompt, which is what guarantees that layer 2 can always reach the target mechanically.

One universal ceiling applies to every tool, permanent or MCP: a single result may place at most `10,000` tokens in the prompt. This matches what the established harnesses converged on: Codex caps tool output at 10,000 tokens, OpenCode and Pi cap it at 2,000 lines or 50 KB (roughly 12,000 tokens), and Claude Code inlines about 30,000 characters of shell output and up to 25,000 tokens of MCP output. Smaller caps such as 2,000 tokens force the agent to page constantly through ordinary source files; larger ones let a few results flood the context.

Within that ceiling, each tool bounds its output in the way that keeps the most useful part:

| Tool | Shape at the ceiling | Where the rest is |
|---|---|---|
| `read` | A window of whole lines from `offset`; `truncated: true` with `next_offset` | The file itself; the agent reads the next window |
| `glob`, `grep` | The first matches in stable order; each matched line cut at `500` characters | `next_cursor` continues the exact result set |
| `terminal`, `terminal_control read` | Head and tail of the output with an explicit omission marker, because errors and summaries usually sit at the end | The terminal session's retained output, read by cursor |
| `edit`, `apply_patch` | A bounded diff | The complete mutation in the event log |
| `context_retrieve` | Its own prioritized bounded view (see "`inspect`") | Further `inspect` calls on the returned handles |
| MCP tools and anything else | The head of the result with an explicit omission marker | The complete result in the event log, under an evidence handle such as `e9` |

Rules:

- Truncation is always explicit. The model-facing result states what was omitted and exactly how to get it: a `next_offset`, a `next_cursor`, a terminal cursor, or an evidence handle that `context_retrieve` `inspect` resolves. Nothing is silently dropped.
- The complete result is always stored in the event log, whatever reaches the prompt.
- Token counts use the harness-standard tokenizer defined in "Token budget and trigger points".

### Atomicity invariants

Compaction boundaries are constrained by two hard correctness rules:

1. **History cuts are turn-atomic.** The history checkpoint's input is always a whole number of complete Q&A turns. Never a user query without its response, never a response without its query, never a partial slice. The verbatim history window is turn-atomic in the same way, and the N−1 turn is atomic: it is either present in its tier-2 shape or fully compacted into the checkpoint, never split.
2. **In-turn cuts are pair-atomic.** A linearization boundary never falls between a tool call and its tool result. Every provider API rejects a result without its call, and parallel tool calls emitted by one model response must stay together with all of their results. Cuts happen only at balanced points where every emitted call has its result.

Both invariants are enforced by the harness during input selection, not by the compactor model, and both are covered by contract tests.

### Post-compaction prompt shape

After a full compaction, the next model request is:

```text
[stable prefix: system prompt + rules + ten tool schemas]   ← never touched

[goal-stable blocks]                                         ← unchanged by compaction

<HISTORY_CHECKPOINT ref="hc-3" turns="1–8">
Structured checkpoint output: summary, progress, decisions, constraints,
outstanding_requests (verbatim, turn-cited), next_steps, key_evidence.
</HISTORY_CHECKPOINT>

[TURN 9]                                                     ← verbatim window, Q&A only
USER: ...
SOCRATES: ...

[TURN 10]
USER: ...
SOCRATES: ...

[TURN 11 — full]                                             ← N−1, verbatim window
USER: Why are the memory tests failing? Fix them.
TOOL CALL read memory/compact.ts (lines 1–120) → full bounded result
TOOL CALL terminal: pytest tests/memory/ → full bounded result
TOOL CALL edit memory/compact.ts → full bounded result
TOOL CALL terminal: pytest tests/memory/ → full bounded result
SOCRATES: Two tests failed because compact_history() dropped...

[turn-volatile blocks]

[CURRENT TURN 12 — managed per layer 2]
USER: Run them again with verbose output.
... newest tool calls intact, older calls linearized ...
```

Turns older than the verbatim window become one checkpoint artifact, the newest ~30k tokens of completed turns stay exactly as they were attached (N−1 with its full tool activity), and the current turn is managed in place. The block order follows the canonical working-agent context in "Working-agent context". The active checkpoint's `outstanding_requests` stay visible in every subsequent request until the next compaction resolves or re-carries them, so a multi-part request made turns ago is never forgotten. Each artifact carries its reference handle, resolvable through `context_retrieve`.

### Failsafe

If the prompt is still above the target after layer 1 and layer 2—which bounded ingestion makes effectively unreachable—the harness applies, in order and only as far as needed: the intact window halved, then quartered, down to the newest step alone; turn N−1 refitted to `4,000` tokens; and the newest step's results hard-truncated (head and tail, never below `1,000` tokens each, each naming its evidence handle). It records the failsafe and, if the target is still not reached, an operational warning. The `180,000`-token ceiling remains the final gate: it never silently sends an over-budget request and never pretends the context is smaller than it is.

### Compaction count and rollover

Each time the `160,000`-token trigger fires inside a task chat counts as exactly one compaction, whether it ran layer 1, layer 2, or both. The count belongs to the chat, not the task.

A chat holds at most five compactions. When the trigger would fire for the sixth time in the same chat, the harness performs the automatic task rollover described in `Goal-router.md` ("Task rollover") instead of compacting: it writes a handover capsule, closes the chat, and continues the same task in a linked continuation chat whose count starts at zero.

Each compaction is a `compaction_recorded` event (its layers, the checkpoint it wrote, and the sizes before and after) that advances the chat's count; a rollover is a `chat_closed` event plus the continuation's `chat_opened`, and is not itself a compaction. Rollover happens wherever the trigger fires, which is usually between two steps of a long turn. The turn that was in flight stays recorded under the closed chat, and it continues immediately in the new context: the capsule, the verbatim window, and the turn's own work with older calls linearized. Because history is built across the task's chain of chats, the next turn still sees that turn even though it lives in the old chat. The application receives one quiet status line, "Refreshing this long task's context…". A long task therefore appears in Standard view as a chain of chats: chat 1 holds compactions 1–5, chat 2 holds compactions 6–10, and the eleventh compaction-level trigger starts chat 3.

### Continuity guarantees

Compaction never rewrites or deletes the underlying event log. It changes only what the next model request sees. The verbatim history window and the current user message remain exact, the checkpoint and continuation note carry everything older, and every omitted detail remains retrievable through `[TURN k]` labels, checkpoint handles, and evidence handles. Compaction keeps what is owed visible; `context_retrieve` recovers anything exact. Together they are how Socrates never forgets.

Obligations receive special protection: unanswered user requests survive compaction verbatim inside `outstanding_requests`, are visible in every subsequent request, and are carried forward across checkpoint generations until resolved. Compaction can compress what happened; it can never silently drop what is still owed.

## Final result

The Main Coding Agent ends every run with one final message that has no tool calls. That message must always be a single JSON object matching one schema:

```ts
const FinalAnswer = z.object({
  full_answer: z.string(),                    // the response shown to the user
  continuation_note: z.string(),              // ~100 tokens, task-local
  goal_note: z.string().nullable(),           // ~150 tokens; null when the goal's durable state did not change
  task_complete: z.object({ reason: z.string() }).nullable(), // null while the task continues
  anchors: z.array(z.object({ path: z.string(), role: z.string(), reason: z.string() })),
})
```

`full_answer` comes first so that, once responses stream, the user starts reading immediately while the short hidden fields are written after it. A question to the user is an ordinary final answer: `full_answer` holds the question.

The object is the whole text of the final message. Providers cannot combine forced structured output with tool use uniformly, so the harness parses it itself: the message as JSON, or one code fence wrapping the entire message, or its first `{` to its last `}`. Code fences inside `full_answer` belong to the answer and never delimit the object.

The harness validates the object with Zod and its token bounds. The bounds are hard and equal the ledger's: `continuation_note` at most `100` tokens and `goal_note` at most `150`, so nothing is silently truncated when stored. At most three anchor proposals are accepted. An invalid or missing object gets one repair request that states the validation errors and forbids tool calls; if that also fails, the harness keeps the model's visible text as the answer (the `full_answer` string when a malformed object still contains one), writes a mechanical continuation note, records an operational warning, and persists nothing else from that output. No other final-response shape is accepted.

A returned-but-invalid repair and a failed provider request are distinct: a provider failure interrupts the turn and never presents a partial candidate as the answer. Any native calls unexpectedly returned during wrap-up or repair are recorded as refused; their accompanying JSON cannot update state. Cancellation is checked again after responses and before final persistence. Accepted answers, anchor changes and turn completion are persisted in one transaction.

The continuation note is not a second visible answer and is not produced by another agent. It is task-local and bounded (about 100 tokens): the task's verified progress, unresolved work, and important constraints.

The goal note is the only goal-level state the agent writes. It records the goal's durable state across tasks: overall progress, durable user constraints and preferences, and what the goal is heading toward. The agent supplies it only when that durable state changed during this turn. It is bounded (about 150 tokens), validated by the harness, and stored as a new append-only revision of the goal record; it appears in `<GOAL_STATE>` and in the router's `KNOWN_GOALS`. The Goal Router never writes it.

The task-completion proposal (`task_complete`, with one short reason) is recorded by the harness and can always be overridden or reopened by the user — the user has the final say. Anchor proposals (`anchors`, for example `{ "path": "learning/30-day-plan.md", "role": "goal_plan", "reason": "Defines the lesson sequence for this goal." }`) follow the anchor lifecycle in `Goal-router.md`.

A null completion proposal leaves task status unchanged. Only the router's explicit `reopen_task: true` reopens completed work; a historical question must preserve completion.

## Images

A model that can see is shown images; one that cannot is never sent one, and is told so instead of being left to guess.

- **Which models can see.** Every Claude and Gemini model, and OpenAI's GPT-4o, GPT-4.1, GPT-5 and o-series models. DeepSeek and OpenRouter differ by model (DeepSeek Flash and GLM 5.3 Flash can; DeepSeek V4 Pro cannot), so the server asks their model lists, which state each model's input modalities, when it builds the chat model; a failed lookup means no. The client carries the answer as `vision`, and status reports it.
- **In the contract.** A user message and a tool result may carry `images` (base64 PNG, JPEG, GIF or WebP). Anthropic receives them as image blocks, before the user's text and inside the tool result. Gemini Interactions receives them as image content beside the text, in the user's input and in the function's result. OpenAI-compatible APIs accept only text in a tool message, so the images of a run of tool results follow it as one user message that names the call each came from.
- **`read` on an image** (by its file ending, confirmed by its header) returns one line naming it, such as `shots/a.png — image, 1280×720 PNG, 45 KB, shown below.`, with the image for a model that can see. For one that cannot, the line says the content is unknown and must not be guessed. An image over `5` MB is refused with a correction to make a smaller copy (`sips -Z 1600` on a Mac). The tool's recorded result holds the path, format, size and whether it was shown, and the file's hash is observed; the image's bytes are never stored, since the file is.
- **Attached images.** A message may carry up to ten images the user attached (`server.md`, "Attachments"); the saved message keeps each one's name and stored path. A model that can see is shown them with the message, on every request of the turn, also after a compaction. The message, wherever it is shown to a model (the current message, and every later turn's history), is followed by one line per image with its path, name and size, so a later question about "the second image I sent" finds its path and reads it again. `read` may always open a file in the attachments folder by its absolute path, read-only, though it lies in Socrates' protected data; no other tool can. The router sees `<CURRENT_ATTACHMENTS>` with the images' names, and their names in recent history; memory search indexes each image's name and path with its exchange, and inspecting a turn with `context_retrieve` lists its `attached_images`. A message may be only images, with no text: its saved text stays exactly what was sent (empty), and models are told so in its place: the agent sees "(The user sent no text, only the images below.)" before the image lines, now and in later history, and the router sees "(No text: the user sent only the images in CURRENT_ATTACHMENTS.)" as `CURRENT_USER_MESSAGE` and continues the current task with it, or `general` when there is none (`Goal-router.md`, "CURRENT_USER_MESSAGE").
- **Screenshots from MCP tools** work the same way as `read`: shown with the result, never stored (the recorded result says how many images and whether they were shown). Many of them add up, so once a turn holds more than `8` images in tool results, the oldest are dropped down to `4`, each result keeping its text and a note that its image is no longer shown; the drop happens a batch at a time so the cached start of the conversation changes once in a while rather than at every screenshot.
- **In the context.** An image is shown only within the turn that read it, on every step of that turn. Later turns see the text line in their history and read the file again to look. Each image counts as `1,600` tokens before calibration, so the compaction trigger never underestimates a turn full of images.

## Provider independence

The harness owns one normalized internal contract:

- system and user messages;
- assistant text and reasoning metadata where available;
- JSON-Schema-compatible tool definitions;
- tool calls and tool results;
- streamed text (below);
- token usage;
- cancellation and provider errors.

Each provider adapter translates between this contract and its API. Goal routing, compaction, permissions, tool execution, and persistence never import provider-specific SDK types.

**Streaming.** A request may carry `onText`; the adapter then streams the reply from its provider and calls `onText` with each piece of text as it arrives. The result is the same complete response a plain request returns, rebuilt from the stream: its text, tool calls, usage and the provider's raw content, so a streamed reply continues a conversation exactly as a plain one does. Each adapter rebuilds its own native form: Anthropic's SDK accumulates content blocks; the OpenAI-compatible adapter joins text, tool-call arguments and every provider field itself (DeepSeek's `reasoning_content`, OpenRouter's `reasoning_details`, merged by index), because the replay depends on them whole; Gemini Interactions assembles its steps from the step events, signatures included, since its completion event carries only status and usage. Tool calls are not streamed to the caller: they are acted on once complete. A request without `onText` is not streamed, which is what routing and compaction use. A streamed request fails after 60 seconds without receiving anything (rather than 60 seconds in total), and a stream that is cut off or ends early is a transient `network` failure like any other, so the loop retries it. A retry starts the text again from its beginning.

**Drafts.** The working agent streams every request of a turn (work, wrap-up and repair) and reports a draft after each piece: the readable text so far and the number of the model request it belongs to (counted from 1 within the turn; a retry or a repair is a new request). A draft is `narration` (any text that is not the start of a JSON object, such as the line before tool calls) or the `answer`: the final message is one JSON object whose `full_answer` comes first, so the draft is that string decoded as far as it has arrived, holding back an escape (`\n`, `\"`, `\u00e9`, a surrogate pair) until it is complete, and never showing the other fields. Drafts are only reported, never saved, and a watcher that throws cannot disturb the turn; the saved response, narration or answer replaces them. A tool call that prints while it runs reports `output` drafts too, with its evidence `handle` and the newest of what it printed ("terminal").

**Thinking.** A streamed request may also carry `onReasoning`, which receives the model's readable thinking as it arrives, and the response carries it as `reasoning`. It is for display only: what a provider needs to continue (signed or encrypted reasoning) travels in the raw content, and `reasoning` is never sent to a model. DeepSeek streams `reasoning_content`, OpenRouter `reasoning`, Anthropic its thinking blocks, and Gemini Interactions summaries of its thoughts, which are requested (`thinking_summaries: "auto"`) only when someone shows them and are kept on the thought step as a plain reply has them. OpenRouter sends the same thinking twice, as the `reasoning` string and as `reasoning_details` (`reasoning.text`, or `reasoning.summary` for OpenAI models beside an unreadable `reasoning.encrypted` part); the details count only when the string is missing, so a trace is shown once and whole. A model whose thinking is optional on OpenRouter (DeepSeek V4 Flash, Claude Haiku 4.5) returns none unless the request asks for it, which a thinking level does (`reasoning: { effort }`); a model that always thinks returns it either way. A level also turns on Anthropic's adaptive thinking with its readable summary (`thinking: { type: "adaptive", display: "summarized" }`), since current Claude models otherwise return empty thinking blocks and some do not think at all without it. A model that does not show its thinking simply has none. The working agent reports thinking as a third kind of draft, `thinking`, with its own text beside the reply's narration or answer, and the saved model reply (`agent_message`) keeps it.

**Thinking levels.** A request may name an `effort`, how hard the model thinks, in one vocabulary for every provider: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` (shown as "Extra high") and `max`. Each adapter asks its provider in its own words:

| Provider | A level | `off` |
|---|---|---|
| Anthropic | `output_config.effort` | `thinking: { type: "disabled" }` |
| OpenAI | `reasoning_effort` | `reasoning_effort: "none"` |
| Gemini | `thinking_level` | not offered: its thinking cannot be turned off |
| DeepSeek | `reasoning_effort` | `thinking: { type: "disabled" }` |
| OpenRouter | `reasoning: { effort }` | `reasoning: { enabled: false }` |

A request without a level uses the client's own default: `low` for Gemini and DeepSeek, as before, and the provider's default elsewhere. The router never names one, so routing keeps those defaults. Which levels a model accepts comes from the providers' own model lists (`detectEfforts`): DeepSeek lists each model's levels (and every DeepSeek model can also answer without thinking); OpenRouter lists each model's levels, its default, and whether its thinking is mandatory, which decides `off`. OpenAI, Anthropic and Gemini do not list levels, so their models are looked up in OpenRouter's public list under the provider's prefix (`claude-opus-5-5` is `anthropic/claude-opus-5.5`). So Claude Haiku 4.5 has no levels, Opus 5.5 cannot stop thinking, and OpenAI's `none` is `off`. Socrates' default for a model is `low` where Gemini or DeepSeek accept it, otherwise the model's own. A model whose levels cannot be found has none to choose, and keeps its client default. Model lists are kept for ten minutes; a failed lookup is not kept.

The server chooses the chat model's level: the user's choice when the model accepts it, otherwise Socrates' default. It is read when each request is sent, so a new level applies to the next request of a running turn without a rebuild (`server.md`, "Settings"). Thinking counts toward a reply's output tokens, so a streamed request (the working agent's) at `high` may write up to `32,000` tokens and at `xhigh` or `max` up to `64,000`, never more than the model's own limit from the same lists; without a known limit it keeps `16,000`. A reply cut off while still thinking has neither text nor tool calls, and is replayed with empty text rather than none, which DeepSeek would refuse.

Provider-specific features are optional optimizations. The harness must still work when a model supports only ordinary messages and function calling.

## Prompt caching

The cacheable prefix remains stable:

1. core system prompt;
2. fixed behavioral rules;
3. the ten permanent tool schemas in a fixed order.

Everything after it follows the canonical order in "Working-agent context": goal-stable blocks, then chat history, then turn-volatile blocks, then the current user message and the in-flight turn. Content is placed by how often it changes, never by topic.

Further rules:

- Do not put timestamps, request identifiers, paths that change each turn, or capability catalogs in the stable prefix.
- Do not reorder permanent tools between calls.
- Keep the goal's five-Skill shelf stable until the goal changes; place it in the goal-stable blocks after the permanent prefix.
- Never place per-turn state—the continuation note, goal note, open-task index, retrieval results, candidates, or the recent-activity notepad—before the chat history.
- Treat likely candidates as task-specific dynamic context and omit the block when neither kind clears its threshold.
- Append dynamic MCP tool schemas after the permanent tools, in deterministic public-name order, so the same active set always produces the same tool list. Changing the active set costs one cache miss; it is not avoided by reordering or hiding schemas.
- Keep full Skill instructions out of the prompt until activated.
- Preserve provider prompt-cache handles when the API supports them, without making the core depend on them.
- Breakpoints are marked in the normalized request and placed at four points, the most explicit-breakpoint providers accept: after the system prompt and tools, after the last Q&A-only turn, after turn N−1, and on the newest message (rolling, so every step reuses everything before it). Each completed turn is its own part, so a provider's prefix lookback also lands on turn boundaries. Providers that cache prefixes automatically ignore the markers; the byte-stability of everything before the in-flight turn is what makes their caches hit.
- Compaction replaces content only in the dynamic suffix, never in the stable prefix. A history checkpoint, once written, is frozen text: it does not change between steps of the same turn, so the post-compaction prompt remains cache-stable from that point forward.

## Embeddings and hybrid retrieval

Every "hybrid" search in this document and in `Goal-router.md` uses one embedding index and one scoring function. The index is optional: without it, or while the embedder is unreachable, every search is BM25 plus recency and nothing else changes.

**Embedding model.** Chosen like the chat models. The default is local: Ollama with `embeddinggemma`, so memory never leaves the machine and search works offline. `SOCRATES_EMBEDDINGS_PROVIDER` selects `ollama`, `openrouter`, `openai`, or `custom` (any OpenAI-compatible embeddings endpoint at `SOCRATES_EMBEDDINGS_URL`, with an optional `SOCRATES_EMBEDDINGS_API_KEY`); `SOCRATES_EMBEDDINGS_MODEL` names the model. Models trained with instruction prefixes (embeddinggemma, nomic-embed) receive their query and document prefixes automatically.

**Index.** LanceDB, an embedded vector database, in a folder beside the ledger (`<database>.lance`), with cosine distance and filters applied before the nearest-neighbour search. Each embedding model and endpoint has its own table, identified by a collision-resistant hash and checked against persisted identity, so vectors from different models never mix; changing the model re-embeds everything in the background while keyword search covers the gap. The event log stays the source of truth: vectors are derived data keyed by a content hash, so nothing is embedded twice, and a deleted index is rebuilt from the log. The versioned namespace rebuilds legacy indexes once. Metadata-only changes refresh timestamps without re-embedding; workspace binding also refreshes every existing task of the goal.

**What is embedded.** Each document points back to its exact source; a search returns pointers, never a replacement for the source.

- each goal: title, objective, note, workspace, and anchors (the same text the keyword index holds);
- each task: title, objective, completion criteria, continuation note, and derived facts;
- each exchange: the user's request and the final answer of a turn, in overlapping chunks of `4,000` characters (`600` overlapping) so a long exchange fits the model's input;
- each tool call: one line naming the tool and its input, such as `terminal: npm run migrate` or `edit src/cart.js`. Outputs are not embedded; a match leads to the exchange, and the call's evidence handle opens the output;
- each installed Skill and MCP tool: its name and description;
- each section of a workspace file (see "Project files").

Compaction summaries are not embedded: every turn they cover is embedded as its exact exchange, and a summary never replaces its source.

**Background indexing.** After every message, Socrates schedules one sync: the documents touched by events since the last sync's watermark are re-derived, the changed ones embedded in batches, and the watermark advanced; then the bound workspaces are scanned. A pass embeds at most `256` file sections, including when one file exceeds the budget; its remaining sections resume in another pass, so a large workspace's first index never holds up the ledger's for long, and the table is compacted after every `20` writes. A reply never waits for indexing; a record not yet indexed is ranked by keywords alone until it is. The only embeddings on the reply path are the queries themselves (the message, and for project files the message read with the task's note): each is cached, and the complete semantic lookup (embedding plus vector search) is bounded to `3` seconds and caller cancellation, and after a failure meaning search is skipped for `30` seconds, so an unreachable Ollama costs nothing.

**Project files.** The files of every workspace bound to a goal are indexed too, for `<PROJECT_CONTEXT>`. In a git repository the files are git's own list (tracked and untracked, ignored files excluded); elsewhere, including a folder that its enclosing repository ignores, a walk that skips hidden entries. Never indexed: the dependency, build, cache and temporary paths that anchors also reject; files that may hold credentials (`.env*`, `.npmrc`, `.netrc`, `credentials`, `secrets.*`, `id_rsa` and other SSH keys, `*.pem`, `*.key`, and similar); lockfiles and minified bundles; symbolic links (including any parent directory), paths outside the canonical workspace, binary files, and files over `256 KB`. A workspace contributes at most `5,000` eligible files; excluded paths do not consume that limit, and the cap is logged. Markdown splits at its headings, outside code fences; other files split into windows of `80` lines overlapping by `10`; anything longer than one embedding input, including an individual long line, is split into overlapping chunks without dropping its tail. Each section is embedded with its path and heading and keyed by its content, so an edit re-embeds only the sections it changed, and a deleted file's sections are removed. A file whose identity, size, modification time and change time are unchanged is not read again, but its path is revalidated on each scan. Indexing and context assembly use the same bounded read policy, rejecting symlink aliases and checking the opened file against the validated path before releasing its contents. With the default local model, file contents never leave the machine; with a hosted embedding provider they are sent to it, as chat context is sent to the chat model.

**Similarity floors.** Measured for embeddinggemma on Socrates-shaped text and configurable per deployment:

| Floor | Value | Use |
| --- | --- | --- |
| `related` | `0.20` | A meaning match may join a fused ranking: router goal candidates, `context_retrieve`, this task's `<RETRIEVED_HISTORY>`. Keywords and the router still decide. |
| `suggest` | `0.35` | A capability may be suggested on meaning alone. |
| `strong` | `0.45` | Another task's exchange may be added to `<RETRIEVED_HISTORY>`, or another workspace file's section to `<PROJECT_CONTEXT>`, on meaning alone (the right code file scored 0.52–0.53 against a plain-language question, other files at most 0.32). |

**Scoring.** Keyword and meaning rankings are merged by reciprocal rank fusion (`K = 10`), in units where first place in one ranking is worth `1` and place `r` is worth `(K + 1) / (K + r)`; raw BM25 and cosine values are never compared directly. A recency boost of at most `0.05`, halving every `30` days, settles near-ties in favour of newer evidence; it is about half the gap between first and second place, so it never buries a clearly more relevant old record. Router candidates add a `0.05` boost for open goals.

**Conflicting evidence.** Ranking cannot tell that two records disagree; the model reading them can. Retrieved exchanges are therefore shown oldest first with their dates and turn numbers, and the agent's instructions say that when earlier turns, retrieved exchanges, or summaries disagree, the later one is current unless it says otherwise.

## Safety and long-running work

- Filesystem tools resolve every path to its real target before applying the access policy, so a symbolic link cannot escape the workspace, cannot reach protected repository metadata through an alias, and cannot split one file's stale-edit record into two.
- File mutations take one lock per workspace, shared by every run in the process, and recheck the file's content immediately before writing.
- Terminal commands use the same workspace and approval policy.
- Approval is one injected `approve` callback owned by the application; each message may supply its own, and every request names the goal, task, turn and lane it comes from (see "Lanes"). Without an access policy it is consulted for the first-mutation gate (`Goal-router.md`, "Workspace resolution"), `SIGKILL`, `timeout_ms: 0`, and the first call of a non-read-only MCP tool in each goal (see "MCP approvals"); with one, "Access" decides instead. A denial is a corrective tool error, never a crash.
- A turn without a workspace (general conversation, or a new goal before a workspace is chosen) can still answer and use `context_retrieve` and capability tools; workspace filesystem and terminal tools fail with `no_workspace` (the read-only active-Skill resource exception above still applies), and the agent asks the user where the work belongs.
- Every mutating tool records its effect before the next model step.
- Terminal sessions persist independently of one HTTP request and can be rediscovered, read, awaited, or stopped in later turns.
- Cancellation propagates to model requests and tool execution. A cancelled call is refused before it starts and after any approval it waited for, file tools check again just before writing, and a command or service launch that is cancelled is stopped.
- Step, time, and token limits are configurable safeguards for one turn, not a tiny fixed loop count. Defaults: `200` working-model steps, `60` minutes of wall time, and `20,000,000` tokens across the turn's model calls. A request counts its prompt without what the provider served from its cache, the cache read at a tenth (`CACHE_READ_WEIGHT`, about what providers charge), and its output: a long turn sends its whole context at every step, nearly all of it cached, and counting each of those tokens in full ended a 100-step coding turn at the old `5,000,000` after ten minutes of work that was going well. Checkpoint and handover calls, including invalid candidates and retries, contribute their reported input and output tokens to the same turn budget. Exhausting it prevents another summarizer attempt or normal worker call; the bounded tool-free finalization remains allowed.
- If a limit is reached, the harness saves the exact state and makes one final request with tools disabled, asking for the `FinalAnswer`: what was done and what remains. The user sees an honest partial result instead of a pretended completion. The completed turn records which limit ended it (`stop`: `steps`, `time`, `tokens`, or `context`). Reaching the compaction trigger is not a limit: the turn compacts and continues; `context` is recorded only when no request can be kept under the ceiling.
- Every provider request, including retries, wrap-up and repair, passes the calibrated `180,000`-token hard gate. Counts include native replay blocks as well as normalized text. If the final request itself cannot fit, the harness sends no oversized request: it saves a mechanical partial answer and continuation note, records `context_limit`, and applies no model-proposed state. It is the last gate behind compaction, not a substitute for it.
- The wall-time allowance includes capability discovery and restoration during part setup. Cancellation propagates through MCP connection, every listing page, activation, dispatch and post-step definition refresh; aborted listings cannot publish snapshots or active state, and shutdown aborts pending connection/listing work. The wall-time deadline aborts pending model requests, tool operations and approval waits. No new mutation starts after expiry. Tool-free finalization (wrap-up and any one repair) has a separate shared allowance, default `60,000` ms and configurable as `finalizationMs`; its expiry records failure. User cancellation aborts both allowances. Late provider responses or approvals cannot resume work.
- Part setup is covered by turn failure handling. If workspace resolution, an application acknowledgment callback or context setup throws, the failed part is interrupted and later bound parts are finalized as not started. Exact tool evidence remains available. Application diagnostics stay out of model-facing errors.
- A turn still running when the process stopped is interrupted at the next start, before anything else runs: `turn_interrupted` with reason `restarted`, a mechanical continuation note ("Interrupted when Socrates stopped after 3 tool calls."), and its exact evidence kept. History shows it as stopped while running, so the next turn can continue it.
- Cancellation makes no further model call. The turn is recorded as interrupted (a `turn_interrupted` event with the reason and the number of tool calls) with a mechanical continuation note such as "Interrupted by the user after 14 tool calls." When the user stops a turn while its answer is streaming, the answer as far as it was written is kept on that event (`partial_answer`) and the note says it was interrupted while the answer was being written. It is kept as written and is never a final answer: the turn has no response, and the goal note, task status and anchors do not change. A stop that lands after the whole answer was written keeps that answer the same way. A reply that was not streamed, or a stop before any answer text, keeps nothing.

## Access

The application may give Socrates an access policy, read before every tool call so a change applies to the next call. It has two independent parts:

- **Where.** `folders` lists the folders file and command tools use freely; `null` means anywhere on the computer ("full access"). Paths outside the workspace are absolute, or start with `~/`. A path outside the folders asks the user first (`outside_folder`, naming the path and whether it is read, changed, or a command's working directory); an answer covers that path, and everything below it when it is a directory at approval time, for the rest of the message, including compound parts. A read grant covers reads only, and the next message starts without grants. The goal's workspace is no exception: when it is not listed, it asks too. Restarting or writing to an existing terminal also checks its working directory against the current policy; stopping it remains possible after access is revoked.
- **Approvals.** `ask` approves every changing call before it runs (`action`: `edit`, `apply_patch`, `terminal`, changing `terminal_control` actions and MCP tools not marked read-only), with one line naming it and a complete preview of the submitted change or input, including command options and environment overrides. An action whose preview exceeds `20,000` characters is refused with `approval_too_large` and must be split; a truncated preview never authorizes hidden input. `auto` asks for none of them. Reading and searching never ask.

With a policy, these two approvals replace the classic ones: the first-mutation gate, `SIGKILL`, `timeout_ms: 0`, and the first call of an MCP tool are not asked separately. An `action` request may be followed by an `outside_folder` request for the same call when its path lies outside the folders.

In every mode, `protected` folders (Socrates' own data, and Socrates 0.1's) are excluded from direct file access, searching and command working directories through their lexical paths and real targets, including when a protected folder is itself a symlink. Searches prune those directories before traversal. Approved paths are revalidated after approval and file-mutation lock waits. File freshness/write sections lock canonical targets across workspaces, including every patch source and destination. Repository metadata stays read-only for file tools.

The existing read-only resource grant of a valid, activated Skill is separate: `read` may read files within that Skill's revalidated resource directory, including globally installed Skills under Socrates' data. It cannot escape that directory through a symlink. General file access to the data folder remains protected.

Automatic project context, anchor hashing and workspace indexing use the configured file scope without obtaining temporary outside-folder grants. Revoked or protected files are omitted; the agent can request an explicit tool read instead. Indexing checks access before traversal and file reads, removes revoked workspace sections, and schedules a refresh when access settings change.

Commands are not sandboxed. The policy decides where a command starts and, in `ask` mode, whether it runs at all; a command that runs may still reach files elsewhere. Without a policy, the goal's workspace is the boundary and only the classic approvals apply. The agent sees the policy as `<ACCESS>` (see "Working-agent context").

## Initial exclusions

The first harness deliberately excludes:

- a dedicated `write` tool;
- a user-question tool;
- a planning or todo tool;
- subagents;
- a browser tool;
- a built-in web-search tool;
- always-visible GitHub or database tools;
- automatic skill creation;
- separate worker, planner, router-finalizer, or state-writer agents.

These can be introduced only after evaluations demonstrate a concrete need. Browser, web, GitHub, databases, and similar integrations should normally arrive through conditional capabilities rather than expanding the permanent surface.

## Implementation staging

The working agent is built in this order; each stage is one reviewed change:

1. **Tools** — the ten permanent tools, the shared tool runner and corrective-error contract, workspace access policy, the terminal supervisor, and persisted tool evidence with permanent `eN` handles.
2. **Agent** — the loop, `FinalAnswer`, context assembly in the canonical layout with three-tier history and N−1 fitting, the per-turn lifecycle including compound parts, and provider prompt-cache breakpoints.
3. **Compaction** — history checkpoints, in-turn linearization, the failsafe, compaction counting, rollover with the handover capsule, and `<RETRIEVED_HISTORY>`.
4. **Capabilities** — real Skill sources, MCP activation, the frozen Skill shelf, and automatic candidates.

**Embeddings** follow as their own segment after these four, in two changes:

- **E1, the retrieval core:** the embedding clients, the LanceDB index with background indexing, and the one hybrid scoring path, used by router goal candidates, `context_retrieve` search, `<RETRIEVED_HISTORY>` (including one strongly related exchange from another task of the goal), and capability candidates. See "Embeddings and hybrid retrieval".
- **E2, `<PROJECT_CONTEXT>`:** the workspace file index and the anchor and related-file sections of `<PROJECT_CONTEXT>`. See "Project files" and "Working-agent context".

**Lanes** follow, in two changes:

- **L1, parallel runs:** lanes in the event log, concurrent runs in one Socrates with one run per task, handing main-conversation messages to a busy lane, per-run approvals and cancellation, and a main-conversation "current" that lanes never change. See "Lanes".
- **L2, main's awareness of lanes:** the `<LANES>` block in the main conversation's context, lane notices, and the router's `LANES` section with selectors and its lane rules. See "Lanes".

**A1, access modes,** follows the server: where tools may work and when they ask, and `<ACCESS>`. See "Access".
