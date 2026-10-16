# Router prompt diagnosis — 16 October 2026

Evaluation only on `socrates-v2`; application code and existing reports remain unchanged. Real router calls used OpenRouter `openai/gpt-6-luna`, effort off. These are frozen-input routing probes, not end-to-end worker replays or a released fix.

**A combined reference-resolution instruction corrected the failed Q6 in discovery and fresh confirmation. The evidence does not isolate one internal cause, and it does not establish a Q11 fix.**

## The reproduced failure

Q5 explained `4x + 8 = 24`; Q6 asked, “For that equation, why do I subtract before dividing?” The supplied current directory was unambiguous:

| Task | Supplied label | Status |
|---|---|---|
| Practise linear equations — owns Q5 | `current` | completed |
| Solve equations with x on both sides | `task_1` | open |

Baseline repeatedly emitted `task_1`. Some reasons nevertheless named the completed practice task or the correct equation. Reasons are generated output, not reliable access to the model’s internal selection process.

The router receives a fresh request. **There is no evidence that it remembered a label mapping from an earlier call.** The failure reproduced from the frozen Q6 payload alone. Current/older routing labels were preserved in the successful candidate.

## Discovery

Each listed variant had three fresh calls. Scores below concern destination labels; they do not automatically certify all output fields.

| Diagnostic change | Correct destination |
|---|---:|
| Unchanged baseline | 0/3 |
| Label-field descriptions, title/label adjacency, choice table, or schema mapping | 0/3 each |
| Completed-follow-up rule, or explicit legal example for completed current task | 0/3 each |
| Remove optional Q5 exercise reminder | 0/3 |
| Remove all notes; retain only previous exchange; replace numeric task references | 0/3 each |
| Remove goal note; move history later; explicitly name Q5’s equation | 1/3 each, all with `reopen_task=true` |
| Explicitly name the practice task in the user request | 3/3, all with `reopen_task=true` |
| Require selected task title before labels | 2/3 |
| **Combined reference-resolution rule, placed first** | **3/3, all `reopen_task=false`** |

Other unsuccessful probes included a minimal system prompt, reason-first output, current-binding/previous-owner titles, previous-owner labels, separate messages, and changing only the current task’s status field to open. That last probe retained “completed/closed” wording in notes, so it does not rule out completion-language influence.

The title-first probe supplied direct evidence of an output inconsistency: one response explicitly returned `selected_task_title="Practise linear equations"` alongside `task_label="task_1"`, which the same directory assigned to the other task. This supports checking title/label consistency; it does not prove that every failure is merely label copying.

## Successful instruction, unchanged in confirmation

> Resolve references BEFORE matching task objectives: when the user asks about "that equation", "that result" or "why", first identify the subject of the preceding USER_REQUEST and its answer. An unrelated optional exercise or offer appended by the assistant is not a user topic change. Keep the follow-up with the task that answered that subject, even if its status is completed. Then copy that task's route_label from the current directory.

## Fresh confirmation

Baseline and candidate calls were interleaved, three repetitions per case. No schema or routing-label changes were made.

| Frozen request | Baseline | Combined rule first |
|---|---:|---:|
| Previously failing Q6 | 0/3 | **3/3** |
| Explicit return to the other maths task | 3/3 | 3/3 |
| Named German-website goal switch | 3/3 | 3/3 |
| Another previously passing Q6 | 3/3 | 3/3 |

No confirmation response set `reopen_task=true`. The other-Q6 control returned null in both conditions; this is a destination-preservation result, not an assertion that every field was strictly validated.

Additional failed-Q6 probes: the full rule placed last scored **2/3**; reference-resolution wording alone **0/3**; the optional-offer sentence alone **0/3**. These small samples suggest the combination and placement matter here. They do not establish which clause caused the improvement. Removing the offer itself also failed, so blaming that offer alone is unsupported.

## Scope of the conclusion

The combined rule is a promising candidate for broader evaluation. It was selected adaptively from many variants and confirmed on only four fixtures; this is not an unbiased estimate of general routing accuracy. Some diagnostic variants changed input facts, output schema, or substantial prompt structure, so they are not all equivalent production patch candidates.

No Q11 inference was run in this experiment. Its earlier recorded input correctly identified German website as `current` and maths as `older_1`; the user explicitly named German, and history used 4,610/20,000 tokens without omissions. That separate title/label failure remains unresolved. No commit, push, live restart, or production prompt modification was performed.

Retained evidence: [discovery and exact request variants](/Users/aparajitbhattacharya/.codex/visualizations/2026/10/16/01a1423a-703b-7603-ac27-2965e6d85bda/router-prompt-diagnosis/), including `results.json`, `round2.json`–`round5.json`, `confirmation.json`, `ablation.json`, the runners and captured wire payloads. The prior [image-context evaluation](image-context-results-2026-10-16.md) is unchanged.
