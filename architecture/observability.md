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

A request carries a `trace` (`CallTrace` in `packages/contracts`): its role, the user message it works on, and whatever else the call site knows (turn, lane, goal, task, chat, step). The router has the message but no turn yet; the working agent and the compactor have both. Providers ignore it.

A record holds:

- **The request as it was sent**: system prompt, every message (images reduced to their type and size), the tool definitions, tool choice, output limit, temperature and thinking level. Messages are copied when the call starts, so what is saved is what was sent, whatever the caller does with its list afterwards.
- **The reply**: text, tool calls, readable thinking, stop reason, and usage normalized to prompt, output, cache-read, cache-write and thinking tokens.
- **What the provider said beyond that** (`ModelResponse.meta`): its response id, the model that served the request, the finish reason, its fingerprint, and **its own usage object whole** (for DeepSeek this includes `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`; for Anthropic the cache creation and read tokens; for Gemini the cached and thought token totals).
- **Timing**: the whole call; the time to the first text or thinking (only when the reply is streamed, which the working agent's is and the router's is not); and the generation speed, output tokens over the time after the first token (the whole call when not streamed, where the speed includes the prompt being processed). A reply that arrived in under 50 ms after its first token gets no speed.
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
3. the model's list price from OpenRouter's public model list (the provider's own models appear there under its prefix; DeepSeek's by the name its model list gives). These are list prices; a provider's own may differ, which the user's price corrects.

Cache reads and writes are part of the prompt tokens and cost their own rates; where a model lists none, the input rate applies. A call with no known price shows no cost, and the page says how many calls that is rather than counting them as free. The price is looked up when the call ends and saved with it, so a later price change does not rewrite history.

## The inspect page

`#/inspect` (the activity icon in the header), described in `web.md`. It reads these routes:

| Route | Returns |
|---|---|
| `GET /api/observe/summary?range=24h\|7d\|30d\|all` | totals over the range (calls, tokens, cache hit rate, cost, speed, first-token time), the same for the working agent alone, a breakdown by role and model, the models with no price and how many calls that is, the size of the log and the retention |
| `GET /api/observe/questions?range=&before=&limit=` | user messages with calls, newest first, each with its totals, where it was routed and whether that moved the work; `next` pages backward |
| `GET /api/observe/questions/:id` | one message: its totals; the routing (the router's model, attempts, ledger queries, reason, decision); each part's place before and after and what the message did to it; the compactions its turn went through; and every call, in order |
| `GET /api/observe/calls/:id` | one call whole: the request as sent, the reply, the provider's metadata, and the context message cut into its `<NAME>` blocks with token counts and where the cache breakpoints fall, plus the size of the system prompt, the tools and each message |
| `GET /api/observe/prices` | the price in force for each model that has made calls, and where it came from |

**What a message did to the work** (`Move`): `first` (the conversation's first), `continued` (the same task), `switched_task` (another task of the same goal), `new_task`, `switched_goal`, `new_goal`, or `general`. It is read from the router's own route and the turn before it in the same conversation, so it is the automatic context switch, shown with the router's reason. A compaction shows its size before and after and which layers ran.

**What the working agent was given** is exactly the first message of its request, whose blocks are named: `USER`, `GOAL`, `AVAILABLE_SKILLS`, `ACTIVE_CAPABILITIES`, the history of the task's chat, `GOAL_STATE`, `CURRENT_TASK`, `LANES`, `ACCESS`, `RETRIEVED_HISTORY`, `PROJECT_CONTEXT`, `CURRENT_USER_MESSAGE`. A new task starts a new chat, so its first request holds no earlier turns, only what retrieval brought in.

## Evaluating the cache

`SOCRATES_PROVIDER=deepseek SOCRATES_ENV_FILE=.env pnpm eval:cache` (`apps/server/eval/run-cache-eval.ts`) has a real model work through three connected messages on a small fixture project, records every call, and prints for each: prompt tokens, how many the provider served from its cache, output, time to first token, speed and cost. It then reports the hit rate of the working agent's first step of a message, of its later steps, of the router and of everything, and **fails when the later steps hit less than `CACHE_MIN_WARM` (default 60%)**. It also checks that every call the models received was recorded. Set `KEEP_EVAL=1` to keep the disposable data folder under `.socrates/evals/` and open it with the app.

Why the later steps are the measure: they send everything the step before sent plus one more result, so a provider that caches prefixes should serve nearly all of it. The first step of a message is the cold one: it reuses the system prompt and the tool definitions (about 6,000 tokens for the ten permanent tools) and whatever of the history is unchanged, and a new task has no history to reuse. A first step that misses a prefix identical to an earlier request is the provider's cache missing, which the page shows as a cold row beside warm ones; the replay of a recorded request is how to tell (the same prefix, sent again, hit 97–98%).

The first measurements are in `docs/reviews/cache-eval-2026-10-06.md`.
