# Context, routing and session continuity — implementation results

12 October 2026. Baseline: `8386f42`, branch `socrates-v2`. **Implemented locally; no commit, push or live restart.** The user requested results before release. The original [baseline review](router-baseline-2026-10-12.md) remains unchanged.

## Verdict

The routing/context change shows a substantial improvement on the agreed tests. The six unambiguous real-query cases met the three-repeat acceptance target, independently and in connected sequences. Standard and Flow both continue inside the same task after the sixth compaction trigger.

**This is not an all-green live-model release recommendation.** The configured memory decider failed its existing quality floor, with an independently reproduced question-insensitivity problem on the old implementation too. Two routing decisions still missed in the latest 72-decision sequence batch. One DeepSeek replay added an unsupported statement about daily chats closing at day-end. These are disclosed below; settings and thresholds were not changed to hide them.

## What changed

- One quoted Markdown exchange contract supplies request/completion timestamps, stable ownership/retrieval references, answer validity, tool outcomes and explicit excerpt coverage.
- Decider: chronological 4k Q&A window plus intact current request; oversized total inputs are explicitly skipped at 24k. Existing thresholds, switches and timeout remain unchanged.
- Router: 20k chronological history, including up to 10k of the newest exchange's tool evidence; bounded objectives/completion criteria in the goal directory; no duplicate activity narrative. Native `routing_result` calls for the current OpenAI-compatible router prevent prose from being accepted as a route. Logical schema and semantic validation remain intact; unsupported providers retain JSON transport.
- Worker: selected-task history, General cross-day 30k/20k history, separately labelled proposal/dependency/retrieved evidence, concrete memory/project references, frozen time after stable history. General greetings do not receive unrelated project obligations. Exact history outranks notes; historical validator wording is not a current note-limit instruction.
- Fifth compaction remains in the session; the sixth creates an atomic handover and linked new session, same goal/task, in both modes. Standard can browse old sessions and directs new sends to the active one. Flow and Standard display a readable expandable handover.
- Inspect exposes context coverage, session identity/count, freshness, memory gating and separate routing format/tool/semantic failures. Old diagnostics remain unknown rather than being reconstructed.

## Repeated routing results

These are separate experiments, not a combined production accuracy estimate. Same router: Automatic → OpenRouter `openai/gpt-6-luna`, effort off.

| Experiment | Baseline | New result |
|---|---:|---:|
| Existing Q/T/G1 sequences, three repetitions | 61/72 | **70/72** latest batch |
| Q5–Q10, independently seeded correct predecessor | 12/18 | **18/18** |
| Six actual user queries, independent resets | 6/18 | **18/18** |
| Actual-query connected sequences | 2/16, stopped at clarification | **18/18**, all sequences completed |
| Held-out Atlas/Boreal cases, three repetitions | Not measured | **18/18** |

The preceding full new batch scored 71/72; the report uses the latest 70/72 instead of selecting the best. Latest full batch: zero repairs, nine safe normalizations, 75 model calls, about 414k prompt tokens, median 1,884 ms, p90 3,333 ms, $0.0240. Baseline: three repaired decisions, four normalizations, 75 calls, median 1,794 ms, p90 2,759 ms, about $0.0142. Richer context improved routing here at a higher token cost; fewer repairs do not guarantee fewer total calls because valid ledger lookups are separate.

Actual-query independent + sequence runs: 36/36, 38 calls, 246,919 prompt tokens, 152,465 cached, $0.0161332. Sources are the same local Socrates and job-search sessions identified in the baseline report; source paths are passed explicitly to the evaluator. Expected bindings are reconstructed fixture bindings, not inferred production Socrates state. Only routing ran; historical work was not executed against real projects. Held-out cases cover an older regression, same-objective continuation, new objective, another project, General and explicit ambiguity. The ambiguity query explicitly asks which application: this is a preservation check, not a measurement of spontaneous ambiguity detection. An initial held-out evaluator compared the wrong clarification tag; it was corrected and all 18 cases rerun before reporting.

**Remaining sequence misses:** Q6 created a new issue-fix/update task instead of continuing the existing issue investigation. Q10 subsequently selected that newly created task for the issue part of a compound request. The second miss therefore inherited the first. Independently seeded Q6/Q10 passed. Another batch unnecessarily split Q9. The current model still occasionally treats a change of work phase as a new objective.

Reproducible tracked runners: `packages/router/eval/run-router-compare.ts`, `run-context-routing-eval.ts` and `run-context-heldout.ts`. Private transcripts are not committed. These selected challenge cases are not a random sample of user traffic.

## Integrated DeepSeek replay

Three disposable homes restored the 182 original events preceding the Sunday greeting from a read-only SQLite backup. Today's greeting, answer, notes and derived indexes were absent. Settings and credentials were copied privately; timezone was Europe/Vienna and the clock was frozen at the original Sunday request. Each copy received exactly `hey buddy i am back again, whats up`, followed by a direct terminal timing/outcome question.

