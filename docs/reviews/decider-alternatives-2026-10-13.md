# Isolated decider alternatives — 13 October 2026

Asked: test a cheap alternative via the existing OpenRouter key before deciding whether to replace the current memory decider. No production code, configuration, thresholds or live data changed. The prior implementation remains uncommitted; no push or restart.

## Finding

The previous question-insensitivity failure is **not reproducible today**. Perplexity now distinguishes opposite questions, passes the existing full quality floors, and handles the contextual contrasts better than Jev. This does not establish the cause of yesterday's failure or guarantee future availability. Preserve the 12 October report as dated evidence.

Jev 1.13 is an inexpensive, compatible Decisions API alternative, but this comparison does not justify switching: it unnecessarily recalls facts already supplied in recent conversation and makes more unnecessary save suggestions. Recommendation: retain the configured model for now; investigate the earlier provider-path failure and consider separately approved model selection/health monitoring if wanted.

## Method

Temporary copies of the existing decider evaluator used identical `gateState`, gate questions, fixtures and shipped thresholds (recall 0.5, save 0.4, work 0.5). Dataset: 78 messages (including the existing private fixtures) and 24 completed-work cases. Full batches used direct OpenRouter Decisions requests with the production adapter's request shape; the Perplexity contextual checks additionally exercised the actual unchanged `OpenRouterDecider` class. No tools were executable by these models.

Two early unpaced Perplexity batches were incomplete because of HTTP 429; a third was interrupted to slow the test. They are not counted as completed quality runs. The completed paced Perplexity run also encountered rate limits and retried. Jev completed two full batches. Deliberate pacing and rate-limit retries mean full-batch wall times are not production gate latency measurements, and these retries are not changes to the app's 2-second gate policy. The separate repeated contextual probes below measure API time without the between-request pacing. No threshold tuning or prompt changes were made for either model.

## Full quality results

| Model / run | Needed recall found | Unnecessary recall | Worth-saving found | Unnecessary save | Useful work found | Unnecessary work save | Reported cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Perplexity V1.1 / 1 | 17/17 | 2/61 | 22/22 | 3/56 | 9/10 | 0/14 | $0.00093838 |
| Jev 1.13 / independent | 17/17 | 2/61 | 22/22 | 7/56 | 10/10 | 1/14 | $0.00247855 |
| Jev 1.13 / 1 | 17/17 | 2/61 | 22/22 | 6/56 | 10/10 | 1/14 | $0.00247855 |

All three completed full batches passed the evaluator's existing floors. These are hand-labelled fixtures, not proof of universal correctness. Costs above are for the completed 102-call batches only; interrupted batches and diagnostic calls incurred additional small charges, so the table is not a total account-spend claim.

## Context sensitivity, repeated three times

Six synthetic cases: missing past decision; same question with the answer supplied in history; current-work confirmation; standing preference; one-off instruction; and old assistant-mentioned preference with a current “Thanks.” Each case repeats three times, unchanged for both models. Both recall and save must match the expected label for a case to pass.

- `perplexity/pplx-decider-v1.1-27b`: **18/18**; median API time **359.5 ms**, maximum 654 ms.
- `typesafe/jev-1.13`: **15/18**; median API time **318 ms**, maximum 418 ms.

Jev's three misses were all the supplied-answer contrast: “What database did we choose for the importer?” with previous answer “We chose PostgreSQL for the importer.” Recall scores 0.79, 0.71, 0.76 crossed the unchanged 0.5 threshold despite the evidence already being present. Perplexity correctly suppressed extra recall in all three. These short probes do not validate latency with a full 4k history or the application's timeout/cooldown behaviour under load.

## API/key sanity checks

For state “The sky is blue.” with opposite blue and green questions in one request:

- Perplexity: blue 0.9994094743; green 0.0003309378; 565 ms. Reported model `perplexity/pplx-decider-v1.1-27b-20261006`.
- Jev: blue 0.99; green 0.01; 351 ms. Reported model `typesafe/jev-1.13-20260917`.
- Cheap normal-chat control `qwen/qwen3-30b-a3b-instruct-2507`: correct JSON booleans, 1,385 ms, $0.00000651. This confirms a working chat/key path; Qwen was not run through the full memory suite.

## Sources and scope

- [Jev model and pricing](https://openrouter.ai/typesafe/jev-1.13): $0.042 per million input tokens, free output, as checked today.
- [Official Decisions request contract](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request).
- [Qwen chat control](https://openrouter.ai/qwen/qwen3-30b-a3b-instruct-2507).

The model-list API's ordinary text-model listing did not include these decision models; selection used the official Decisions documentation/model pages and verified live inference. No credentials or private fixture text are included here. Temporary scripts and outputs were removed after recording this report; the pre-existing private fixture file is preserved. No application code changed, so the full application suite was not rerun for this comparison. Previous release checks remain dated to the earlier implementation report.
