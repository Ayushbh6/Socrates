# Working on Socrates (for any coding agent)

This file hands the project to whichever agent harness works on it next. Read it first, then `docs/trial-log.md` and `git log --oneline -20`.

## Rules from the user

- **Branch:** work only on `socrates-v2`. `main` is the deployed v0.1.20 and must never be touched.
- **Commits and PRs:** never add a `Co-Authored-By` or any model-attribution line.
- **One phase at a time:** code exactly what was asked, for the phase agreed. Don't mix in other work; propose it instead and wait for a yes.
- **After every change:** typecheck, run the tests, commit, push, then restart the live app (below) so the user can try it.
- **Tell the user what you're doing:** they get impatient when an agent goes quiet. Give a one-line status often, and run long waits in the background.
- **Clean up:** test data goes under `.socrates/evals/<name>` (gitignored) or a temp folder, and is deleted right after use.
- **Docs follow the code:** `architecture/*.md` describes behaviour as built, and `docs/trial-log.md` records each request (Asked), what was done, and open suggestions. Update both in the same commit as the change.
- **Reviews:** a reviewer agent writes `docs/reviews/*`. Run `git fetch` and check the log before pushing, and never overwrite review files.

## Running it

- **Live app:** `pnpm socrates` builds the web app, serves http://127.0.0.1:4200 with data in `~/.socrates-v2`, prints a one-time login link and opens a browser tab. Keep it running in the background with output in `.socrates/app.log`. To restart: `lsof -ti tcp:4200 | xargs kill`, then `pnpm socrates > .socrates/app.log 2>&1` in the background.
- **Checks:** `pnpm typecheck`, `pnpm test` (Vitest), and `pnpm --filter @socrates/web build`.
- **Flaky test:** about one full run in three, `packages/agent/test/review-regressions.test.ts` "cancels a pending approval at the turn deadline" fails, because it uses a 40 ms deadline. It passes when run on its own.
- **Trying things on real data without touching it:**
  1. Copy `~/.socrates-v2` to a temp folder and delete `terminals.json` and `.server-lock.db*` from the copy.
  2. Run `SOCRATES_HOME=<copy> SOCRATES_PORT=4300 pnpm exec tsx apps/server/src/main.ts`.
  3. Open the printed link. Each login link works only once.
  4. Stop the server and delete the copy afterwards.

## Where things stand (2026-10-10)

The design lives in `architecture/` (`agent-harness.md`, `Goal-router.md`, `server.md`, `web.md`, `observability.md`). The trial log numbers each change. Recently shipped, newest last:

- **Terminals:** the agent's terminals show the screen as drawn, support timed waits and can watch several sessions. A terminal panel at the bottom of the page lets the user watch, type, stop and restart; the agent holds off for 8 s after the user types.
- **Chat names:** a non-thinking model names chats. By default that is `qwen/qwen3-30b-a3b-instruct-2507` on OpenRouter; it can be chosen in Settings > Chat names and applies without a restart.
- **Status:** the user sets goal and task status (open, completed or superseded). Flow mode has "Keep my next message in this task". The agent never closes standard-mode chats.
- **Standard-mode chats work at once:** each runs as its own lane would, with at most 4, a queue per chat, Stop per chat, and approvals shown under the question that asked. Standard mode no longer has lane panels.
- **Sidebar menus:** a goal's or chat's actions sit behind one ⋯ menu in the Standard sidebar.
- **Tools without a workspace:** a workspace is only where a turn starts; with no folder, work starts in the home folder and asks before paths outside the user's folders.
- **General by day:** the General goal holds one task per day ("General · Fri 9 Oct"), listed under Chats in Standard.
- **Failures look the same:** every failed tool call, or command that exits non-zero, gets the red ✗ and counts as "N tool calls failed".
- **Lean fixed prompt:** the system prompt and tools are about 5.4k tokens per request (was 7.4k); `packages/agent/test/fixed-overhead.test.ts` holds the budget.
- **Redo in another task:** a misrouted question is asked again in a chosen task ("Redo in…" on the route line); the first attempt is set aside, never moved (`architecture/agent-harness.md`, "Redo in another task").
- **Memory, phase M1:** Socrates remembers the user across goals: `<MEMORY>` in every request (who they are, how they like to work), saved from the final answer's `memory` field without asking, shown under the answer with Undo, and listed in Settings > Memory with two switches (`architecture/agent-harness.md`, "Memory"; the full plan is `docs/memory.md`).
- **Memory, phase M2:** other entries (knowledge, and what does not fit in `<MEMORY>`) are recalled when a message bears on them (`<MEMORY_CANDIDATES>`, from keywords and meaning) and found with `context_retrieve` `memory`; `pnpm eval:memory` measures recall and precision with the local embedder.
- **Memory, phase M3a:** a small decider (`perplexity/pplx-decider-v1.1-27b` through OpenRouter, on by default with an OpenRouter key, switchable in Settings > Memory) is asked two yes/no questions about each message beside the turn's searches: would a recall help (widens `<MEMORY_CANDIDATES>`, or tells the agent to look first), and is something worth saving (a one-line `<MEMORY_HINT>`; the same agent saves, there is no curator model). Calls are logged with role `decision`, the Inspect overview has a **Memory decider** panel, and `pnpm eval:decider` (needs `SOCRATES_ENV_FILE=.env`) scores it on 78 labelled messages (`architecture/agent-harness.md`, "Memory"; `docs/memory.md`).

## Next, in the order agreed with the user

Ask before starting each one.

1. **Memory and personalisation, M3b** (`docs/memory.md`): per-project work memory in `<repo>/.socrates/MEMORY.md` (how things are done here, lessons, where things are), written with the edit tools after verified work, read as an anchor, and nudged by a decider question after a turn of real work. Also on the list from the M3a trial: let the router see the profile and the matching entries, so "my trip" does not stop at a clarification.
2. **Standard to flow:** a richer design for moving between the two modes.
3. **Continue button:** offer one after a safeguard stop (200 steps, 60 minutes, or the token limit).

**Known small issues:**
- If attaching images fails while saving a Flow message, the main conversation can stay "busy". This is in `packages/agent/src/socrates.ts` `handle`.
- In Standard mode, the composer's unsent text is shared across chats.