All three greetings recognised the completed terminal test without inventing an unfinished Sunday session. All three follow-ups distinguished Friday 9 October 00:49 (request, blocked by missing workspace) from Saturday 10 October 15:03–15:05 (successful interactive test, exit 0), and said the test was finished. Continuation notes preserved that outcome. No terminal test was rerun. Two follow-ups needed no tools; the third used five read-only `context_retrieve` calls. That copy also made one repair call; this retained report does not classify its subtype. Across eight worker calls: 111,448 prompt tokens, 79,744 cached; repair usage is separate. Observed cache usage is not a guarantee.

Earlier development replays exposed an unrelated-project obligation in a greeting and adoption of an obsolete 100-token note rule from a historical validator message. The final replay followed the fixes: greetings omit unrelated activity, and history identifies historical note-validation failure while leaving its exact diagnostic retrievable. The obsolete limit did not recur in the final three copies.

**Residual worker wording:** the third final follow-up claimed the daily chat stays open only until the day ends. That is unsupported; chat status is not automatically changed by the successful test. Other offers of a new experiment are suggestions, not outstanding obligations. The chronology/completion target passed, but this replay is not evidence that all wording is grounded perfectly.

Worker configuration remained `deepseek:deepseek-flash`, high effort; provider reported `deepseek-flash`. The provider response does **not** independently confirm the narrower “V4.1 Flash” identity. Router, decider, compactor, access and memory settings were preserved.

## Compaction and browser verification

A disposable fixture seeded five recorded compaction episodes, then used a reduced test-only 10k trigger/9.5k target to force the sixth boundary with real configured DeepSeek worker and compactor calls. Both Standard and pinned Flow created session 2, retained the same task, produced a validated generated handover, and reported the terminal marker and exit code. An append-only counter contained exactly one line in both cases: completed work was not repeated. This is a forced-boundary integration test, not five full-size real conversations. One run explicitly reported that its reduced result remained above the artificial 9.5k target; the request stayed within the hard ceiling and completed.

Deterministic cases cover actual count transitions, atomic rollback, cancellation, fallback, fresh-session counters, task history/General boundaries, queues, Stop, approvals and terminal ownership. Browser checks on an isolated synthetic server verified Flow's handover, both Standard session entries, previous/current navigation, and a real send from an older view landing in the active session. Inspect showed session 2, its handover reference, selected-task history and snapshot/coverage diagnostics. No live app restart was involved.

## Memory-decider failure: release concern

The unchanged 78-message decider evaluator failed at the existing thresholds:

| Measurement | Old prompt/input, tested now | New prompt/input |
|---|---:|---:|
| Recall positives found at 0.5 | 3/17 | 0/17 |
| Save positives found at 0.4 | 11/22 | 4/22 |

The new rendering is worse on this broken classifier path; this is not reported as an improvement. A four-message, old/new prompt × old/new state crossover returned identical recall/save probabilities for each state. Changing the question instructions had no effect. A second probe supplied “The sky is blue” and asked whether it said blue versus green: both questions returned exactly 0.17527709264598612, jointly, separately and in reverse order. Provider identity: `perplexity/pplx-decider-v1.1-27b-20261006`.

The request shape agrees with the [official Decisions API contract](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request). These observations strongly indicate a failure on the current provider/adapter path, rather than merely poor threshold calibration; they do not prove which upstream component is responsible. No replacement model, threshold adjustment, duplicate classifier call or heuristic override was shipped. Ordinary conversation history is still supplied independently of this gate, explaining why the integrated chronological replay succeeds despite the gate failure. Saved-memory recall/save quality cannot be certified until the decider path is fixed and the quality eval rerun.

## Checks and release boundary

Final deterministic/typecheck/build results are recorded in trial-log entry 63. A previously flaky approval-deadline test now allows 1 second for real setup rather than 40 ms, explicitly requires approval to have been reached, and still verifies cancellation and no late mutation. A full run made during local embedding replay timed out in a PTY test; the isolated PTY suite passed, and the full suite was rerun without competing live evals. No assertions or production limits were weakened to conceal a product failure.

Temporary servers, terminals, databases, indexes, credential copies, browser session and raw private replay files are removed after verification. The live app and user ledger remain unchanged. **Review these results before authorizing commit, push or restart.**

## Deficiency tracking

| Finding | State after this change |
|---|---|
| Router lacks objective/tool evidence and overweights recency | Improved; real-query target met, Q6/Q9 stochastic task splitting remains |
| Router prose/invalid tool emission obscures retries | Native result transport and separate counters; no repairs in latest full batch |
| Worker context too thin or leaking unrelated tasks | Canonical task-scoped history, explicit handoffs, General cross-day evidence; deterministic and replay checks pass |
| Standard skips rollover / hides session relationship | Same-task sixth-trigger rollover and linked browser UI verified |
| Historical note limits promoted to current rules | Classified historical warning plus retrieval reference; absent in final replay |
| Memory-decider question sensitivity | **Unresolved release concern**, reproduced on old and new inputs |
| Unsupported daily-chat lifecycle wording | **Remaining model error**, one of three final follow-ups |
