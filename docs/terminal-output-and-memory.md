# Long terminal output, app-owned work memory, and answer grounding (plan, agreed 2026-10-11)

Plan only: nothing here is built yet. Baseline `socrates-v2` at `4b64bc3`. When a phase ships, `architecture/*.md` and the trial log describe what was built; this file stays the plan.

This plan started from a fuller draft by Codex (11 Oct, kept outside the repo). The user agreed a smaller split: build the core of each feature now, and only add the rest once real use shows it is needed.

## Order

One phase at a time. Ask the user before starting each one.

| Phase | What | When |
|---|---|---|
| **T1** | Terminal output saved outside the ledger, with clear scoping, a preview and a reference | Done (trial log 58) |
| **M4a** | Work memory moves out of the user's repositories into Socrates' own folder, with the same structure | Done (trial log 59) |
| **G1** | Answer grounding and routing fixes from the 11 Oct replays | Done (trial log 60) |
| T2 | Log viewer, export, pinning, stream provenance, disk-pressure handling | Later, if T1 use asks for it |
| M4b | Restart-safe memory jobs, revision history in Settings, merging and tidying | Later, after real use |

Agreed decisions:

- Terminal outputs are saved in Socrates' data folder. Each output is scoped and labelled so the agent can never mistake one chat's or command's output for another's (below, "Scoping").
- Cleanup starts at **15 days** and **1 GB** total. Both are settings, not constants, tuned as volume becomes clear.
- The agent's preview of long output drops from about 9,500 tokens to **4,000–5,000** (start at 4,500, tunable). Check that the smaller preview actually helps rather than causing more reads.
- Work memory keeps **exactly the structure agreed in M3b** (an index `MEMORY.md` pointing to topic notes and to turns). Only its location changes: Socrates' folder, never the user's repository. A memory system the user keeps inside their own repository is theirs and stays completely separate.
- G1 covers the three remaining replay issues: unsupported personal inferences, invented time and cause wording, and routing (one misroute and avoidable router retries).
- Not in this plan: confirming the DeepSeek model version (the provider only reports `deepseek-flash`) and the slow PTY test under a loaded suite.

## Why

**Terminal.** A finished command's retained output (up to 16 million characters, `output_full`) is saved inside its tool-result event, in the append-only `events` table that the ledger is rebuilt from. One noisy build can grow the event log by megabytes. Background output only lives in a memory buffer that drops its oldest text when full (4 million characters), and nothing survives a restart. Tab ids (`term-N`) and names repeat, and sessions are shared per workspace folder (`origin` such as `g2/t3` is just a label). So the agent can read output from another chat's command, or from an earlier run of a restarted tab, without a clear sign that it is not its own.

**Memory.** Work memory is written to `<workspace>/.socrates/MEMORY.md` and `.socrates/memory/<topic>.md`. That puts generated files in the user's repository. It is also **the same path the live v0.1.20 app uses** for its own project memory (one exists at `Work/TU/.socrates/MEMORY.md`, in v0.1.20's format). If v2 works in such a folder, it would inject that file as its own index and could edit a file the live app owns. No v2-written work memory exists yet, so moving now needs no migration.

## T1: terminal output saved outside the ledger

### Storage

- Every process run gets an immutable **output id** (`out_…`) when it starts. A restarted tab is a new run with a new id; the old output stays readable under the old id.
- Output is appended to `<SOCRATES_HOME>/artifacts/terminal/<output-id>/output.log` as it arrives (default home `~/.socrates-v2`), next to a small `meta.json`. RAM keeps only the live buffer the panel and `terminal_control` already use.
- `meta.json` records everything needed to know whose output it is (next section), plus start and end time, exit code or signal, bytes written, and whether capture is complete. If a write fails or the app crashes mid-run, the output is marked **incomplete**. It is never presented as full.
- New tool results keep only a preview and the output id in the event. `output_full` is no longer written into events. Old events keep working unchanged: `context_retrieve` and the server read their `output_full` exactly as today.

### Scoping: the agent must never read the wrong output

Each output is bound to its origin, recorded both in `meta.json` and in the ledger. The existing `terminal_started` and `terminal_exited` events gain the output id; the event row already carries goal, task, chat and turn.

| Field | Meaning |
|---|---|
| `output_id` | This run only. Never reused. |
| `workspace` | The folder whose supervisor ran it. |
| `session` / `generation` | The tab (`term-N`, name) and which run of that tab this is. |
| `origin` | The goal, task, chat, turn and tool call that started it, or **you** for a shell the user opened from the panel. |
| `command`, `cwd`, `started_at`, `ended_at`, `exit` | What ran, where, when and how it ended. |

Rules:

