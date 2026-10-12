# Image-aware memory decision inputs — 13 October 2026

## Scope and result

Implemented the approved two-stage input change on `socrates-v2`, retaining Perplexity and existing thresholds. Original request image pixels reach both stages, including linked clarification requests. The post-work classifier receives the intact request and final answer, followed by compact evidence lines using the existing compaction representation. Important changes, checks and failures take precedence over routine reads; selected lines retain execution order, references and explicit omissions.

The total estimated ceiling is 157,286 tokens: 60% of the documented 262,144 context window, including questions and images. This is a maximum, not a fill target. An early large probe exposed a local text-token undercount (110,891 estimated versus 144,736 provider-reported). The implementation now reserves 50% extra text tokens, plus image/framing allowances. Estimates are not a guarantee of provider tokenization. A corrected large probe used 138,037 estimated / 120,736 actual tokens and completed in 16.1 seconds. Background classification therefore has a separate 30-second allowance; foreground remains two seconds.

Unsupported/missing images or mandatory-field overflow bypass classification explicitly. Main-agent assessment uses bounded referenced excerpts, the same worker configuration, and only memory/retrieval tools. It may save nothing. Original answers, attachments and evidence remain stored; the writer refuses another call if its entire working input exceeds 60k estimated tokens.

## Isolated live evidence

All fixtures were synthetic and disposable; no user ledger was edited or learned from. Real decisions used OpenRouter's Perplexity adapter; the provider reported `perplexity/pplx-decider-v1.1-27b-20261006`. Real worker calls used the configured `deepseek:deepseek-flash`, high effort; the provider reported `deepseek-flash`, without independently confirming a narrower version.

- Three independent pixel-only opposite-question probes passed: positive probability about .9995 versus negative .0003. Three image-only standing-preference checks exceeded the existing save threshold (about .9979).
- A verified lesson placed beyond the old 800-character answer prefix was recognized (.9900). A large complete finished turn was recognized (.9770) within the background allowance.
- Runtime integration passed actual pixels through both stages. The one-off change was rejected for work-memory saving (.0721 in the full probe, .0886 in the repeat), showing that images do not imply automatic saving.
- Oversized completed-turn replay skipped the work classifier. Real DeepSeek assessed bounded evidence, used only retrieval/memory reads, saved nothing, and did not repeat the foreground edit.
- A separate fully real DeepSeek run reproduced an accented-text slug bug, fixed normalization and verified tests. Perplexity accepted the new reusable lesson (.9611); the real writer saved a topic and index. A fresh task recalled the lesson (.9471) and opened the saved topic using `context_retrieve`.
- Corrected full probe: 11 decider calls, 133,528 reported input tokens, $0.00267056. Subsequent runtime/real-work probe: 6 calls, 5,917 tokens, $0.00011834. These exclude exploratory runs and worker costs. Worker cache reads were recorded per call, not promised as a future hit rate.

**Non-passing older live fixture:** `eval:work-memory` expected a saved procedure, but the writer returned “Nothing to record” because the procedure was already in the project's instructions. Its assertion failed. The writing guide explicitly prohibits duplicating what the project already states; production behavior was not weakened to satisfy that assertion. The new verified normalization lesson/fresh-task retrieval scenario tests an actual new lesson and passed. Earlier evaluation-script setup mistakes were corrected before reporting the above results; they were not scored as model-quality failures.

## Deterministic and UI verification

Targeted tests cover budget/images/questions accounting, full mandatory fields, tool priorities and ordering, marked omissions, missing and animated images, cancellation, disabled memory, linked clarification, multimodal HTTP payloads, no HTTP on overflow, and bounded overflow assessment without repeated edits or an automatic save. Existing memory cancellation, note, context, compaction, project-isolation and terminal tests remain in the full suite.

A separate synthetic server on port 4300 verified Inspect's image counts, estimated budget, omission counts and explicit fallback/no-autosave explanation. Synthetic fallback metadata was used solely to render that UI state; it is not presented as live-model evidence. The page was visually checked at its existing desktop viewport. Disposable server, browser tab and fixture data were removed.

Final typecheck and web build passed. Full Vitest: **1,014 passed, 1 skipped** across 110 passing files and one skipped file. `git diff --check` passed. See trial-log entry 66. Provider/model thresholds and router behavior are unchanged. `main` is outside this release.
