# PR3 compaction-stage closure

Baseline: `fb06769ada911501194c6cb96899d1b57a46bd7e` on `socrates-v2`.
Completed 2026-10-03 against `architecture/agent-harness.md` and `architecture/Goal-router.md`.

All six agreed review findings are closed. This change completes the reviewed compaction-stage safeguards; real Skills/MCP integration and embeddings retain their later stages.

| Finding | Final behavior | Regression evidence |
| --- | --- | --- |
| 1: summarizer request ceiling | Worker and compactor use one request-counting implementation, including framing and native replay blocks. Every summary attempt passes the calibrated ceiling; responses update the per-model calibration shared with the worker. | Production-sized retry refused at 180k; raw replay growth refused; known calibration honored; invalid response updates calibration before retry |
| 2: obligations lost on failed rollover | Mechanical handover claims only the prior summary's coverage. Newly unprocessed turns remain a persisted, visible omission range and enter the next checkpoint's input. | Failed rollover with and without a prior checkpoint, event-only replay, then successful recovery of the exact original request |
| 3: oversized mechanical capsule | The complete rendered fallback must fit `summaryMax`. Quotes and overflow references are preserved. Reduced metadata has explicit recovery pointers to the prior artifact and task. If the minimum cannot fit, rollover is deferred and the existing history retained. | Near-8k prior summary plus new facts fits; quotes and source artifact unchanged; fitted capsule replays; impossible configured budget cannot create an oversized capsule |
| 4: handover-to-checkpoint citations | Coverage remains exact while validated prior obligations may carry newer turn citations. New out-of-range citations and cross-task citations remain invalid. Obligations outside the span cannot disappear silently; overflow references remain available. | Two checkpoint generations, unchanged coverage, valid carried quote, rejected unrelated quote, rejected foreign task, explicit overflow handling |
| 5: retrieved-history candidate filtering | The eligible older turn boundary is applied in SQL before ranking and limiting. | An older matching exchange is retrieved despite 25 stronger recent matches; other-task history is excluded |
| 6: missing compactor usage | Every returned summary attempt, including invalid output and handovers, contributes input/output usage to the working turn. Exhaustion prevents another summary attempt or ordinary worker call; bounded tool-free finalization remains allowed. | Valid/invalid checkpoint and handover usage trigger token wrap-up; two individually-under-limit attempts are charged cumulatively |

Summary responses racing with cancellation are also rejected before checkpoint or rollover state is persisted. Existing event identities and exact source history are preserved. Schema version remains 4: the optional capsule omission notice lives in the existing JSON content field.

## Validation

- `pnpm typecheck`: passed.
- `pnpm test`: **305 tests passed across 21 files** (16 new compaction regression cases).
- `git diff --check`: passed.
- `SOCRATES_ENV_FILE=.env pnpm eval:compaction`: **5/5 live scenarios passed**, Gemini `gemini-3.8-flash`, 36 model calls. The live evaluation now checks full calibrated request sizes for both worker and compactor, including replay content.
- Largest calibrated worker/compactor request in the live run: **10,655 tokens**, below its configured **44,678-token ceiling**.
- Live artifact: ignored local `.socrates/evals/compaction-gemini-Z7QLh8/results.json`.

The live run verifies checkpoint creation, unanswered-request recall, linked rollover, restart, and event-only replay. Its deliberately reduced targets produced four `compaction_failsafe` target-miss warnings; the hard request ceiling held. Fault injection and production-sized budget boundaries are covered by the deterministic regression suite.

The original review and reproductions remain in `.socrates/reviews/compaction-fb06769/`. Those reproduction assertions describe the old defects; the committed regression tests assert the corrected behavior.