1. **A tool call's evidence points to exactly one output id.** `context_retrieve inspect` on that call reads that output and no other. A later command with the same name or tab never replaces it.
2. **Every read is labelled.** Any output returned to the agent (preview, page, search hit) starts with one header line: command, who started it (this chat/turn, another chat by name, or the user), when, and status. The agent always knows whose output it is looking at.
3. **Reads stay inside the workspace.** `terminal_control read` with an output id only works for outputs of a workspace the turn can use. Other ids are refused with a clear error.
4. **Cursors belong to one run.** A read cursor is tied to its output id and generation. After a tab restart, an old cursor is refused ("this tab was restarted; output `out_…` is the earlier run") instead of silently reading the new run.
5. **Shared tabs stay shared, but visible as such.** Agent and user tabs in the same project remain visible to each other (current behaviour), but listings and headers show the origin. A user shell is never presented as the agent's own command.
6. **Folders are not the scoping mechanism.** Output folders are flat by id, and scope lives in the metadata and the ledger. A background server started in one chat and checked in another must still resolve correctly, which a per-chat folder could not do without copying.

### What the agent sees

- `terminal` returns: status, exit code, a head-and-tail preview within the preview budget (default **4,500 tokens**, setting `terminal.previewTokens`, range 4,000–5,000), the total size, and the output id. Short output is returned whole, as today. The universal 10,000-token result ceiling is unchanged.
- `terminal_control read` accepts an output id as well as a live session. It supports reading a line range, and literal search returning matching lines with a few lines of context. Results are bounded and say how much was scanned, so a partial scan never claims "no match".
- `context_retrieve inspect` on a past terminal call pages through the saved file by line range.
- History and compaction keep the preview and the output id, never the full log.
- The tool descriptions (fixed prompt) change only by a few words. `fixed-overhead.test.ts` keeps its budget.

### Cleanup

Settings, all tunable:

| Setting | Start |
|---|---|
| `terminal.retentionDays` | 15 |
| `terminal.totalCapBytes` | 1 GB |
| `terminal.perOutputCapBytes` | 100 MB |

- Cleanup runs at startup and every few hours. It removes outputs of finished runs older than the retention period, then the oldest finished ones until under the total cap. A running capture is never removed.
- A removed output leaves its metadata, so a read says "output `out_…` was removed after 15 days" instead of "not found".
- If one run passes its own cap, capture stops, the run keeps going, and the output is marked incomplete from that point. A server is never killed because its log is large.

### Checking that the smaller preview helps

Inspect counts, per long-output command, how many follow-up reads the agent made and how many tokens they cost. A fixed set of long-output tasks (a failing test run with the error in the middle, a long build log, a large `git log`) is run once at the old ~9,500-token preview and once at 4,500, comparing correct answers, total tokens and number of reads. If 4,500 causes many more reads with no saving, raise it within 4,000–5,000 or revisit.

### T1 acceptance checks

- A huge output with a unique marker in the middle: found through `terminal_control read` (search), through `context_retrieve` after the turn, and after an app restart, without rerunning the command.
- **Two chats at once** run commands with the same name in the same project, with different output. Each turn reads its own. A cross read is labelled with the other chat's origin, never mistaken for its own.
- A restarted tab: the old cursor is refused, the old output id still reads the first run, and the new id reads the second.
- A user shell's output is labelled as the user's.
- Output from a workspace the turn cannot use is refused.
- Cleanup by age and by cap, the tombstone message, the per-output cap mid-run, and an incomplete marker after a simulated crash.
- Old events with `output_full` still read correctly.
- Unicode split across chunks, a very long single line, and no trailing newline.
- The preview comparison above, plus one isolated DeepSeek Flash run (current configuration) diagnosing an error buried in a long log, on a disposable copy that is deleted afterwards.

## M4a: work memory in Socrates' folder, same structure

### What stays the same

The design agreed in M3b (`docs/memory.md`, "Work memory") is unchanged:

- One **index**, `MEMORY.md`: one line per topic, newest first, held to about 1,500 tokens (enforced). Each line points to a topic note and to the turns it came from.
- **Topic notes**, one procedure or lesson each (steps, pitfalls, evidence turns), short.
- The index is injected as `<WORK_MEMORY>` in the stable part of every request in that project, so it only changes the cached prefix when the index changes.
- The decider is asked after verified work. On yes, the agent gets the bundled writing guide for one short extra step.
- No approval is asked for memory writes. The user is not interrupted.

### What changes

