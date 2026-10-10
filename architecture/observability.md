# Observability

Socrates has to show, at any time and with numbers, what it sent to a model, what came back, what it cost, how fast it was, how much of each prompt the provider served from its cache, and where each message sent the work. This document is how that is recorded and read. Nothing here changes what the agent does: recording sits beside the models, and a failure to record never reaches a call.

## What is recorded

Every call to a model is saved once it ends, whatever it was for:

| Role | The call |
|---|---|
| `router` | one request of the Goal Router (`Goal-router.md`); a routing decision may take a few |
| `work` | one step of the working agent's turn; `step` counts its requests, retries included |
| `wrap_up`, `repair` | the tool-free final answer after a limit, and the one retry of an invalid final answer |
| `compaction` | a history checkpoint or handover capsule (`agent-harness.md`, "Context and compaction") |
| `embedding` | an embedding request for memory search, without tokens: what was embedded, how long it took, whether it worked |
| `decision` | one request to the memory decider (`agent-harness.md`, "Memory"): the questions and the text it was asked about as the request, the probabilities as the reply (`{"recall":0.12,"save":0.98}` or `{"work":0.9}`), its tokens and the price OpenRouter reported; the message's questions are asked before routing, so they have the user message but no turn, and a message's trace lists them first; the question about a finished turn has its turn, goal, task and chat |

A request carries a `trace` (`CallTrace` in `packages/contracts`): its role, the user message it works on, and whatever else the call site knows (turn, lane, goal, task, chat, step). The router has the message but no turn yet; the working agent and the compactor have both. Providers ignore it.

A record holds:

- **The normalized request at the model boundary**: system prompt, every message (images reduced to their type and size), the tool definitions, tool choice, output limit, temperature and thinking level. Messages, nested provider-native content, tools and trace are snapshotted when the call starts, so what is saved is what was sent, whatever the caller does with its list afterwards.
- **The reply**: text, tool calls, readable thinking, stop reason, and usage normalized to prompt, output, cache-read, cache-write and thinking tokens.
- **What the provider said beyond that** (`ModelResponse.meta`): its response id, the model that served the request, the finish reason, its fingerprint, and **its own usage object whole** (for DeepSeek this includes `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`; for Anthropic the cache creation and read tokens; for Gemini the cached and thought token totals).
- **Timing**: the whole call; the time to the first text or thinking (only when the reply is streamed, which the working agent's is and the router's is not); and effective output rate: provider-reported output tokens over the whole measured call in seconds. That interval includes prompt processing and any hidden thinking before visible text. It is comparable across streamed and non-streamed requests, rather than claiming to measure decoding throughput. Calls shorter than 50 ms or without output have no rate. Aggregate rates are arithmetic means over measured calls; first-output averages include only streamed calls that emitted readable text or thinking. Each average carries its sample count, so missing measurements never weigh the chart.
- **Cost**, where it can be worked out (see below).
- **An error** when the call failed: its kind, status and message, which never carry a key.

## Where it lives

`calls.db` in the data folder (`server.md`), a SQLite file of its own and not part of the append-only ledger, so it can be pruned or deleted without touching the record of the work. The server runs without it if it cannot be opened; the inspect routes then answer `unavailable`.

A request is stored as references. The system prompt, the tool definitions and each message are saved once, compressed, under the hash of their content; a call lists the hashes it sent. A long turn sends its whole conversation again at every step, so successive steps share almost everything they store. Ten calls that each send about 35 messages hold the 40 distinct ones.

**Keeping and forgetting.** Calls older than 30 days (`CALL_RETENTION_DAYS`) are deleted when the server starts, with the saved parts no remaining call has used since.

## Cost

A call's cost is, in this order:

1. what the provider reported in its usage (OpenRouter does when asked);
2. the user's own price for the model, from the `prices` setting, keyed by the client id (`deepseek:deepseek-flash`) and given in US dollars per million tokens: input, cached input, output;
3. the model's list price from OpenRouter's public model list (the provider's own models appear there under its prefix; DeepSeek's by the name its model list gives). Gemini's `interactions:` transport marker is removed for lookup. These are list prices; a provider's own may differ, which the user's price corrects.

