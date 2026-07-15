# Memory Router Post-Review Gate Evaluation

Date: 2026-07-15

## Outcome

Do not ship the single-call `skip_candidate` / `required` production gate yet.

DeepSeek V4 Flash understood the distinction at a useful but insufficient level. Across both 90-attempt runs, the majority decision for every fixture was correct, but each run still produced three unsafe `required -> skip_candidate` decisions. A production turn gets one pre-router decision, not three votes, so majority accuracy cannot hide those misses.

The test did not change production routing. It added only an opt-in package eval script, synthetic fixtures, scoring, and ignored raw result files. The runner is not imported by application code and is not compiled into the normal server/runtime path.

## Method

- Model: `deepseek/deepseek-v4-flash`
- API credential/provider: OpenRouter API key through Socrates' credential resolver
- Thinking: disabled (`thinkingEnabled=false`, `thinkingEffort=none`)
- Dataset: 30 synthetic, non-personal, human-style conversations
- Gold balance: 15 `skip_candidate`, 15 `required`
- Repetitions: 3 per fixture, 90 model calls per prompt version
- Context supplied: active project name/description, latest user message, and recent visible messages
- Context deliberately excluded: live memory retrieval and real conversation data
- Acceptance: zero unsafe skips, at least 95% overall accuracy, 100% required recall, at least 95% skip precision, and at least 95% fixture unanimity

`skip_candidate` was defined as eligible to skip only when execution is otherwise uneventful. A future backend must still force post-review after any model-visible tool, mutation, memory note, failure, unresolved task, wait, or resumption.

## Results

| Metric | Baseline prompt | Conservative semantic prompt |
|---|---:|---:|
| Attempts | 90 | 90 |
| Correct | 84 | 83 |
| Accuracy | 93.33% | 92.22% |
| Unsafe skips | 3 | 3 |
| Unnecessary `required` | 3 | 4 |
| Required recall | 93.33% | 93.33% |
| Skip precision | 93.33% | 93.18% |
| Fixture unanimity | 80.00% | 76.67% |
| Majority-vote fixture accuracy | 100% | 100% |
| P50 latency | 4.261 s | 2.544 s |
| P95 latency | 8.810 s | 3.299 s |

The conservative revision fixed the baseline miss on the lasting diagnosis preference, but did not remove unsafe misses overall. Its unsafe cases were:

- A current Windows packaging blocker plus completed auth work.
- A completed phase plus an explicit next-session starting point.
- A scoped personal opt-out combined with a separately allowed repository credential rule.

Those are exactly the kinds of subtle durable state a post-review gate must not lose.

## OpenRouter Endpoint Variance

The baseline run was routed across three OpenRouter upstreams:

| Upstream | Attempts | Accuracy |
|---|---:|---:|
| Alibaba | 20 | 100% |
| DigitalOcean | 24 | 100% |
| DeepInfra | 46 | 86.96% |

All six baseline errors came from DeepInfra. This is important operational evidence: selecting one model slug through OpenRouter does not guarantee identical behavior across upstream hosts. The second run happened to route all 90 calls through Alibaba, but still had seven inconsistent decisions, including three unsafe skips. Pinning an endpoint therefore does not solve the underlying one-call reliability problem.

## Cost Comparison

The harness used provider-reported OpenRouter cost and calculated a direct-DeepSeek counterfactual from the same normalized token counts and cache fields.

| Cost | Baseline | Conservative | Combined |
|---|---:|---:|---:|
| Actual OpenRouter | $0.00437539 | $0.00761040 | $0.01198579 |
| Direct DeepSeek counterfactual | $0.00561338 | $0.00795116 | $0.01356454 |
| OpenRouter difference | -22.05% | -4.29% | -11.64% |

For these short classifier calls, OpenRouter was cheaper because it routed to upstreams with lower uncached list prices. The conservative run used Alibaba exclusively, whose observed rates were 4.29% below the direct DeepSeek uncached rates.

This does not mean OpenRouter will always be cheaper for the real Memory Router. The conservative run reported no cache reads. Direct DeepSeek currently charges $0.0028 per million cached Flash input tokens, while the OpenRouter upstreams used here have materially higher cache-read rates. A long, stable, cache-heavy production prefix can therefore make the direct DeepSeek path cheaper even when OpenRouter wins on short uncached calls.

Current pricing references:

- [OpenRouter DeepSeek V4 Flash providers](https://openrouter.ai/deepseek/deepseek-v4-flash/providers)
- [DeepSeek official models and pricing](https://api-docs.deepseek.com/quick_start/pricing/)

## Recommendation

Keep the current post-router behavior for production. There is no planned production implementation of the one-call skip gate.

The binary semantic signal is promising as telemetry or a shadow field, but not yet as authority to suppress post-review. The next worthwhile experiment would compare one of these conservative designs:

1. Record the single-call label in shadow mode over real non-sensitive traffic and measure agreement with actual empty/non-empty post-router outcomes.
2. Require two independent `skip_candidate` votes and default ties to `required`; measure whether the extra classifier cost and latency still beat the avoided post-router cost.
3. Combine the semantic label with deterministic pre-router evidence, such as relevant durable-section routes, while preserving execution hard overrides.

These are future research options only, not current implementation work. Revisit suppression only under an explicit new goal with evidence that unsafe skips have been eliminated. Do not use crude phrase or keyword matching to repair the misses.

## Reproduction

Validate the 30-fixture plan without API calls:

```bash
pnpm eval:memory-router-gate --dry-run
```

Run the live OpenRouter benchmark:

```bash
pnpm eval:memory-router-gate --rounds=3 --limit=30 --max-cost=0.05
```

Raw result JSON is written under `evals/memory-router-gate/results/` and ignored by Git.
