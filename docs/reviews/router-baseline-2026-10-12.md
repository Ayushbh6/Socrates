# Router baseline and proposed fixes — 12 October 2026

Status: testing and scope only. Application revision `8386f42`, branch `socrates-v2`. No implementation, model settings, live ledger or running server changed.

## Configuration and isolation

Read the current settings and runtime resolution: router is Automatic, resolving to OpenRouter `openai/gpt-6-luna`, thinking `off`; worker is `deepseek:deepseek-flash`, high effort. All 86 calls in the additional diagnostic replay reported `openai/gpt-6-luna`, effort `off`; no escalation or deterministic fallback occurred there. DeepSeek did not execute any user work. Only router tools `ledger_query` and `ask_user` ran.

The existing comparison suite ran unchanged, three repetitions (72 decisions), in disposable in-memory ledgers. It uses UTC fixture clocks and does not configure worker escalation or a default folder. The additional replay used Europe/Vienna historical clocks, the same current router model/prompt/validator, a fixture working folder and an available DeepSeek escalation client (never invoked). Its 52 decisions generated 86 model calls, 454,809 prompt tokens. Neither experiment is a full worker/memory-pipeline replay: no live user memories, semantic indexes, filesystem tools, approvals, or memory decider ran. This isolates routing with explicitly reconstructed evidence; it does not establish production-wide accuracy.

## Sources and grading declared before replay

Actual queries came from these local Codex sessions:

- `01a11d42-92f5-7d71-86ea-4d325f6ecc2f`, **Gather Socrates repo context**, 8 October: repository orientation, standardizing headers, opening in Flow, returning to the damaged header/sidebar, and diagnosing General/terminal routing.
- `01a120f1-2c6d-7443-917a-eb215d61b13c`, **Find Rabobank job details**, 9 October: recovering the role details, then planning interview preparation.

The routing requests retain the user's actual prose. Image wrapper tags were removed; no screenshots, private documents, tool logs or credentials were sent. Local document paths in prior assistant answers were replaced with placeholders. Prior answers were the recorded final answers, not new generated successes. Additional user steering within a source turn was grouped into prior exchange history when reconstructing independent cases.

Codex sessions do not contain Socrates goal/task bindings. Those bindings were explicitly reconstructed: Socrates development and Job search goals, an initial completed orientation exchange, and bounded tasks for header work, startup behavior, General diagnosis, role recovery and interview preparation. Tasks remain open; this does not invent completed task statuses. Task titles/objectives are evaluation scaffolding, and continuation notes were left empty rather than fabricated. Historical timestamps were retained. No current tested answer or later answer was supplied before its request.

Expected behavior: separate header/startup/diagnosis objectives; return to the earlier header task; recover Rabobank details within the existing Job search goal. For the diagnosis, one new task or a coherent compound route was allowed. For interview preparation, either continuing the Rabobank task or making a new preparation task was allowed. This avoids scoring a reasonable task split as automatically wrong.

Independent runs reconstruct correct preceding bindings before every decision. Sequential runs retain actual model choices and attach the recorded answers as replay evidence. They halt at an unanswered clarification instead of pretending the user answered it. Thus sequence results measure accumulated routing damage, not independent error probabilities. These are text-only, selected challenge cases, not a random sample of all user messages.

## Results

| Experiment | Correct | Other observations |
|---|---:|---|
| Existing full fixture sequences, three runs | 61/72 | 3 decisions flagged as repaired/recovered, 4 normalized; median 1,794 ms, p90 2,759 ms; 75 calls; reported cost $0.0142 |
| Q5–Q10 with independently correct preceding state, three runs | 12/18 | 2 unnecessary clarifications; 3 decisions recorded validation errors |
| Actual-query independent cases, three runs | 6/18 | 5 unnecessary clarifications; 3 decisions recorded validation errors |
| Actual-query connected sequences, three runs | 2/16 | All 3 sequences eventually stopped at clarification; 2 stopped before the sixth query |

Do not combine these into one overall accuracy rate. Recovery counts above use `routing_completed.validation_errors`; invalid tool calls can add rounds without being counted there.

Independent breakdown:

| Case | Correct / 3 | Observed failure |
|---|---:|---|
| Q5 separate issue reproduction | 1 | Kept issue #42 in the memory-review task twice |
| Q6 implement and draft issue update | 2 | Split the update into a separate task once |
| Q7 return to memory-compaction question | 2 | Continued the unrelated issue investigation once |
| Q8 onboarding comparison | 2 | Asked whether the named Socrates design meant another project once |
| Q9 continue onboarding implementation | 3 | No routing failure observed |
| Q10 issue update plus endpoint audit | 2 | Asked whether to proceed with both explicit requests once |
| Actual header standardization | 0 | Continued “Understand the Socrates repository” |
| Actual Flow startup default | 2 | Continued the header task once |
| Actual return to damaged header/sidebar | 0 | Continued the startup-mode task |
| Actual General/terminal diagnosis | 3 | Correctly created a separate investigation |
| Actual Rabobank role recovery | 0 | Asked whether to use the existing Job search project |
| Actual interview preparation | 1 | Asked whether the immediately preceding Rabobank topic meant another application/project twice |