1. **Location.** `<SOCRATES_HOME>/memory/projects/<project-id>/MEMORY.md` and `.../topics/<topic>.md`, with a `project.json` recording the project's folder. Nothing is written in the user's repository.
2. **Which project.** The project is the goal's bound workspace folder. For a Git repository, the id comes from Git's shared directory, so worktrees of one repository share memory. Otherwise it comes from the folder's real path. A General conversation with no project bound has no work memory; personal facts keep going to user memory as today.
3. **How the agent reads a topic.** The index lines point to topics by name (`→ topic store-schema · turns 41, 58`), not by file path. The agent opens a topic with `context_retrieve inspect` (a new topic ref) and a turn with `context_retrieve inspect` as today. `context_retrieve memory` also searches topic notes (keyword plus the existing meaning index), so topics that dropped out of the index are still found. The ~100-token reading instructions in the system prompt change from "open with `read`" to this, within the fixed-overhead budget.
4. **How the agent writes.** During the memory step, the agent's tools are replaced by a **memory-only tool** (read topic, write topic, update index) plus `context_retrieve`. It cannot run commands or edit project files in that step. Names, topic size and the index budget are checked by the harness. Each write is recorded as an event carrying the new text, so the files can be rebuilt from the ledger and earlier versions are kept (the basis for M4b's history view).
5. **After the answer, without holding the chat.** The final answer is saved first. The memory step then runs in the background, one at a time per project, and the chat's queue moves on. Today the answer is saved only after the memory step ends, so the next queued message waits. If the app stops mid-step, the step is lost and logged as skipped (restart-safe jobs are M4b). Inspect shows the step as pending, written, skipped or failed.
6. **Who qualifies.** The "at least three tool calls" rule is replaced. The decider is asked when the turn made **at least one successful** change or command (`edit`, `apply_patch` or `terminal` that did not fail). A short, verified two-step fix can now be recorded. A turn whose changes all failed is not asked.
7. **Repository files are just files.** Socrates no longer reads `.socrates/MEMORY.md` (or anything else) from a repository as its memory. The approval exemption for `.socrates/` memory paths in `packages/tools/src/access.ts` is removed, so writing there asks like any other file. Any `MEMORY.md`, `AGENTS.md`, `CLAUDE.md` or `.socrates/` the user keeps in their repository is theirs: Socrates may read it like any file when the task needs it, but never treats it as its own memory and never writes it on its own.
8. **No migration.** v2 has written no work memory into repositories. Files found there, including v0.1.20's, are left untouched and not imported.

### M4a acceptance checks

- Verified work in a project writes its index line and topic under `~/.socrates-v2/memory/projects/…`. The repository's `git status` stays clean.
- A fresh chat in that project gets the index in `<WORK_MEMORY>` and opens the topic through `context_retrieve`. A different project does not see it. Two worktrees of one repository share it.
- A folder with v0.1.20's `.socrates/MEMORY.md` (copy of the `TU` layout in a temp folder): v2 neither injects nor changes it.
- The memory-only tool refuses anything outside memory. The memory step cannot run a command.
- The answer is saved and the chat's next queued message starts before the memory step finishes. Stopping the app mid-step loses only that step.
- A two-call verified fix is asked about. A turn whose only edit failed is not.
- "Save new memories" off: no step runs. "Use memories" off: no `<WORK_MEMORY>`, and topics are not searched.
- The stable prefix is byte-identical between two turns when the index did not change. The fixed-overhead budget holds.
- One isolated DeepSeek Flash run on a disposable copy: a small recurring change done twice, where the second turn updates the same topic instead of duplicating it.

## G1: answer grounding and routing

Issues left by the three replays of 11 Oct (trial log entry 56):

1. **Unsupported personal inferences.** One greeting said the user was in Amsterdam, because in the terminal test they had named it as a city they would *like* to live in. Rule: state what the user said, not a stronger claim built on it (wanting to live somewhere is not living there). Facts about the user's current life come only from what they said or confirmed, never from files or tool output.
2. **Invented time wording and causes.** One reply called 00:49 "Friday night" and explained the gap before a retry with a reason no record supported. Rule: state times as recorded (weekday, local time), don't relabel them, and don't explain why something happened unless the record says so.
3. **Routing.** One follow-up about General history was routed to a project. The router also still makes avoidable repair calls (invalid General task fields). Add these cases to the routing fixtures, tighten the router prompt only where the fixtures show it is needed, and track the retry rate in `eval:router-compare` and Inspect.

As built (trial log 60): the validator accepts answers that select the same place in other words and records them as `normalized`, the router prompt says never to answer the message itself, the worker prompt's first line carries the two grounding rules within the same budget, router-compare counts repairs, and Inspect has a **Router retries** panel.

Checks: fixtures in the answer and routing tests; `pnpm eval:router-compare` before and after; the same three-copy replay used for entry 56 (disposable, deleted after), with the follow-up question, judged on these three points as well as chronology. Prompt changes stay inside the fixed-overhead budget.

## Later

- **T2:** a searchable log viewer and export in the terminal panel and Inspect; pinning outputs past cleanup; separate stdout and stderr; handling a slow or full disk without losing the live preview.
- **M4b:** restart-safe memory jobs; topic revision history and editing in Settings > Memory; merging and fading duplicate or stale topics; measuring on real use whether later conversations follow the notes better than without (the open item from M3b).
