# Memory-Front Implementation And Eval Report

Date: 2026-07-11

## Outcome

The agreed memory-front architecture is implemented across prompt assembly, Socrates surface discovery, large-paste ingestion, attachment provenance, repeated compaction, snapshot reuse, model routing, and evaluation tooling.

The recommended compactor remains official DeepSeek V4 Flash with thinking Off. It was the cheapest reliable tested option. Early repeated runs exposed stochastic loss of exact attachment paths, commands, and explicit unresolved instructions. Those high-value artifact classes now receive bounded deterministic carryover. The final improved five-round run preserved all eight canaries and completed the full downstream attachment, trace, project-memory closure, stale-state removal, and fresh-conversation flow.

## Baseline And Dataset

- Pre-change baseline: `evals/memory-harness/baseline.json` at commit `16e3ff5`.
- Golden dataset: 28 sanitized natural turns exported from the current Codex session plus 8 synthetic canaries, for 36 turns total.
- Canary categories: exact phrase, current-vs-stale context thresholds, exact command, file path, ordered workflow, attachment source path, surface-registry decision, and unresolved recovery instruction.
- Raw exported conversations and live result JSON are private and gitignored. The schema, exporter, runner, baseline, and this report are tracked.

## Model Results

| Model | Thinking | Repeated run | Model canaries | Downstream harness | Recorded cost | Decision |
|---|---:|---:|---:|---|---:|---|
| Official DeepSeek V4 Flash (baseline implementation run) | Off | 5 rounds | 7/8 | Passed exact trace recovery and rejected stale 200k value | $0.009102 | Led to attachment-path gate |
| Official DeepSeek V4 Flash (final improved confirmation) | Off | 5 rounds | 8/8 | Trace + selective attachment read + project-memory closure + stale-state removal + fresh resume all passed | $0.011123 | Default |
| Official DeepSeek V4 Pro | High | Timed out during round 4 | Incomplete | Not completed | Included in partial ledger | Reject for this job |
| OpenRouter Tencent HY3 | Off | Round 2 timed out | Incomplete | Not completed | Partial | Reject for this job |
| OpenRouter Tencent HY3 | High | Round 1 timed out | Incomplete | Not completed | Partial | Reject for this job |
| OpenRouter GLM 5.2 | High | 2 rounds | 7/8 | Passed exact trace recovery and rejected stale 200k value | $0.024879 | Fallback |
| ChatGPT Codex GPT-5.6 Luna | Medium | Provider rejected request | N/A | N/A | Subscription | Unavailable on connected account |

`gpt-5.6-luna` was present in the local Codex model cache but the connected Socrates ChatGPT OAuth endpoint returned `Model not found gpt-5.6-luna`. The catalog row is declared so supported accounts can expose it, but this account could not be benchmarked.

## Reliability Improvement From The Eval

DeepSeek Flash and GLM both initially retained the fact that an attachment existed but omitted the exact `.socrates/attachments/pasted-text-eval.txt` path in their final summary. Later torture iterations also showed that an already preserved exact command could disappear across another round, and an explicit unresolved instruction could be dropped. The compressor now carries bounded attachment paths into `relevantFiles`, exact shell commands into `toolState`, and explicit unresolved/do-not-complete instructions into `blocked`; the validated final paid confirmation scored 8/8 after five rounds.

Other compaction gates now enforce:

- trigger at 170k estimated tokens;
- successful rebuilt request at or below 120k;
- 180k hard pre-provider ceiling;
- normal minimum reduction of 20k tokens;
- anchors may name only turns actually supplied to the compressor;
- active snapshots remove already represented raw turns before later token counts/provider calls while SQLite remains authoritative;
- structured summary fields have bounded line and total sizes.

## Cache And Cost

The first complete DeepSeek Flash run reported 11,008 cached input tokens out of 11,109 on its first compaction call, with later calls continuing to report cache reuse. This supports the stable-prefix ordering: base prompt, compact identity core, global rules, project rules, surface map, then dynamic context.

- DeepSeek dashboard starting total: $0.86; hard ceiling: $1.05.
- Known recorded eval spend after that screenshot: about $0.1187, including the complete Flash runs, partial Pro run, and focused reliability confirmations.
- Interrupted requests can be billed before local timeout accounting sees a final usage record, so the harness also reserved a safety margin and stopped before the ceiling.
- OpenRouter starting spend: $0; hard ceiling: $1.50.
- Recorded OpenRouter eval spend: about $0.02854. With the interruption reserve, projected spend remained under $0.08.
- Starting from the user's $0.86 screenshot, known recorded spend projects about $0.9787 total. Interrupted calls can add small unreported usage, but the harness reserved margin and remained below the $1.05 ceiling. The final self-contained run itself cost $0.011123.

## Implemented Product Behavior

- A code-owned nine-surface Socrates registry generates the small model-facing `.socrates` map and drives path/storage guards.
- The stable system prefix no longer contains volatile user/project metadata.
- Inline messages are capped at 10,000 characters; larger pasted text becomes a private project attachment and is referenced by a compact manifest.
- Messages accept at most 15 text/image attachments, 5 MB each and 20 MB combined.
- Text attachment bodies are read on demand; image bytes are sent only to vision-capable models.
- The repeatable eval scripts export sanitized Codex history, enforce provider budgets before calls, log usage/cache/cost, run sequential compactions, score canaries, and exercise downstream trace retrieval.
- The final downstream run called `trace_retrieve`, selectively read `.socrates/attachments/pasted-text-eval.txt`, recovered `ATTACHMENT-EVIDENCE-942`, wrote `MEMORY_HARNESS_E2E_COMPLETE: ATTACHMENT-EVIDENCE-942` through `project_docs`, then started a fresh agent conversation that read project memory and recovered the exact completion marker.

## Remaining Scope

This is a serious capability baseline, not statistical proof across every model and corpus. Future runs should add independent long-session corpora and a 10-round case when there is a concrete regression to investigate. HY3 should not be retried as a compactor until its structured-output latency materially improves. Luna needs an account/endpoint that actually exposes the model.