Cache reads and writes are part of the prompt tokens and cost their own rates; where a model lists none, the input rate applies. A call with no known price shows no cost, and the page says how many calls that is rather than counting them as free. The price is looked up when the call ends and saved with it, so a later price change does not rewrite history.

## The inspect console

`#/inspect`, opened by the activity icon in either header, described in `web.md`. It has three tabs and reads these routes. Everything it shows was recorded; it changes nothing except a model's price.

| Route | Returns |
|---|---|
| `GET /api/observe/summary?range=24h\|7d\|30d\|all` | totals over the range (calls, failed, stopped, tokens, cache hit rate, cost, speed, first-token time), the same for the working agent alone, a breakdown by role and model, the models with no price and how many calls that is, the size of the log and the retention |
| `GET /api/observe/decider?range=` | how the memory decider behaved: decisions answered and failed, median time, cost, and for each question how often it said likely (recall at least `0.5`, save at least `0.4`) and, in those turns, how often memories were offered or the agent saved (and the same for unlikely, which is how a missed save shows), and for the finished-turn question (`work`, at least `0.5`; asked with the turn's id) how often it said likely and how often the agent then wrote the project's notes; the latest `500` decisions of the range, joined to the ledger by the user message (and so to its turns) |
| `GET /api/observe/series?range=` | model calls per time bucket (hour, six hours or day) and role, with every bucket of the range present, for the charts; embeddings are left out |
| `GET /api/observe/recent?limit=` | the latest calls, for the live feed |
| `GET /api/observe/costly?range=` | the eight questions that cost the most |
| `GET /api/observe/questions?range=&before=&limit=` | user messages with calls, newest first, each with its totals, where it was routed and whether that moved the work; `next` pages backward |
| `GET /api/observe/questions/:id` | one message: its totals; the routing (the router's model, attempts, ledger queries, reason, decision); each part's place before and after and what the message did to it; the compactions its turn went through; and every call, in order |
| `GET /api/observe/questions/:id/trace` | everything that happened for the message, in order (see "The trace") |
| `GET /api/observe/calls/:id` | one call whole: the request as sent, the reply, the provider's metadata, and the context message cut into its `<NAME>` blocks with token counts and where the cache breakpoints fall, plus the size of the system prompt, the tools and each message |
| `GET /api/observe/prices` | the price in force for each model that has made calls, and where it came from |
| `GET /api/observe/db`, `…/db/:db/:table`, `…/db/:db/:table/:rowid` | the database view (see below) |

**What a message did to the work** (`Move`): `first` (the conversation's first), `continued` (the same task), `switched_task` (another task of the same goal), `new_task`, `switched_goal`, `new_goal`, or `general`. It is read from the router's own route and the turn before it in the same conversation, so it is the automatic context switch, shown with the router's reason. A compaction shows its size before and after and which layers ran.

**What the working agent was given** is exactly the first message of its request, whose blocks are named: `USER`, `GOAL`, `AVAILABLE_SKILLS`, `ACTIVE_CAPABILITIES`, the history of the task's chat (each turn as `HISTORY · TURN n`, or a `HISTORY_CHECKPOINT`), `GOAL_STATE`, `CURRENT_TASK`, `LANES`, `ACCESS`, `RETRIEVED_HISTORY`, `PROJECT_CONTEXT`, `CURRENT_USER_MESSAGE`. A new task starts a new chat, so its first request holds no earlier turns, only what retrieval brought in. The router's input is cut the same way (`CURRENT_TIME`, `RECENT_ACTIVITY`, `RECENT_EXACT_HISTORY`, `KNOWN_GOALS`, `LANES`, `CURRENT_USER_MESSAGE`).

Routing clarification phases appear under one original query in the question list and trace. The trace includes the router question, an explicit **Reply to routing question** item, the resumed routing calls and worker answer. Calls keep their raw request IDs; grouped costs and call totals aggregate all linked inputs before filtering and pagination, without changing global usage. Legacy request links are read from the ledger in the same way as new explicit replies.

**Numbers and their scope.** Overview totals and chart series exclude background embeddings; embeddings remain visible in the model breakdown, latest calls and database. Rolling range cutoffs are identical for tiles and charts, even within the first time bucket. The all-time axis uses the earliest retained model request, independent of feed pagination. Calls and the feed are ordered by request start time, so asynchronous price lookup cannot reorder a trace. Context-block, tool-result and readable-thinking token sizes use the local text tokenizer and are labelled approximate. Provider usage counters are kept separately and are authoritative for reported model totals; readable thinking can be only a summary, and absent thinking is never invented. Full raw usage remains visible, including provider counters that differ from normalized or local estimates.

**Failed and stopped.** A call the user stopped (the provider's `aborted`) is counted as stopped, not failed, and is neither priced nor missing a price.

### The trace

`GET /api/observe/questions/:id/trace` joins the call log and the ledger into one ordered list, so the recorded context and provider usage for a message can be followed:

1. **the message** as the user wrote it, its lane and attachments;
2. **each router request**: the context it was given in blocks, its thinking, what it said, the `ledger_query` calls it made and what each answered, with the tokens, time and cost of the request;
3. **the decision**: the router's model, attempts, escalation or fallback, ledger queries, its reason and the decision as returned (or the question it asked back);
4. **per part, the turn** (its number, the place the work stood before and after, the move, the route) and then **each step of the working agent**: the first step's whole context in blocks; for every later step, **what entered since the step before** (its own reply sent back, each tool's result, any request the harness added), each with its tokens, and how much the prompt grew; the thinking; what it said; and each tool call with its input and the result the model was sent;
5. **compactions** between steps, with the size before and after, and a step whose context compaction rebuilt says so and shows the new context in blocks;
6. **the answer**: the saved final answer, or the part written before a stop.

A tool's result is the tool message that entered the next step's context, so it is exactly what the model saw (cut as the harness cut it), not a second recording. A step whose first message differs says **Context updated** and shows the new blocks; explicit compaction events establish when compaction occurred. Changed or added messages are found by their unchanged content-hash prefix, including rewrites without a change in message count. Tool results are joined from the full next request, even if its first context message changed; breakpoints for the prompt cache move at every step, so they are stored apart from the messages and do not count as a difference.

### The database view

`GET /api/observe/db` counts the databases (the ledger and the call log), their tables (the shadow tables of a full-text index are marked internal and not counted), the records in them, the bytes on disk, and the files beside them (settings, the embedding index and its documents, attachments, logs). `…/db/:db/:table` pages through a table (50 rows by default, at most 200) with a search over every column, a sort by any column and the total and matched counts; `…/:rowid` returns one row with every value in full, and compressed text (the saved parts of a request) opened.

It is read-only and cannot reach anything else: only the two databases can be named, each is opened for reading, a table or column is used only if the database itself lists it, and a search is a text match (`%` and `_` in it are ordinary characters).

## Evaluating the cache

`SOCRATES_PROVIDER=deepseek SOCRATES_ENV_FILE=.env pnpm eval:cache` (`apps/server/eval/run-cache-eval.ts`) has a real model work through three connected messages on a small fixture project, records every call, and prints for each: prompt tokens, how many the provider served from its cache, output, time to first token, speed and cost. It then reports the hit rate of the working agent's first step of a message, of its later steps, of the router and of everything, and **fails when the later steps hit less than `CACHE_MIN_WARM` (default 60%)**. It also checks that every call the models received was recorded. Set `KEEP_EVAL=1` to keep the disposable data folder under `.socrates/evals/` and open it with the app.

Why the later steps are the measure: they send everything the step before sent plus one more result, so a provider that caches prefixes should serve nearly all of it. The first step of a message is the cold one: it reuses the system prompt and the tool definitions (about 6,000 tokens for the ten permanent tools) and whatever of the history is unchanged, and a new task has no history to reuse. A first step that misses a prefix identical to an earlier request is the provider's cache missing, which the page shows as a cold row beside warm ones; the replay of a recorded request is how to tell (the same prefix, sent again, hit 97–98%).

The first measurements are in `docs/reviews/cache-eval-2026-10-06.md`.

