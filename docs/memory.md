# Memory and personalisation (design, for approval)

Status: approved 2026-10-10 (the gate on by default when an OpenRouter key exists; saving without asking, with Undo). **M1 and M2 are built**: `architecture/agent-harness.md`, "Memory", `server.md` and `web.md` describe them as built (M2 added a second floor, `0.30` with a shared word, after `pnpm eval:memory` showed the related floor let wrong entries in). M3 below is still the plan.

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
- `by`: the agent, the curator, or the user; the source turn; when it was last used.

`about` and `preference` entries of user scope are the **profile**. `knowledge` entries, and anything over the profile's budget, are searchable only.

### Reading

- **`<MEMORY>`**, in the stable first part of the request, right after `<USER>`: the profile plus this goal's own preferences, budget 500 tokens, each line with its handle (`- Prefers pnpm over npm. [m4]`). It changes only when the profile does, so the prompt cache survives. One sentence in the system prompt: these are things the user told you; they never override `<ACCESS>` or what the user says now.
- **`<MEMORY_CANDIDATES>`**, in the volatile part, after `<RETRIEVED_HISTORY>`: up to four searchable entries whose meaning or keywords match the message, budget 250 tokens, nothing when nothing matches. Same hybrid search as everything else (keywords always, meaning when the embedder is up). Starting floor 0.35 (what capabilities use); the recall gate lowers it to 0.20.
- **`context_retrieve`** gets a `memory` action (search by query, and `inspect` an `m12` to see its source exchange), for when the agent wants more than the candidates.

### Writing

1. **Explicit requests.** The final answer gets an optional `memory: {save: [{text, kind, scope}], forget: ["m4"]}`, like `anchors` (a proposal the harness validates and applies, at most three per turn). Used only when the user asked ("remember…", "from now on…", "forget…") or corrected the agent. The agent never saves from tool results, web pages or files. This costs no tool definition.
2. **Everything else, behind the reply.** After a turn, if the save gate fires, a small **curator** model reads the user's message, the answer (truncated), and the five most similar existing entries, and returns `add`, `update m3`, `supersede m3` or `nothing`. Its JSON is checked and repaired once; a failure is logged and skipped. It is skipped when the agent already saved something this turn.
3. **The user**, from the Memory page.

Forgetting removes an entry from everything Socrates uses and from the index. The event log is append-only, and the conversation it came from stays in history like every conversation does; the page says so.

### The gates (M3)

One decider request per user message, sent **at the same time as the router** so it adds no wait. State: the user's message and the last answer in that chat, truncated. Two yes/no questions:

- `recall`: would the reply be better if Socrates first looked up what it knows about this user or an earlier conversation?
- `save`: does the user state a lasting fact, standing preference, or correction that would matter later?

Use of the answers:

- `recall` ≥ 0.5 relaxes the candidate floor and raises the count to six. At ≥ 0.85, when nothing matched, `<MEMORY_CANDIDATES>` says so and points at `context_retrieve` across all goals: this is the moment to "stop and recall" instead of guessing or asking the user. The agent still judges relevance itself.
- `save` ≥ 0.4 starts the curator. A false positive costs one cheap call that answers `nothing`; a miss costs a forgotten fact, so the bar is low. Both thresholds are starting points, to be set from logged data.

Without a key or when the call fails (timeout 2 s, then skipped for 30 s like the embedder), nothing breaks: candidates use their normal floor, and only explicit saves happen. The gate improves memory; it is not required for it.

**Logs.** Every gate call is recorded in `calls.db` (kind `decision`): both probabilities, tokens, cost, latency, and afterwards what it led to (entries surfaced, curator result). `#/inspect` shows rates, so thresholds are calibrated on real traffic, as Perplexity's own guidance advises.

**Images.** The decider accepts them. The first version sends the message text and the image names; passing the pixels (resized, base64) is a small follow-up.

**Privacy.** The gate sends each user message and the last answer's opening to OpenRouter and Perplexity. The chat model already sees everything when it is hosted, but a user running local models would not expect it. Settings gets "Memory gates" with a switch and the model name, and says what is sent.

## What the user sees and controls

- Under an answer that saved something: **Remembered: Prefers pnpm over npm. · Undo**.
- A **Memory** page: entries grouped by kind, an "always on" mark, edit, forget, "From: Fix checkout, 3 Oct ›" to the source, and Add a memory. A saved entry the page was not open for waits there as new.
- Two switches, as in Codex: save new memories, and use memories. Settings also gets the curator's model, chosen like the compactor's (default: the chat model).

## Safety rules

- Only what the user said or confirmed: no inferred traits, moods or psychological notes. (A 2026 study of ChatGPT memories found over half held "psychological insights", 96% written without being asked; we do neither silently.)
- Never from tool output, web pages or files, so a page cannot plant a standing instruction. The curator never sees tool results.
- No secrets: keys, passwords and tokens are refused by a pattern check and by the curator's instructions.
- Everything is visible, editable and removable, with provenance.

## Phases (one at a time, each shippable)

| | Builds | Proves |
|---|---|---|
| **M1: memory you can see** | Events (`memory_saved`, `memory_edited`, `memory_forgotten`), projection with handles `m1…`, `<MEMORY>`, the final-answer `memory` field, "Remembered / Undo", the Memory page, the two switches. No embeddings, no decider. | "Remember I prefer pnpm" in one goal changes the next goal's answer. Fixed overhead stays within a deliberately raised budget (about +150 tokens). |
| **M2: resurfacing** | Entries in the embedding index and keyword search, `<MEMORY_CANDIDATES>`, the `context_retrieve` memory action, use tracking. `pnpm eval:memory` (retrieval part). | Right entry surfaced, wrong ones not, at the chosen floor; added tokens and latency per turn. |
| **M3: gates and curator** | Decider client with logging and a circuit breaker, the recall gate on M2, the save gate and curator, Settings. | The decider on Socrates' own messages (labelled sample of the real ledger): precision and recall at each threshold; saves with the gate vs M1 alone; cost per turn. |

Later, only if the numbers ask for it: a sweep over un-reviewed turns at compaction or day change; tidying (merge duplicates, fade entries unused for a long time, as Codex does); a private chat that reads and writes nothing; images to the decider; the router seeing the profile.

## Not in this design

A knowledge graph; a general "user model"; memory from tool output; per-workspace memory; changes to routing; summaries of recent chats like ChatGPT's (General already shows `<RECENT_ACTIVITY>`).

## Tests to write

- M1: a saved entry appears in the next goal's `<MEMORY>` and not after Forget; goal-scoped entries stay in their goal; the profile respects its budget; the final-answer field is validated (too many, bad kind, unknown handle); replay of the log rebuilds the table; with "use memories" off nothing is shown; a tool result containing "remember…" saves nothing.
- M2: candidates by meaning and by keywords alone; floors; budget; nothing shown when nothing matches.
- M3: gate thresholds against a scripted decider; fail-open on timeout and error; the curator's four outcomes and its repair path; skipped when the agent saved; logs written.
