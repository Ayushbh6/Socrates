# Cache evaluation, 2026-10-06

First measurements from `pnpm eval:cache` (`architecture/observability.md`, "Evaluating the cache"): a real model works through three connected messages on a small fixture project (four Markdown files and a JSON file), every call is recorded, and the report is read from the recorded calls.

Provider and models: DeepSeek, `deepseek-v4-pro` as the working agent and as the router (the provider's defaults), thinking level low. Run twice, a few minutes apart, from the same fixture. Costs are OpenRouter's list price for the model.

## Run 1

| msg | role | step | prompt | cached | hit | out | tok/s | cost |
|---|---|---|---|---|---|---|---|---|
| 1 | router | 1 | 3,506 | 3,456 | 99% | 218 | 85.4 | $0.000162 |
| 1 | router | 2 | 3,740 | 3,712 | 99% | 208 | 93.9 | $0.000157 |
| 1 | agent | 1 | 7,430 | 0 | 0% | 57 | 34.7 | $0.001575 |
| 1 | agent | 2 | 7,545 | 7,424 | 98% | 137 | 79.5 | $0.000212 |
| 1 | agent | 3 | 10,031 | 7,680 | 77% | 61 | 47.5 | $0.000650 |
| 1 | agent | 4 | 10,149 | 9,984 | 98% | 269 | 101.2 | $0.000321 |
| 2 | router | 1 | 3,795 | 3,328 | 88% | 360 | 111.5 | $0.000306 |
| 2 | agent | 1 | 10,101 | 0 | 0% | 212 | 69.0 | $0.002198 |
| 3 | router | 1 | 3,909 | 3,328 | 85% | 294 | 103.0 | $0.000302 |
| 3 | agent | 1 | 7,932 | 7,168 | 90% | 177 | 73.6 | $0.000358 |
| 3 | agent | 2 | 8,232 | 8,064 | 98% | 77 | 50.9 | $0.000208 |
| 3 | agent | 3 | 8,347 | 8,192 | 98% | 113 | 73.0 | $0.000222 |
| 3 | agent | 4 | 8,568 | 8,448 | 99% | 331 | 109.4 | $0.000310 |

Agent, first step of a message: 28% cached (3 calls). Agent, later steps: **94%** (6 calls). Router: 92%. Everything: 76% of 93,285 prompt tokens, **$0.00698**.

## Run 2

In this run the router asked back once on the first message (the eval answers it and goes on), so message 1 has two router rows, and the working agent was streamed as the app streams it, so first-token times exist. The `repair` row is a retry after an invalid final answer, which is a tool-free request.

| msg | role | step | prompt | cached | hit | out | first token | tok/s | cost |
|---|---|---|---|---|---|---|---|---|---|
| 1 | router | 1 | 3,506 | 3,328 | 95% | 815 | – | 115.1 | $0.000435 |
| 1 | router | 1 | 3,363 | 256 | 8% | 501 | – | 108.9 | $0.000862 |
| 1 | agent | 1 | 7,485 | 0 | 0% | 58 | 1.7 s | 154.3 | $0.001587 |
| 1 | agent | 2 | 7,601 | 7,424 | 98% | 137 | – | 90.4 | $0.000223 |
| 1 | agent | 3 | 10,087 | 7,680 | 76% | 179 | 0.8 s | 200.9 | $0.000711 |
| 1 | agent | 4 | 10,363 | 10,240 | 99% | 225 | 1.3 s | 202.7 | $0.000298 |
| 2 | router | 1 | 3,883 | 3,328 | 86% | 272 | – | 98.2 | $0.000287 |
| 2 | agent | 1 | 10,228 | 7,040 | 69% | 191 | 1.3 s | 153.2 | $0.000868 |
| 2 | repair | 2 | 4,971 | 0 | 0% | 252 | 1.2 s | 146.4 | $0.001143 |
| 3 | router | 1 | 3,986 | 3,328 | 83% | 229 | – | 93.1 | $0.000291 |
| 3 | agent | 1 | 7,943 | 7,168 | 90% | 130 | 1.2 s | 174.3 | $0.000341 |
| 3 | agent | 2 | 8,610 | 8,064 | 94% | 44 | – | 27.9 | $0.000273 |
| 3 | agent | 3 | 8,700 | 8,576 | 99% | 142 | 1.1 s | 175.7 | $0.000234 |

Agent, first step of a message: 55% (3 calls). Agent, later steps: **93%** (5 calls). Router: 69%. Everything: 73% of 90,726 prompt tokens, **$0.00755**.

## Run 3

Run once more after the console was built (same fixture, streamed): the working agent's first step of a message hit **82%** (3 calls), later steps **92%** (6), the router **92%**, everything 86% of 105,339 prompt tokens, **$0.0061**. Across the three runs the first step of a message hit 28%, 55% and 82%: how much of the cold start the provider serves varies from run to run.

## What the numbers say

- **The cache works where it should.** Later steps of a task, which repeat everything before them, are served from the provider's cache 93–94% of the time, and the router's long fixed prompt 83–99% of the time once it is warm.
- **Cached tokens are cheap, and a miss shows.** The cold first steps cost $0.0016–0.0022 against $0.0002–0.0003 for a warm step of the same size.
- **Not every later step is near 100%.** Step 3 of message 1 hit 76–77% in both runs: it is the step where a file's content was added and the prompt grew by about 2,500 tokens. Why the provider served less of it is not visible from our side.
- **The fixed part of every request is large.** The system prompt (1.6k tokens) and the ten tool definitions (4.6k) are about 6,200 tokens; an early step of a new task carries under 800 tokens of context about the question itself (767 in the call inspected). The call log shows this per call.
- **The prompt prefix is identical between runs and between messages** (checked on the recorded requests: the system prompt and the tool definitions are the same bytes, with no dates, paths or ids in them), so the first step's misses are not a layout fault. Replaying a recorded request, changed after its first block so that it shared only the system prompt, the tool definitions and that block, hit 97–98% of its roughly 7,200 tokens. What this evaluation cannot say is why DeepSeek missed the first request of each run, or message 2's first step in run 1, while serving the same prefix a minute later: its cache is best effort, and these are the cold rows of the table.
- **A request that forbids tool calls does not reuse the working steps' cache.** With `tool_choice: none` DeepSeek leaves the tool definitions out of the prompt (the same request had 4,687 prompt tokens that way and 10,117 with tools), so the wrap-up and the answer-repair requests start a different prefix. Run 2's repair request hit 0%. It is a small cost, paid only when a turn is wrapped up or repaired.
- **Speed.** Streamed calls generate at 150–200 tokens a second after the first token, which comes 0.8–1.7 s after the request. The router and the non-streamed calls show 85–115, which includes the time the prompt takes to process.

## How to repeat it

```
SOCRATES_PROVIDER=deepseek SOCRATES_ENV_FILE=.env pnpm eval:cache
KEEP_EVAL=1 ...   keeps the disposable data folder under .socrates/evals/ so it can be opened in the app
CACHE_MIN_WARM=0.7 ...   the lowest hit rate accepted for later steps (default 0.6)
```

It fails when later steps fall under the floor, when no task took a second step, when a call failed, or when the number of calls the models received differs from the number recorded.
