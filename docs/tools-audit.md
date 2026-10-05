# Tools audit: grep, glob, edit, terminal, terminal_control

Written 2026-10-05 for Phase 4. It compares Socrates' five working tools with the harnesses they must match:

- **Claude Code:** Glob, Grep, Read, Edit and Write, Bash, and the background-shell tools (read a shell's output, kill a shell).
- **Codex:** `exec_command` and `write_stdin`, the unified exec, which runs in a PTY by default (`codex-rs/core/src/tools/handlers/shell_spec.rs`), plus the freeform `apply_patch`.
  - Codex has no file-search tools of its own: it searches with `rg` through `exec_command`, so for grep and glob the bar is Claude Code's tools plus everything `rg` can do from a shell.

Each gap names the step that closes it:

- **4a:** search;
- **4b:** edit;
- **4c:** terminals;
- **4d:** the live coding eval.

**Kept:** "kept" marks a deliberate difference that stays.

## grep

| Capability | Claude Code / Codex | Socrates before 4a | Gap and fix |
|---|---|---|---|
| Output modes | Grep: `content`, `files_with_matches` (its default), `count`; Codex: any `rg` flags | matching lines only | **4a:** `output: "content" \| "files" \| "count"`; content stays the default, since it has been since PR1 |
| Context lines | `-A`, `-B`, `-C` | none; the agent called `read` | **4a:** `context_before`, `context_after`, `context`: each match carries the lines around it |
| Multiline | `multiline: true` (`rg -U --multiline-dotall`) | single-line only | **4a:** `multiline` |
| File types | `type` (`rg --type`, e.g. `py`, `rust`) | `glob` only | **4a:** `type`, with a corrective error for an unknown type |
| Several file filters | one glob with braces (`*.{ts,tsx}`) | one glob (braces already work through `rg`) | documented; negation (`!**/fixtures/**`) works too |
| Ignored files | Grep respects `.gitignore`; `rg --no-ignore` from a shell | always skipped | **4a:** `include_ignored` (`.git` and Socrates' protected folders stay excluded) |
| Order | file lists by modification time; content by `rg` order | stable path order | **4a:** `sort: "path" \| "modified"` (newest first); files and counts default to `modified`, content to `path` |
| Paging | `head_limit`, `offset` | `limit` and a frozen-snapshot `cursor` | kept: a cursor pages an exact snapshot, which an offset over a changing tree cannot |
| Long lines (minified files) | `rg --max-columns`, or Grep's truncated lines | first 500 characters, so a match at column 3,000 was invisible | **4a:** a 500-character window centred on the match |
| Non-UTF-8 files | `rg` prints bytes | matches silently dropped | **4a:** decoded with replacement characters and marked `encoding: "not_utf8"` |
| Binary files | skipped by `rg` | skipped by `rg` | kept |
| Huge trees and slow searches | shell timeout | ran until cancelled | **4a:** a `60`-second limit with a corrective `search_timeout` that says to narrow the path, type or glob |
| Case | `-i` | `case_sensitive` (no smart case) | kept |

## glob

| Capability | Claude Code / Codex | Socrates before 4a | Gap and fix |
|---|---|---|---|
| Order | Glob: newest modification first | path order | **4a:** `sort: "modified"` (the new default) or `"path"` |
| `.gitignore` | respected, with no way back in | respected, with no way back in | **4a:** `include_ignored` for `node_modules`, `dist` and similar |
| Limits | Glob shows the first 100 and says it truncated | `limit` (default 200, max 1,000) and a cursor; at most 50,000 collected | kept |
| Hidden files | included | included; `.git` excluded | kept |

## edit (step 4b, done)

**What already matches or exceeds them:**

- `replace_all`, with exact-once uniqueness and the line numbers of every occurrence;
- whitespace, indentation and typographic-punctuation tolerant tiers, with no fuzzy similarity;
- a stale-read check by content hash;
- the byte-order mark and the majority line ending preserved;
- atomic writes that keep the file mode;
- a 20 MB limit with a corrective error;
- no-op detection;
- a bounded diff.

| Capability | Claude Code / Codex | Socrates | Gap and fix |
|---|---|---|---|
| Several edits to one file | Claude Code applies them in one call (MultiEdit, now folded into Edit); Codex uses one patch with several hunks | one replacement per call | **4b:** `edits: [{ old_text, new_text, replace_all? }]`, applied in order to the evolving text, all or none |
| Creating files | Write, and Edit with an empty `old_string` on a new path | refused (`apply_patch` creates files) | **4b:** an empty `old_text` creates a missing file; it never overwrites |
| Mixed line endings | each line's ending is kept | **bug:** every line is rewritten with the majority ending, so a file mixing `\r\n` and `\n` changes far beyond the edit | **4b:** endings preserved per line; edited lines take the ending of the line they replace |
| Read before edit | Claude Code requires a Read first | the stale check covers files read; unread files may be edited, because `old_text` proves the content | kept, and documented |
| Near-miss help | Claude Code reports "string not found" | the line where the first line of `old_text` appears | **4b:** the closest region by whole-line comparison, with the lines that differ shown side by side (a suggestion only, never applied) |
| Encodings | Claude Code reads and writes UTF-16LE files | UTF-8 only; UTF-16 is refused as binary | **4b:** UTF-16LE and UTF-16BE detected by their byte-order mark, edited, and written back in the same encoding |
| Symlinks | edits the target | the path is resolved to its real target before writing (checked in 4b) | **4b:** verify and test |
| Large files | read in pages | edits up to 20 MB | kept |

`apply_patch` gets the same line-ending and encoding fixes in 4b, since it shares the file layer.

## terminal and terminal_control (step 4c, done)

**What already holds:**

- persistent named sessions and automatic hand-off of long commands;
- yield versus deadline (`yield_ms` versus `timeout_ms`);
- readiness by output pattern or port;
- sessions in their own process groups, with group kill and a `SIGTERM` then `SIGKILL` shutdown;
- processes a finished command leaves behind are stopped;
- all sessions stopped on server shutdown;
- retained scrollback with cursors and explicit output loss;
- UTF-8 decoded across chunk boundaries;
- the harness's keys stripped from the environment;
- sixteen live sessions at most.

| Capability | Claude Code / Codex | Socrates | Gap and fix |
|---|---|---|---|
| PTY | Codex `tty: true` (Claude Code's Bash has none) | `pty: true` fails with `pty_unavailable` | **4c:** a real PTY through `node-pty`, which is native, so its install is checked first; pipes stay the default |
| Keys | Codex writes raw bytes to stdin | ENTER, CTRL_C and CTRL_D; TAB, ESCAPE and arrows refused | **4c:** every key sent as its terminal bytes in a PTY; more keys (`CTRL_Z`, `BACKSPACE`, `HOME`, `END`, `PAGE_UP`, `PAGE_DOWN`, `DELETE`, `CTRL_L`) |
| Waiting for input | Codex polls with an empty `write_stdin` | `input_required` is always null | **4c:** in a PTY, a session that has printed nothing for a moment after a prompt-like last line is reported as waiting for input |
| Output budget | Codex `max_output_tokens` (default 10,000); Claude Code cuts at 30,000 characters | fixed at the 10,000-token result ceiling | kept: the ceiling is the harness rule, and `terminal_control read` pages the rest |
| Filtering output | Claude Code's background-shell reader takes a regex filter | `read` pages everything | **4c:** `read` with `filter`, only the lines that match |
| Unicode | (no guarantees stated) | decoding is correct, but head and tail cuts and page splits could split a surrogate pair | **4c:** cut on code-point boundaries, with tests using emoji and CJK |
| Window size | Codex sets one | none (pipes) | **4c:** PTY sessions start at 120×40 and accept `resize` |
| Cleanup on a hard crash | Codex reaps on restart | sessions die with the server only on an orderly stop | **4c:** a record of live process groups in the data folder, and groups left by a crashed server stopped at the next start |
| Flaky closure test | n/a | `closure.test.ts` sleeps a fixed 100 ms | **4c:** waits for the full output instead |
| Login shell | Codex `login` | `bash -c` with a clean, non-interactive environment | kept: predictable over personal |
| Persistent working directory between commands | Claude Code keeps `cd` | each command starts in its `cwd` | kept: explicit `cwd` and named sessions are clearer for a harness that runs lanes in parallel |

## Step 4d

A live eval in which DeepSeek Flash does real multi-file work in a sample project:

- finding code with grep and glob;
- editing several files;
- running the tests and fixing what fails;
- running a dev server as a named session and checking it;
- answering an interactive prompt in a PTY.

The transcript and the results go to `docs/reviews/` as before.
