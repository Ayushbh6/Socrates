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

`offset` is the 1-based first line and defaults to `1`. `limit` defaults to `500` lines and is capped by policy. The backend also enforces a UTF-8 byte bound and a per-line bound, so a pathological file or line cannot consume the model context.

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

Directory discovery does not belong in `read`; use `glob`. Binary files, directories, invalid UTF-8, and files outside the granted workspace fail with corrective errors rather than returning damaged text.

#### 2. `glob`

Find paths by filename or path pattern.

```json
{
  "pattern": "string",
  "path": "string | optional",
  "limit": "integer >= 1 | optional",
  "cursor": "string | optional"
}
```

`path` is the directory to search and defaults to the selected workspace. `pattern` uses one documented glob dialect. Results are files only, include hidden files allowed by workspace policy, exclude repository metadata and inaccessible paths, and are returned in stable path order. `limit` defaults to `200` and is capped by policy. `cursor` continues the exact bounded result set created by the preceding call; callers do not construct cursors.

```json
{
  "root": ".",
  "matches": ["apps/server/src/index.ts", "packages/core/src/index.ts"],
  "returned": 2,
  "truncated": false,
  "next_cursor": null
}
```

An empty match is a successful result. A truncated result always carries `next_cursor`; Socrates never silently samples a large result because sampling makes exact repository discovery difficult to reason about.

#### 3. `grep`

Search file contents.

```json
{
  "pattern": "string",
  "path": "string | optional",
  "glob": "string | optional",
  "case_sensitive": "boolean | optional",
  "literal": "boolean | optional",
  "limit": "integer >= 1 | optional",
  "cursor": "string | optional"
}
```

`pattern` is a regular expression by default. `literal: true` treats it as exact text. `case_sensitive` defaults to `true`; the tool never uses an implicit smart-case rule. `path` may be one file or directory and defaults to the selected workspace. `glob` is one inclusion filter such as `*.ts` or `**/*.test.ts`. `limit` defaults to `100` matches and is capped by policy. `cursor` continues the stable bounded result set from the preceding call.

```json
{
  "matches": [
    {
      "path": "src/server.ts",
      "line_number": 84,
      "text": "const server = await startServer()"
    }
  ],
  "returned": 1,
  "truncated": false,
  "next_cursor": null
}
```

Returned lines and paths are individually bounded. No match is a successful empty result; an invalid expression is a corrective error. The agent uses `read` for surrounding context instead of asking `grep` to become a second file reader.

`glob` and `grep` remain separate because path discovery and content search are simple, different operations used consistently across the reference harnesses.

### Editing

#### 4. `edit`

Perform a precise replacement in one existing file.

```json
{
  "path": "string",
  "old_text": "string",
  "new_text": "string",
  "replace_all": "boolean | optional"
}
```

`replace_all` defaults to `false`. With that default, the operation succeeds only when `old_text` occurs exactly once. It fails safely when the text is absent or ambiguous. With `replace_all: true`, every exact occurrence is replaced, but zero occurrences still fail. `old_text` must not be empty.

The backend verifies the current file version under the mutation lock. If the file changed after the task last observed it, the edit fails as stale and tells the agent to reread it. This prevents a successful read followed by a racing overwrite. The tool preserves the file's existing newline convention and does not create missing files.

```json
{
  "path": "src/server.ts",
  "replacements": 1,
  "changed": true,
  "diff": "*** bounded unified diff ***"
}
```

The returned diff is bounded but the complete mutation and before/after versions are recorded in the event log. A replacement that produces identical content succeeds with `changed: false` and records no filesystem mutation.

#### 5. `apply_patch`

Apply a grammar-constrained patch that can update, create, move, or delete one or more files.

```text
*** Begin Patch
*** Update File: path/to/file
...
*** End Patch
```

`apply_patch` is a freeform tool: the model sends patch text directly rather than wrapping it in JSON. Paths are workspace-relative. Absolute paths, paths outside granted roots, malformed hunks, stale context, and unsupported file types fail before mutation.

