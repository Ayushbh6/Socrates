# One conversation, many strands: the multitasking plan (2026-11-08)

Socrates' reason to exist is that the user never manages chats, projects or sessions: they talk, and Socrates places the work. Until now that held for *where* a message belongs (the Goal Router) but not for *when* it runs: Flow's main conversation took one message at a time, and parallel work happened only when the user chose **Send in a new lane** themselves. That put the burden back on the user, exactly like opening a second terminal.

This plan makes concurrency a routing outcome. The user types; Socrates decides whether the message joins work that is running, starts beside it, or answers at once from what it sees.

## The decision table

| The message routes to… | What happens |
|---|---|
| a task nobody is working on | it starts now, beside the running work, in a lane Socrates opens itself (up to the 4-lane cap; beyond it, it waits for a slot) |
| the task a lane is working on | it is handed to that lane (as before) |
| the task the main conversation is working on | phase A: it waits for that turn and runs next; phase B: it is steered into the running turn between steps |
| a question about running work | `general`, answered at once from what every strand sees of the others |
| an unclear goal | one routing question; nothing else is blocked |

**Queue** remains an explicit choice ("after the current work"), and **Send in a new lane** remains an explicit override, but neither is needed any more.

## Phases

- **A. Routing-first dispatch (this release).** `send` to main while main works is no longer refused with `main_busy`: the harness takes it with `lane: "auto"`, records it in the main conversation, routes it, and once its task is free places it in main if main is free, else in a new lane (the turn moves there, `turn_moved_to_lane`, reported as `handed_off` with `reason: "parallel"`), else waits for a slot. Every strand's turn gets `<LANES>` listing the other strands, including the main conversation's running turn, so a progress question is answerable wherever it runs. The main conversation's history for routing and for General includes turns that were moved out of it, since the user wrote them there. The Flow canvas follows a message to the lane it was placed in. The 4-lane cap is unchanged.
- **B. Steering.** A message routed to the task a strand is working on is delivered to that run between steps as a mid-turn instruction (as message steering in Codex and VS Code Copilot), instead of waiting for the turn to end. Stop and pause words become controls on that strand.
- **C. The board.** The Flow canvas shows live strands and attaches each message to the strand it joined.
- **D. Real tests.** A scripted multi-project scenario against the live server with real models on a disposable copy of the data: interleaved messages for two or three projects with steering and status questions, scored on correct dispatch, no cross-talk, and time until each message is placed.

## Budget and models

DeepSeek V4.1 Flash is the worker for every live run; routing is tried on DeepSeek Flash first and GPT-6 Luna otherwise; Kimi K3.1 Pro and GLM 5.3 FlashX only for variance checks. Spend is capped at 2.50 per provider for this round, tracked from `calls.db` and the provider dashboards, and written into each trial-log entry.