The standard sequential suite repeated Q5 failures in all three runs; several downstream Q6/Q8/Q9/Q10 misses followed that earlier wrong ownership. Independent testing confirms both a cascade and additional standalone mistakes.

## Concrete evidence and diagnosis

1. **Project identity is being substituted for task identity.** One header decision said standardization “advances the ongoing Socrates repository work” and kept the orientation task. Q5 similarly described a different issue as naturally following the memory review. Same project does not mean same bounded objective.
2. **Recency beats explicit subject evidence.** For the header-return case, the actual input listed `current: Start reopened app in Flow`, `task_1: Standardize Flow and Standard header`, and the earlier header answer. All independent runs selected startup anyway. Missing previous turns is not the explanation in these runs.
3. **Clarification leaks into permission/content questions.** Q10 asked whether to proceed with both already-requested parts. Rabobank recovery found no ledger row and treated that as project ambiguity, although Job search was an explicitly listed candidate and the request named it. Interview preparation sometimes queried the ledger, found the active Rabobank task, and still asked if the user meant another project. One question even offered Socrates as an alternative while acknowledging it was unrelated.
4. **Output-channel and schema mistakes remain.** Two G1 follow-ups in the standard suite needed JSON recovery. In the recorded real replay, one startup response emitted duplicated clarification JSON plus textual `to=functions.ask_user`, with no actual tool call. Other repairs included `create_new` with `goal_label: current`, missing new-task definitions, and duplicate compound task selection. A format fix alone will not repair wrong-but-valid destinations.
5. **Task context is thinner than stored task definitions.** `renderGoalEntry` in `packages/router/src/context.ts` shows task title/status and up to 140 characters of note, but omits task objective and completion criteria. This is a concrete implementation observation and a candidate improvement, not proof that adding fields alone will fix the model.
6. **Recovery telemetry is incomplete.** An invalid `ask_user` candidate (`latest` in a goal with no tasks) caused another model round, but the decision's validation-error list remained empty. More calls do not necessarily mean repair: successful ledger queries also require another round. These need distinct counters.

## Proposed implementation scope, in order

1. **Retain a reproducible evaluation harness.** Add independently seeded tests beside sequential tests, with frozen expected ownership and declared alternative acceptable outcomes. Include these real-query patterns as sanitized regression fixtures, plus held-out paraphrases, multiple plausible projects, lanes and General history. Report first-attempt validity, final route accuracy, clarification correctness, individual recovery types, latency and cost separately. Retain sanitized per-case reports, never raw private chat exports in Git.
2. **Improve bounded task evidence and decision instructions.** Expose concise stored objective/completion criteria alongside stable task references, within an explicit router context budget. State an ordered rule: resolve project; resolve the subject/objective; then continue, resume, or create a task. Repository orientation is not a perpetual catch-all task. Related review/fix/test stays together; another issue or feature is a new objective. A clear earlier subject outranks current-task recency. Preserve General daily selection and existing output schema.
3. **Tighten clarification semantics.** Distinguish destination ambiguity from worker questions and action approvals. No matching ledger row is not evidence against the clearly named project: a new task may be required. Do not ask permission to perform an explicit compound request. Reject mechanically invalid/duplicate candidate bindings; use fixtures and prompt constraints for semantic plausibility rather than claiming a validator can prove two arbitrary choices are meaningful. Retain clarification for genuinely competing destinations.
4. **Make decision/tool emission dependable.** Check provider support for constrained structured output or a dedicated routing-result tool without changing the logical decision schema. Preserve ledger-query and real clarification tools; never execute a tool invocation merely because the model printed one in text. Keep bounded recovery and existing selector validation. Do not auto-accept contradictory decisions or force malformed output into General/current.
5. **Measure and choose, rather than assume a model replacement.** Establish the above baseline, then compare one change at a time and repeat current-configuration tests. If decision quality remains inadequate, compare a small set of router configurations on identical independent and sequential cases. Keep the DeepSeek working-agent configuration fixed. Require correct destination, sensible clarification, no safety/isolation regressions and acceptable added latency/cost; do not treat 3/3 as a guarantee.

Acceptance should cover the six actual-query cases, Q5–Q10, G1, ambiguous workspace selection, linked clarification replies, compound dependencies, completed-task reopen semantics, Standard/pinned bypass and lane isolation. Finish with isolated real-model routing replays and inspect actual supplied evidence and decisions. No worker side effects or production history changes are necessary for this router test phase.

## Cleanup

Temporary scripts, extracted source conversations, raw model calls and test logs were deleted after this report was prepared. The tests used in-memory databases and launched no disposable server, terminal command workload or persistent search index. Only this review report is retained; no implementation changes, commit, push or restart were performed.