The complete patch is validated first and then committed atomically as one operation: either every declared file change succeeds or none does. A move cannot overwrite an undeclared destination, and a delete must match an existing file. Parent directories for declared new files may be created by the backend.

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

The output diff is bounded while the complete patch and mutation evidence remain in the event log. `edit` is preferred for one exact replacement; `apply_patch` is preferred for new files, coordinated multi-file work, moves, deletes, or several hunks.

There is no separate `write` tool initially. `apply_patch` already provides explicit file creation without adding another permanent schema. A dedicated `write` tool should be added only if evaluations show a concrete reliability problem with large new files.

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

`cwd` defaults to the selected workspace and is resolved through the same access policy as filesystem tools. `env` augments the controlled process environment without requiring fragile shell quoting. `pty` defaults to `false` and should be enabled only for interactive programs or terminal-dependent output.

`yield_ms` controls only how long the current call waits before returning a live session; it defaults to `10,000` and is capped at `30,000`. It is not a process deadline. `timeout_ms` is the actual execution deadline; the backend supplies a bounded default for ordinary foreground commands, while `0` explicitly requests no deadline when policy allows it.

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
  "output": "Local: http://localhost:3000",
  "cursor": "c7",
  "truncated": false,
  "wall_time_ms": 10012
}
```

`terminal` is the preferred selector and equals the supplied name when present; otherwise the backend returns a short readable session id. Output is bounded, treated as untrusted text, and retained separately for cursor-based reads. A running session survives model turns, HTTP requests, task suspension, and user steering. The project terminal supervisor owns process-tree cleanup and reconciles retained sessions after an application restart; the agent never kills an unverified operating-system PID directly.

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
  "limit_lines": "integer >= 1 | optional"
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
  "keys": "array<ENTER | TAB | ESCAPE | CTRL_C | CTRL_D | UP | DOWN | LEFT | RIGHT> | optional"
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

`terminal` accepts either the stable project-local name or returned short session id. The model never needs an operating-system PID.

- `list` returns every owner-visible live session plus a bounded number of recently exited sessions. Each row includes name/id, command summary, cwd, state, readiness, input requirement, start time, and exit information.
- `read` returns retained output after `cursor`, together with a new cursor and explicit truncation or output-loss metadata. Reads are non-destructive, so the UI and model do not steal output from one another.
- `wait` registers a durable event dependency and suspends the same task without polling the model. The task resumes only for the requested terminal event, user steering, cancellation, or an operational failure. `pattern` is required only for the `pattern` event. There is deliberately no model-facing polling interval.
- `write` sends text and/or named keys through a serialized PTY input stream. `submit` defaults to `true` when `input` is supplied. Writing to a non-PTY session fails unless that process has an open supported stdin channel.
- `signal` targets the verified foreground process group. `SIGKILL` requires normal approval policy and is never the default shutdown path.
- `terminate` performs graceful process-tree shutdown followed by bounded hard-kill if necessary.
- `restart` reuses the retained launch and readiness specification and preserves the stable name while returning a new `session_id`.

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

`gN` and `tN` are permanent human-facing ordinal selectors, not database identifiers. Task numbers are local to their goal: `t4` means task 4 of the current goal, while `g7/t4` explicitly selects task 4 of goal 7. Search-result and evidence handles such as `r1` and `e1` remain short run-scoped references.

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
- `from` and `to` bound the search to ledger entries whose `updated_at` falls in the range, inclusive. Both are optional and independent.
- `top_n` defaults to `5` and cannot exceed `10`.
- `cursor` continues the exact frozen result set of the preceding search. A truncated result always returns `next_cursor`; the model can keep paging or narrow its query without requesting an unbounded dump.
- `hybrid` combines semantic similarity, BM25 or equivalent keyword matching, and a small recency signal.
- `exact` performs literal text matching and never silently falls back to hybrid retrieval.
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

There is deliberately no inspection query. Inspection is deterministic: `gN` opens a bounded goal record, `tN` opens a task in the current goal, `gN/tN` opens a task in another goal, and short refs open the selected search result or evidence. The agent uses `ledger_search` or `search` to locate relevant material before inspecting it.

Inspection also resolves compaction artifacts. A history checkpoint handle such as `hc-3` opens the exact stored checkpoint, and a tool-call evidence handle such as `e1` opens the bounded view of that call and its complete stored result. Compaction therefore never creates unreachable content: everything the prompt summarizes or linearizes remains resolvable through this tool under the same output bounds.

Run-scoped handles are backend-assigned. `hc-5` resolves against the task binding of the current turn; the same label in a different task names a different stored object. Permanent selectors (`gN`, `tN`, `gN/tN`) follow the goal-local task rules above. A stale, unknown, inaccessible, or foreign-task reference fails with a corrective error directing the agent to search again.

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
- `9,000` tokens (5% of the universal `180,000`-token ceiling); or
- the remaining safe tool-output allowance for the current model request.

The agent cannot request raw output, set its own token allowance, use offsets to reconstruct an unbounded dump, or disable truncation. For an oversized inspection, the backend prioritizes turn identity, the user message, the visible final response, a compact tool-call inventory, and bounded beginning-and-end excerpts. Every omission is explicit and receives a short evidence reference such as `e1`. Inspecting that reference is bounded again by the same policy, so repeated calls never unlock a single unrestricted dump.

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

Each entry contains only the exact name and one bounded description. Full instructions, paths, dependencies, and resources remain unloaded. Explicit user pins are selected first, followed by deployment defaults and then the most frequently activated Skills for this user and project. The resolved shelf is frozen for the goal so ordinary turns remain cache-stable; usage changes affect a future goal, not every request. If five or fewer model-invocable Skills exist, all may appear.

MCP tools never enter this shelf. Even small MCP descriptions multiply quickly, and a description without its live schema does not make the tool callable.

#### Automatic likely candidates

Before the first working-agent call for each new user task, deterministic retrieval may suggest at most one inactive Skill and one inactive MCP tool. Candidates are hints, not activations:

```text
<CAPABILITY_CANDIDATES>
- skill c1: pdf — matched attached application/pdf document
- mcp c2: playwright.browser_navigate — matched browser verification request
</CAPABILITY_CANDIDATES>
```

The retriever ranks exact names, explicit mentions, attachment MIME types and extensions, URLs, catalog tags, descriptions, and declared use cases. It combines lexical and semantic scores but performs no second LLM call. Each kind has its own threshold and may return no candidate; an MCP result cannot crowd out a stronger Skill result or vice versa.

Long prompts are not embedded as one undifferentiated 10,000-character query. The retriever preserves the exact prompt for the agent but searches bounded overlapping chunks, explicit request/acceptance sections, attachment metadata, and high-signal entities independently. It merges the best score per capability and deduplicates the result. This allows a relevant sentence buried in a long specification to match while reducing the chance that one incidental word such as "PDF" dominates the whole request.

The Main Coding Agent decides whether to activate a candidate. A false-positive suggestion costs only a short metadata line. Explicitly naming a Skill or MCP tool creates an exact high-priority candidate when available, but still does not bypass activation, authentication, permissions, or policy.

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
      "provider": "workspace",
      "availability": "available",
      "active": false
    }
  ],
  "returned": 2,
  "more_matches": false
}
```

