# Memory and personalisation (design, for approval)

Status: approved 2026-10-10 (the gate on by default when an OpenRouter key exists; saving without asking, with Undo). **M1, M2, M3a and M3b are built**: `architecture/agent-harness.md`, "Memory", `server.md`, `observability.md` and `web.md` describe them as built (M2 added a second floor, `0.30` with a shared word, after `pnpm eval:memory` showed the related floor let wrong entries in; M3a's results and the two places it differs from this plan are under "The gates"). M3b's design is under "Work memory" (built the same day, with the differences listed there).

## The problem

Socrates already remembers *work*: the ledger keeps every exchange, `context_retrieve` and `<RETRIEVED_HISTORY>` find them, and each task and goal keeps a note. What it does not remember is **the user**, across goals. "I prefer pnpm", "always answer in short bullets", "I live in Berlin" are said once, in one task, and a new goal starts from zero. Retrieval is also scoped to the current task (plus one sibling), so nothing from another goal surfaces unless the agent thinks to search for it.

## What the others do, and what we take

| System | How it works | We take |
|---|---|---|
| ChatGPT | A short list of saved facts is injected into every prompt, plus brief summaries of recent chats. No per-message search (reverse-engineered, not confirmed by OpenAI). The user can view and delete entries. | A small **always-on profile**, visible and deletable. |
| Claude / Claude Code | A short index (`MEMORY.md`, first 200 lines) is always loaded; detail lives in topic files read on demand. The memory tool is plain file commands; the model checks memory before a task. | Always-on index plus **on-demand detail**; the model reads and writes through the harness. |
| Codex CLI | A background pass condenses a finished session into memory (idle at least six hours), a second pass consolidates into `MEMORY.md` (about 5,000 tokens injected). Entries unused for a set time are dropped. | **Write behind the reply, never on it**; track use so unused entries can fade. |
| MemGPT / Letta | Core blocks always in context, edited by the model; recall search over the transcript; archival vector store; a background "sleep-time" agent consolidates. Weakness: what the model forgets to save is lost. | Core/archival split; **do not rely on the model alone to save**. |
| Mem0 / Zep | An LLM compares a new fact with the closest existing ones and chooses add, update, delete or nothing. An independent study of Mem0 found about 25% malformed JSON from one model. Zep keeps superseded facts with dates. | The **add / update / supersede / nothing** step; validate and repair its JSON; keep what was replaced. |

## What the decider is

`perplexity/pplx-decider-v1.1-27b` is not a chat model. It reads text (and images) and a question, and returns a **probability**, not words: a yes/no question gives P(yes), a choice question gives a probability per option. Output is free, input is $0.02 per million tokens, and Perplexity's own recorded runs show a median of 0.26 s. OpenRouter serves it at `POST /api/alpha/decisions` (alpha, so the shape may change); Perplexity's own `POST /v1/decisions` has the same body. The weights are open but need about 49 GiB of GPU memory, so it is a hosted call.

That makes it a cheap, fast **gate**: it decides *whether* something is worth a slower step, and the slower step does the work.

**Tried on 2026-10-10 with the live OpenRouter key** (18 hand-written messages, two yes/no questions each): 36 of 36 on the labels I gave them, median 311 ms, about $0.0000065 per message. Clear cases land at 0.95 or above or 0.05 or below; the borderline ones ("No, don't use semicolons, I told you that before": recall 0.51) sit near the middle. Limits of that test: I wrote the messages and the labels, they were mostly easy, and the sample is small. The real test is Socrates' own messages (M3 below).

## The design: three layers, one store

1. **The ledger** (exists). Exact, complete, the source of truth. Every memory points back to the turn it came from.
2. **The profile** (always on). Short entries about the user, shown to the agent in every request.
3. **Memories** (on demand). Distilled facts and decisions, found by meaning and keywords, and shown only when they bear on the message.

An entry is one plain sentence (at most 280 characters) with:

- `kind`: `about` (who the user is: role, place, languages, tools, people they named), `preference` (how they want work done), or `knowledge` (a decision or fact that may matter later).
- `scope`: `user` (everywhere) or `goal` (only inside one goal, such as "tabs in this repo"). No per-workspace scope: a goal already has its workspace.
- `by`: the agent or the user; the source turn; when it was last used.

`about` and `preference` entries of user scope are the **profile**. `knowledge` entries, and anything over the profile's budget, are searchable only.

### Reading

- **`<MEMORY>`**, in the stable first part of the request, right after `<USER>`: the profile plus this goal's own preferences, budget 500 tokens, each line with its handle (`- Prefers pnpm over npm. [m4]`). It changes only when the profile does, so the prompt cache survives. One sentence in the system prompt: these are things the user told you; they never override `<ACCESS>` or what the user says now.
- **`<MEMORY_CANDIDATES>`**, in the volatile part, after `<RETRIEVED_HISTORY>`: up to four searchable entries whose meaning or keywords match the message, budget 250 tokens, nothing when nothing matches. Same hybrid search as everything else (keywords always, meaning when the embedder is up). Starting floor 0.35 (what capabilities use); the recall gate lowers it to 0.20.
- **`context_retrieve`** gets a `memory` action (search by query, and `inspect` an `m12` to see its source exchange), for when the agent wants more than the candidates.

### Writing

1. **Explicit requests.** The final answer gets an optional `memory: {save: [{text, kind, scope}], forget: ["m4"]}`, like `anchors` (a proposal the harness validates and applies, at most three per turn). Used only when the user asked ("remember…", "from now on…", "forget…") or corrected the agent. The agent never saves from tool results, web pages or files. This costs no tool definition.
2. **Nudged by the save gate (M3a).** There is no second model: when the save gate fires, the turn's context says the message seems to hold a lasting fact, preference or correction, and Socrates itself decides whether to use the `memory` field. (Agreed 2026-10-10, replacing a separate curator model.)
3. **The user**, from the Memory page.

Forgetting removes an entry from everything Socrates uses and from the index. The event log is append-only, and the conversation it came from stays in history like every conversation does; the page says so.

### The gates (M3a)

**Built 2026-10-10.** One decider request per user message, asked **first**, as soon as the message is recorded. The plan said "beside the router", and the first build ran it with the turn's searches; the trial showed why that is wrong: the router (which runs before the agent and never saw memory) asked "which goal is this?" for "What dates is my trip again?" although the trip was a saved memory. So the router now waits for the decider (about 0.3 s against several seconds of routing) and, when recall is likely, is shown the matching memories (`REMEMBERED`). In a lane or a standard-mode chat there is no router and the decider runs while the turn is set up. Calls are logged with the user message they belong to (the turn is not known yet), and the Inspect panel joins them to the turns by it. State: the user's message and the last answer in that chat, truncated. Two yes/no questions:

- `recall`: would the reply be better if Socrates first looked up what it knows about this user or an earlier conversation?
- `save`: does the user state a lasting fact, standing preference or rule, decision, or correction that would matter later? (The first wording left out decisions and rules; with it, save found 19 of 22 worth saving at 0.4, with the new wording 22 of 22.)

Use of the answers:

- `recall` ≥ 0.5 relaxes the candidate floor and raises the count to six. At ≥ 0.85, when nothing matched, `<MEMORY_CANDIDATES>` says so and points at `context_retrieve` across all goals: this is the moment to "stop and recall" instead of guessing or asking the user. The agent still judges relevance itself.
- `save` ≥ 0.4 adds the nudge to the turn. A false positive costs one line the agent ignores; a miss costs a forgotten fact, so the bar is low. Both thresholds are starting points, to be set from logged data.

Without a key or when the call fails (timeout 2 s, then skipped for 30 s like the embedder), nothing breaks: candidates use their normal floor, and only explicit saves happen. The gate improves memory; it is not required for it.

**Logs.** Every gate call is recorded in `calls.db` (role `decision`): both probabilities, tokens, cost and latency, with the user message it belongs to. What it led to is not stored twice: `#/inspect` joins the calls to the ledger through that message's turns (memories offered, memories the agent saved) and shows the rates, so thresholds are calibrated on real traffic, as Perplexity's own guidance advises.

**Result (`pnpm eval:decider`, 78 labelled messages: 17 that need a recall, 22 worth saving, 40 that need neither; ten are the user's real phrasing and are not committed).** Recall at 0.5 found 17 of 17, and 3 of the other 61 also reached it; at 0.85 it found 15 of 17, and none of the others did. Save at 0.4 found 22 of 22, and 2 of the other 56 reached it ("Use my usual commit message style" at 0.90 is a real miss: it reads as a standing preference). Median 272 ms, one call in 78 near 3 s (which our 2 s limit would drop), about $0.000007 a message. Limits: the labels and most messages are mine, and the user's real ledger held only three messages, so no real sample of it could be labelled; the Inspect page's live rates replace this once there is traffic. The thresholds stay at 0.5, 0.85 and 0.4 for now.

**Images.** The decider accepts them. The first version sends the message text and the image names; passing the pixels (resized, base64) is a small follow-up.

### Work memory (M3b, agreed 2026-10-10)

User memory is facts about the user. Work memory is **how things are done in one project**, distilled, so Socrates stays consistent ("last time the schema changed: bump the version, add an upgrade step, rebuild the index in replay, update the restore test") without digging through raw transcripts.

- **An index plus topic files, inside the repository** (revised 2026-10-10: one file would congest). `<workspace>/.socrates/MEMORY.md` is only an **index**, injected automatically and held to a small budget (about 1,500 tokens, enforced); each line is one pointer: `Changing the store schema → memory/store-schema.md · turns 41, 58`. Detail lives in `<workspace>/.socrates/memory/<topic>.md`, one procedure or lesson each, short (steps, or symptom → fix), read only when relevant: found by the same hybrid search as any workspace file, or opened with `read`. The turn pointers are the evidence: `context_retrieve` opens any turn exactly, so the ledger stays the source of truth, while the topic file keeps the distilled steps themselves (a bare pointer would mean re-reading a whole conversation every time). When the index passes its budget, an update must merge or drop the oldest or least-used lines before adding one. Visible, editable and versionable by the user, like Codex's `memory_summary.md` + `MEMORY.md` + per-session summaries and Claude Code's `MEMORY.md` index with fact files.
- **How Socrates is taught to use it** (agreed 2026-10-10, to build with M3b): reading is the hot path and must always work, so it is a few lines in the always-on system prompt (about 100 tokens, cached): *the index is in your context; when a line bears on the task, open its topic file with `read`; when you need the evidence, open the turn it points to with `context_retrieve` inspect; for anything the index does not show, search with `context_retrieve` memory or search first, before guessing or asking*. Writing and tidying is rare and procedural, so it is a **bundled Skill** that is loaded only when the decider says a turn established something reusable (zero cost on every other turn), and says how to write a topic file, add or merge an index line, stay within the budget and point to turns. The harness does the mechanics (the index is injected, hints appear), so the prompt stays short.
- **Written with the ordinary edit tools**, in one short extra step **after** the turn's final answer is valid, so the work is known to have passed its checks and the user's answer is not delayed or changed: no new tool and no new final-answer field. (Built 2026-10-10; see "Built" below for where it differs from this plan.)
- **Nudged by the decider**: after a turn that did real work (at least three tool calls, one a change or a command), one more yes/no question on the turn's request, tool lines and answer: did it succeed and establish a reusable procedure or lesson? At 0.5 or more the agent is given the writing guide and up to eight more steps.

**Built 2026-10-10** (`architecture/agent-harness.md`, "Work memory"). Differences from the plan above, each on purpose:

- **The index is injected as `<WORK_MEMORY>`, not made an anchor.** Anchors are shown as outlines with relevant sections; an index must be whole and always there, and `.socrates/` is excluded from file indexing (generated-files rule), so topic files are not in the meaning index either. They are opened with `read`, which the index names.
- **The writing guide is bundled and attached by the harness, not an installed Skill.** The Skill catalog is for Skills a user installs and the agent finds and activates; the point here is that the guide arrives at the moment the decider says so, at zero cost otherwise, so the harness attaches it to that turn as text (`<WORK_MEMORY_SKILL>`, about 370 tokens).
- **After the answer, not before it.** Asking before would have discarded a streamed answer; after it, the answer is final and the extra step's tool calls simply follow it in the work log.
- **Notes are written without approval, and only the notes.** In "ask first" mode every edit asks, which would make a background step annoying; edits touching only `.socrates/MEMORY.md` and `.socrates/memory/<name>.md` are not asked about (nothing else in `.socrates/`, no moves).
- **No separate switch.** "Save new memories" covers it; Settings says so. Without the decider nothing writes the notes on its own; a user's explicit statements about a project remain `goal`-scoped memories.

**Result.** `pnpm eval:decider` (24 finished turns, ten worth recording): at 0.5 it found 9 of 10 and none of the fourteen others (the miss, a dependency upgrade at 0.19, is arguably not a repeatable procedure). Tried on a copy: one task wrote an index line and a topic file with steps and pitfalls (turn 5); a second similar task updated the same file and line (turns 5, 6) instead of adding a copy. Not yet measured: whether a later conversation that did not make the notes follows them better than one without (the "recurring change done twice" test), which needs real use; the Inspect panel shows how often the notes are written.

**Privacy.** The gate sends each user message and the last answer's opening to OpenRouter and Perplexity. The chat model already sees everything when it is hosted, but a user running local models would not expect it. Settings gets "Memory gates" with a switch and the model name, and says what is sent.

## What the user sees and controls

- Under an answer that saved something: **Remembered: Prefers pnpm over npm. · Undo**.
- A **Memory** page: entries grouped by kind, an "always on" mark, edit, forget, "From: Fix checkout, 3 Oct ›" to the source, and Add a memory. A saved entry the page was not open for waits there as new.
- Two switches, as in Codex: save new memories, and use memories.

## Safety rules

- Only what the user said or confirmed: no inferred traits, moods or psychological notes. (A 2026 study of ChatGPT memories found over half held "psychological insights", 96% written without being asked; we do neither silently.)
- Never from tool output, web pages or files, so a page cannot plant a standing instruction. The nudges come only from the user's message.
- No secrets: keys, passwords and tokens are refused by a pattern check and by the agent's instructions.
- Everything is visible, editable and removable, with provenance.

## Phases (one at a time, each shippable)

| | Builds | Proves |
|---|---|---|
| **M1: memory you can see** | Events (`memory_saved`, `memory_edited`, `memory_forgotten`), projection with handles `m1…`, `<MEMORY>`, the final-answer `memory` field, "Remembered / Undo", the Memory page, the two switches. No embeddings, no decider. | "Remember I prefer pnpm" in one goal changes the next goal's answer. Fixed overhead stays within a deliberately raised budget (about +150 tokens). |
| **M2: resurfacing** | Entries in the embedding index and keyword search, `<MEMORY_CANDIDATES>`, the `context_retrieve` memory action, use tracking. `pnpm eval:memory` (retrieval part). | Right entry surfaced, wrong ones not, at the chosen floor; added tokens and latency per turn. |
| **M3a: gates** (built) | Decider client (OpenRouter, on by default with a key) with logging and a circuit breaker; the recall gate on M2 and the save nudge, both into the same agent; Settings. | `pnpm eval:decider`: precision and recall at each threshold on 78 labelled messages (above); cost about $0.000007 a message; added wait at most the slowest of the turn's searches or the decider (median 0.27 s), dropped after 2 s. Not yet measured: saves with the nudge against M1 alone, which needs real traffic. |
| **M3b: work memory** (built) | `.socrates/MEMORY.md` index plus `.socrates/memory/<topic>.md` per project, the index injected as `<WORK_MEMORY>`, written with the edit tools in a short extra step after verified work, nudged by the decider, no approval for the notes. | A recurring change done twice: the second time updates the recorded procedure instead of duplicating it (tried); the index stays within its 1,500-token budget (enforced). Still to measure on real use: the second change following the notes better than without. |

Later, only if the numbers ask for it: a sweep over un-reviewed turns at compaction or day change; tidying (merge duplicates, fade entries unused for a long time, as Codex does); a private chat that reads and writes nothing; images to the decider; the router seeing the profile.

## Not in this design

A knowledge graph; a general "user model"; memory from tool output; per-workspace user memory (work memory is per project, M3b); changes to routing; summaries of recent chats like ChatGPT's (General already shows `<RECENT_ACTIVITY>`).

## Tests to write

- M1: a saved entry appears in the next goal's `<MEMORY>` and not after Forget; goal-scoped entries stay in their goal; the profile respects its budget; the final-answer field is validated (too many, bad kind, unknown handle); replay of the log rebuilds the table; with "use memories" off nothing is shown; a tool result containing "remember…" saves nothing.
- M2: candidates by meaning and by keywords alone; floors; budget; nothing shown when nothing matches.
- M3a (done): gate thresholds against a scripted decider; fail-open on timeout and error, a user stop not counted as one; the nudges appear only above their thresholds; only the needed questions are sent; logs written with the price and the turn; the Inspect rates; the switch and the no-key state.
- M3b (done): the index is shown in the stable part and re-read each turn, left out when empty, a link out of the project, or memories off, and cut at its budget with a note; the extra step runs only after real work the decider marks, keeps the answer, stops at its step limit and asks before anything but the notes; only the two kinds of notes file skip approval.