`ref` is a short result-local selector issued by the backend. It resolves the exact catalog record seen by this search and prevents collisions between similarly named Skills, servers, and tools. The backend retains canonical provider and server identifiers privately.

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
  "instructions": "Complete SKILL.md content...",
  "resource_base": {
    "kind": "directory",
    "path": "/workspace/.socrates/skills/github_issue_workflow"
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

For a Skill, the tool result itself carries the complete validated instruction body and a short model-facing version, so the next model step can follow it without a duplicate synthetic message. The backend retains the content digest privately. An oversized or invalid Skill fails activation instead of silently supplying partial instructions. `resource_base` may instead be a URL or bounded opaque provider description. Referenced scripts, templates, examples, and supporting files are loaded only when the Skill instructions require them; activation does not enumerate or ingest an entire Skill directory.

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

For an MCP tool, the harness connects or reconnects to the configured server when necessary, performs a fresh MCP `tools/list`, resolves the exact advertised tool selected by `ref`, validates and bounds its real JSON Schema, assigns a collision-safe public name, and appends only that one tool schema to the next model request. Activation does not invoke the MCP tool and does not count as approval for a later mutating call.

Authentication-required activation returns a structured non-success state and the existing user-facing authentication route; it never asks the model to handle credentials. Offline or failed servers retain bounded internal diagnostics, while the model receives a corrective operational error without secrets or raw stack traces.

Activated capabilities are scoped to the current goal:

- an activated Skill's exact version and instructions remain available to subsequent steps in that goal;
- an activated MCP tool remains in the goal's dynamic tool set while its server and policy permit it;
- switching goals removes those dynamic instructions and schemas from the next request without uninstalling or globally disconnecting anything;
- returning to a goal restores its still-valid active set after revalidating provider versions, connection state, and permissions;
- deactivation removes the Skill body or MCP schema from the next request while retaining exact historical calls and results.

The backend caps the number and aggregate schema size of simultaneously active MCP tools. When the cap would be exceeded, activation fails truthfully and returns the bounded active set so the agent can deactivate tools it no longer needs. It never silently drops an active schema that the model may call.

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

Dynamic MCP schemas are appended after the permanent schemas in deterministic public-name order. Skill instructions and goal-specific capability state appear after the stable prefix with the other dynamic goal context. Adding, replacing, or removing a conditional capability may invalidate only this dynamic suffix; it never reorders or rewrites the ten permanent tool definitions.

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

The loop supports multiple tool calls in one model response when the provider supports them and the calls are independent. Mutating calls are serialized unless the harness can prove they do not conflict.

There is no separate planner agent, answer-writing agent, state-writing agent, or tool-selection agent in the initial architecture. The same Main Coding Agent returns its visible answer and a short hidden continuation note in one final result.

## Exact per-turn lifecycle

1. Receive the user message.
2. Persist it exactly.
3. Run the Goal Router described in `Goal-router.md`: it selects the workspace, goal, and task.
4. Bind the turn to the selected goal and task.
5. Resolve the goal's frozen Skill shelf and retrieve zero to two likely capability candidates for this turn. (The shelf is frozen per goal; candidates are per turn.)
6. Assemble the working context for that task: goal context, task context, task history.
7. Start the model/tool loop with the ten permanent tools.
8. Let the agent activate a candidate, search for another capability, or use neither.
9. Continue until the model returns a final response or asks the user a question.
10. Require the final result to contain a visible answer, a short task-local continuation note, and an optional task-completion proposal.
11. Persist those fields and all exact tool evidence.
12. Throughout the loop, attach history per the three-tier policy and, whenever the `160,000`-token trigger is crossed before a model request, compact per the "Context and compaction" section: one history-checkpoint LLM call when completed history lies outside the verbatim window, then mechanical in-turn linearization if still needed. The turn continues naturally. Compaction is strictly task-local; when the trigger would fire for the sixth time in the same chat, the harness performs the automatic rollover described in `Goal-router.md` instead.

## Working-agent context

The current user request must be the final block and must appear exactly once.

```text
<CURRENT_GOAL>
title: Socrates memory system
note: Ongoing review and hardening of the memory and compaction system.
open_tasks:
- Preserve large tool results in compaction — active
</CURRENT_GOAL>

<CURRENT_TASK>
title: Preserve large tool results in compaction
objective: Ensure compaction never loses large tool results.
status: active
note: Reviewed compaction. The remaining concern is preserving large tool results.
</CURRENT_TASK>

<HISTORY_CHECKPOINT ref="hc-2" turns="1–9">
summary: Reviewed the memory system and identified the compaction gap.
outstanding_requests:
- turn 3: "Also check whether the recovery path validates source references."
</HISTORY_CHECKPOINT>

[TURN 10 — Q&A + tool activity]
USER:
Can you review the memory system?

SOCRATES:
The current implementation compacts large tool results...

TOOL ACTIVITY:
- read memory/compact.ts (lines 1–120)
- terminal: pytest tests/memory/ → 2 failed (assert source_ref is None)

<RETRIEVED_SUPPORTING_CONTEXT>
Only exact repository or older-task evidence required for this turn.
</RETRIEVED_SUPPORTING_CONTEXT>

<ACTIVE_CAPABILITIES>
Only Skills and MCP tools activated for this task.
</ACTIVE_CAPABILITIES>

<AVAILABLE_SKILLS>
At most five frozen name-and-description entries.
</AVAILABLE_SKILLS>

<CAPABILITY_CANDIDATES>
At most one Skill and one MCP hint for this turn.
</CAPABILITY_CANDIDATES>

<CURRENT_USER_MESSAGE>
Can you fix the information-loss problem?
</CURRENT_USER_MESSAGE>
```

There is no separate `latest exchange` field because it would duplicate the newest entry in exact history.

History follows the three-tier attachment policy: the N−1 turn appears with its Q&A and linearized tool inventory, older completed turns appear as Q&A-only pairs or inside a history checkpoint, and the current user message is the final block. The tier-3 Q&A allowance is token-based and configurable, initially `20,000` tokens. Complete Q&A pairs are preferred over arbitrary message slices.

## Compound tasks

A `compound` route creates one stored user turn with multiple ordered work units. Each part is a task (in the goal/task/chat model): part 1 runs in its task, part 2 in its own.

The same Main Coding Agent runs them in order:

1. Assemble the selected task context for part 1 and run its tool loop.
2. Save part 1's exact evidence, updated continuation note, and finalize part 1's ledger entry.
3. Assemble part 2's task context, including only the evidence explicitly passed from part 1.
4. Run part 2's tool loop.
5. Return one visible answer covering both outcomes and save one continuation note for each affected task.

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
evidence: e7 (failing test before fix), e12 (final test run)
</EVIDENCE_FROM_PART_N>
```

The block is built from the ledger entry's derived fields and pointers — the harness selects it, not the model. Each compound part is a task with its own ledger entry, and part 1's entry is finalized when part 1 completes, before part 2's context is assembled — so the handoff always reads a real, finalized entry, never an in-flight one. The block is bounded like any other context block: derived lists at their ledger caps, at most four evidence refs, and the continuation note verbatim. Exact expansion of any ref happens through `context_retrieve` under the normal output bounds, so the handoff cannot become an unbounded dump.

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
- the latest continuation note produced by the Main Coding Agent.

Large tool outputs may be replaced in the active prompt by a short result plus a retrievable reference, but the complete result remains stored.

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
| `20,000` tokens | N−1 full-attachment limit. Turn N−1 is attached with its full tool activity only when its full rendering fits this size. |

The gap between trigger and target is the hysteresis: after compaction, the prompt must grow by at least 80k tokens before the trigger fires again, so compaction never runs on consecutive steps.

Token counting uses one fixed harness-standard tokenizer, independent of the served model. The canonical counter is `tiktoken` with the `o200k` encoding. Its count is treated as the authoritative budget number for every model; exactness against each provider's native tokenizer is not required, only consistency. Thresholds carry a built-in safety margin, so an estimator drift of a few percent cannot push a request past the provider's real limit.

### When compaction runs

Compaction is synchronous and runs mid-turn, between tool execution and the next model request. This is the primary case, not the edge case: a long turn crosses the trigger on its twelfth or eightieth tool result, and the turn must continue naturally afterward. Compaction is never a background job and never defers to the next turn.

The unit being measured is the full next model request: stable prefix, history, capability context, and the current in-flight turn with all tool calls and results so far.

### Three-tier history attachment

History attaches to the working prompt in three tiers. This policy decides the *shape* of each turn on every request; it does not impose a size cap. Until the compaction trigger fires, every completed turn of the current task chat is attached in its tier shape. Size is managed only by compaction.

1. **Current turn (in flight).** Everything: the full user query, full tool calls, and full bounded results. This is the agent's active working state.
2. **Turn N−1 (just completed).** Everything: the full user query, every tool call with its bounded result, and the full final response. The previous turn is the most likely referent of the next user message, so its complete working evidence stays in view. If the full rendering of N−1 exceeds the `20,000`-token N−1 limit, it is attached instead as the full user query, the full final response, a tool inventory in the linearization grammar below, and bounded excerpts of the most significant results (for example, a failing assertion).
3. **Turns N−2 and older.** The full user query and full final response only. No tool calls and no tool results. Tool evidence remains in the event log, reachable through `context_retrieve`.

Dropping tool activity from older turns is deliberate. Their final responses carry what the work established, re-sending every historical tool call and result wastes most of the context, and the agent works better without that noise. Nothing is lost: every attached turn carries a visible `[TURN k]` label with its permanent `project_turn` number, and that label is a requirement, not decoration. It is what lets the agent call `context_retrieve` `inspect` with `turn_number: k` to recover that turn's exact tool calls and results whenever it needs them.

Complete Q&A pairs are always attached whole; a user query is never separated from its final response. Obligation continuity does not depend on keeping every historical message forever: when compaction runs, the checkpoint's `outstanding_requests` field extracts every unanswered request verbatim, and those quotes remain visible in the prompt until resolved. Oversized user messages (for example, a pasted specification) are already handled by bounded ingestion at entry time.

### Layer 1: history checkpoint (one LLM call)

When the trigger fires, the harness first compacts completed history:

1. Starting with turn N−1 and walking backward, keep the newest complete turns, in the exact shape they were attached, while they fit within the `30,000`-token verbatim history window. N−1 counts at its attached size. The window is turn-atomic: a turn that does not fit whole is not kept.
2. Every completed turn older than the window, together with the prior active checkpoint when one exists, becomes the compacted span.
3. The compacted span is sent to one dedicated compactor model call, which produces the new history checkpoint.

This is the only LLM call compaction ever makes; it is a bounded, small-context request, not a second agent.

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
- Hard bounds: at most `10` entries, each quote at most `200` tokens, aggregate at most `2,000` tokens. If more than 10 exist, the excess becomes a `context_retrieve` reference instead of a quote.
- The next compaction's compactor receives the prior checkpoint, resolves entries that newer turns answered, and carries the rest forward. Obligations survive chained compactions until genuinely done.

The schema is flat, all-required, and one level deep for structured-output reliability across providers. The compactor prompt instructs it to preserve exact identifiers—paths, test names, error strings—verbatim inside string fields and never paraphrase them.

#### Checkpoint handles, chaining, and goal scoping

Every checkpoint is stored in the event log and receives a short handle such as `hc-3`. Handle rules:

- **Handles are backend-assigned.** The compactor model produces only schema content; the harness assigns the handle at storage time, exactly like `r1` and `e1` handles. The model never generates or needs to know its own checkpoint's handle.
- **Handles are task-scoped.** `hc-5` always means checkpoint 5 of the current task's chat chain. The working prompt is always assembled for exactly one task, so resolution is unambiguous. A handle from another task fails with a corrective error directing the agent to search again.
- **Checkpoints chain and supersede.** When compaction fires again later, the existing checkpoint is part of the old history being compacted; the new checkpoint absorbs it, and its `turns_covered` range subsumes the old one. Superseded handles remain resolvable in the event log but leave the prompt. The working prompt contains at most one active checkpoint.

The agent can resolve any checkpoint handle through `context_retrieve` under the same bounded output policy as any other evidence reference.

#### Resolution ladder

Checkpoint content is coarse by design; detail is recovered by walking down three rungs:

```text
Active checkpoint (in the prompt, always present, coarsest)
  → superseded checkpoints (inspect hc-1, hc-2, ...; finer-grained)
    → evidence refs (inspect e-*; the exact raw events)
```

The active checkpoint needs no inspection—it is already verbatim in the prompt. Inspection exists for superseded checkpoints and evidence drill-down: when the active summary compressed away a needed detail, the agent inspects an earlier checkpoint, or more commonly follows a `key_evidence` ref directly to the exact underlying event. The harness validates that a checkpoint's `turns_covered` range and cited turn numbers match the input it was built from, so a checkpoint can never claim coverage it does not have.

If the checkpoint call fails or returns invalid output, the harness retries once and then falls back to purely mechanical trimming, recording an operational warning. Compaction never blocks the turn on a failing compactor. The mechanical fallback still protects obligations and makes the gap visible:

- the prior active checkpoint, when one exists, stays in the prompt unchanged, so its `outstanding_requests` remain visible verbatim;
- the turns of the compacted span leave the prompt and are replaced by one omission marker such as `[TURNS 11–25 OMITTED — compactor unavailable; use context_retrieve inspect turn_number to recover them]`;
- the next successful compaction receives the omitted span again as part of its input, so its obligations are extracted then.

### Layer 2: in-turn linearization (mechanical, no LLM)

If the prompt is still above the target after the history checkpoint—or layer 1 was skipped because no completed history lies outside the verbatim window—the harness compacts inside the current turn. This layer is purely mechanical: older tool calls are rewritten into one-line activity entries. No model call, no schema, no latency, fully deterministic. The current user query itself is never linearized or summarized.

This is how a single enormous turn is handled. When the first message of a task drives sixty tool calls and crosses the trigger, there is no history to checkpoint; the turn itself is made lean by linearizing its older calls while the newest work stays intact.

Walking backward from the newest tool call, calls and their results stay intact while they fit within the `30,000`-token intact in-turn window. Every older call is linearized with one bounded line:

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
- Every line ends with the evidence handle for that call, such as `[e14]`. Everything else—the complete input and the complete result—is behind that handle and resolvable through `context_retrieve` `inspect`.

Linearization reduces a hundred-call turn from potentially 80–150k tokens to roughly 3–4k. It is lossless where it matters—inputs stay exact—and it works because tool outputs are already bounded at ingestion (see below). A representative linearized block:

```text
[TURN 12 — tool activity]
- read memory/compact.ts (lines 1–120) [e10]
- terminal: pytest tests/memory/ → 2 failed (assert source_ref is None) [e11]
- edit memory/compact.ts (+3 −1) [e12]
- edit memory/rebuild.ts (+2 −0) [e13]
- terminal: pytest tests/memory/ → 24 passed [e14]
```

The same grammar renders the tool inventory of an oversized N−1 turn in tier 2 of history attachment.

Linearization runs only when the trigger fires, never proactively on every step. Rewriting earlier calls on each step would change the middle of the prompt on every request and invalidate the provider prompt cache each time; trigger-based linearization changes it once per compaction.

### Bounded ingestion

Every tool result is bounded when it enters the prompt, before any compaction decision. A result larger than its per-result bound (initially `2,000` tokens) is stored completely in the event log and appears in the prompt as a bounded excerpt plus a retrievable reference. No unbounded content ever enters the working prompt, which is what guarantees that layer 2 can always reach the target mechanically.

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

If the prompt is still above the target after layer 1 and layer 2—which bounded ingestion makes effectively unreachable—the harness shrinks the intact in-turn window and hard-truncates excerpts, then logs an operational warning. It never silently sends an over-budget request and never pretends the context is smaller than it is.

### Compaction count and rollover

Each time the `160,000`-token trigger fires inside a task chat counts as exactly one compaction, whether it ran layer 1, layer 2, or both. The count belongs to the chat, not the task.

A chat holds at most five compactions. When the trigger would fire for the sixth time in the same chat, the harness performs the automatic task rollover described in `Goal-router.md` ("Task rollover") instead of compacting: it writes a handover capsule, closes the chat, and continues the same task in a linked continuation chat whose count starts at zero. A long task therefore appears in Standard view as a chain of chats: chat 1 holds compactions 1–5, chat 2 holds compactions 6–10, and the eleventh compaction-level trigger starts chat 3.

### Continuity guarantees

Compaction never rewrites or deletes the underlying event log. It changes only what the next model request sees. The verbatim history window and the current user message remain exact, the checkpoint and continuation note carry everything older, and every omitted detail remains retrievable through `[TURN k]` labels, checkpoint handles, and evidence handles. Compaction keeps what is owed visible; `context_retrieve` recovers anything exact. Together they are how Socrates never forgets.

Obligations receive special protection: unanswered user requests survive compaction verbatim inside `outstanding_requests`, are visible in every subsequent request, and are carried forward across checkpoint generations until resolved. Compaction can compress what happened; it can never silently drop what is still owed.

The Main Coding Agent's final result is:

```text
VISIBLE ANSWER
The response shown to the user.

CONTINUATION NOTE
A short statement of the task's verified progress, unresolved work, and important constraints.

TASK COMPLETION (optional)
complete: The task's objective is met and verified.
reason: One short sentence. Absent when the task continues.
```

The continuation note is not a second visible answer and is not produced by another agent. The task-completion proposal is recorded by the harness and can always be overridden or reopened by the user — the user has the final say.

## Provider independence

The harness owns one normalized internal contract:

- system and user messages;
- assistant text and reasoning metadata where available;
- JSON-Schema-compatible tool definitions;
- tool calls and tool results;
- streaming text and tool-call deltas;
- token usage;
- cancellation and provider errors.

Each provider adapter translates between this contract and its API. Goal routing, compaction, permissions, tool execution, and persistence never import provider-specific SDK types.

Provider-specific features are optional optimizations. The harness must still work when a model supports only ordinary messages and function calling.

## Prompt caching

The cacheable prefix remains stable:

1. core system prompt;
2. fixed behavioral rules;
3. the ten permanent tool schemas in a fixed order.

Goal notes, exact history, current user messages, and dynamically activated capabilities come afterward.

Further rules:

- Do not put timestamps, request identifiers, paths that change each turn, or capability catalogs in the stable prefix.
- Do not reorder permanent tools between calls.
- Keep the goal's five-Skill shelf stable until the goal changes; place it after the permanent prefix.
- Treat likely candidates as task-specific dynamic context and omit the block when neither kind clears its threshold.
- Append dynamic MCP tool schemas after the permanent tools.
- Keep full Skill instructions out of the prompt until activated.
- Preserve provider prompt-cache handles when the API supports them, without making the core depend on them.
- Compaction replaces content only in the dynamic suffix, never in the stable prefix. A history checkpoint, once written, is frozen text: it does not change between steps of the same turn, so the post-compaction prompt remains cache-stable from that point forward.

## Safety and long-running work

- Filesystem tools resolve paths against the selected workspace and enforce the chosen access policy.
- Terminal commands use the same workspace and approval policy.
- Every mutating tool records its effect before the next model step.
- Terminal sessions persist independently of one HTTP request and can be rediscovered, read, awaited, or stopped in later turns.
- Cancellation propagates to model requests and tool execution.
- Step, time, and token limits are configurable safeguards, not a tiny fixed loop count.
- If a limit is reached, the harness saves the exact state and reports what remains instead of pretending the task completed.

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
