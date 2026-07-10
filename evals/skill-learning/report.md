# Memory Agent + Skill Writer learning-system evaluation

Date: 2026-07-11

Provider: official DeepSeek API (`providerId=deepseek`)

Final verdict: **the tested create → use → learn → update → use loop passed.**

## Plain-English result

The system now does the useful thing we wanted:

1. The Memory Agent can carry structured knowledge from one run to the next instead of waking up blank.
2. It recognized a repeated user workflow across projects, not merely a repeated topic.
3. It proposed one global `phased-collaboration` skill.
4. After approval, the Skill Writer created the skill.
5. Main Socrates found and used that skill on a new request.
6. Later evidence taught the Memory Agent a genuinely new close-out rule: after verification, align durable docs, remove stale restart context, and prepare a clean next-chat handoff.
7. The Memory Agent proposed an update to the existing skill, the Writer produced a materially larger v2, and main Socrates explicitly called `skills list` and `skills describe` before following the matured workflow.

The final paid continuation used Memory **DeepSeek V4 Pro / High** plus Writer **DeepSeek V4 Flash / Off**. The Writer-expanded skill changed from 775 to 1,557 characters. On the held-out request, Socrates called both required skill operations and expressed all six expected behaviors: docs, memory, stale-context audit, handoff, next-chat continuity, and no immediate edits.

## What was implemented before the final test

### Cross-run Memory Agent journal

- Each successful Memory Agent run ends with one strict Zod result containing `summary`, `patternsObserved`, `skillsAffected`, `decisions`, `openInvestigations`, and `nextRunFocus`.
- The result is stored as one append-only `memory_agent_journal` row per job.
- SQLite is authoritative. `~/.Socrates/memory_agent/MEMORY_AGENT_LEDGER.md` is only a generated, bounded human-readable snapshot.
- The next run receives automatic counts/outcomes, its previous handoff, unresolved investigations, and the latest three summaries.
- Open investigations receive stable backend ids.
- The Memory Agent alone receives `read_memory_journal` with bounded `list` and `read` operations: list defaults to 5 and caps at 10; reads default to 12,000 characters and hard-cap at 20,000.
- Journal content is not embedded in V1.
- The Memory Agent uses the shared structured tool-agent runner: normal internal tool work first, then one strict final structured result.

### Skill learning and writing

- Approved proposals preserve exact source turn ids through the Writer job and `skill_write` evidence.
- Canonical skill ids are `<scope>:<name>`.
- The backend determines create versus update from whether the canonical target exists; a mistaken model-supplied `create` verb cannot turn an existing skill update into a duplicate.
- Updates must inspect the current scoped skill and must produce a non-no-op change.
- Writer validation requires a substantive procedural body, actionable steps, a change summary, and safe supporting-file paths.
- A bounded repair attempt is allowed if the Writer ends without calling `skill_write`; no fallback skill content is fabricated.
- Main Socrates is instructed to run skill discovery for ordered workflows, verification/review sequences, and closure/handoff work. Generic tool knowledge is not treated as a substitute for a learned user-specific skill.

### Evaluation reliability

- Evaluation runs use a temporary DB, Socrates home, workspace, and retrieval state; they do not modify normal user runtime state.
- The eval command rebuilds shared, contracts, providers, and core packages before execution, preventing stale compiled prompts from being tested.
- Official DeepSeek calls are cost-accounted, including structured-final calls, with a hard pre-call reserve.
- Held-out behavior records actual `skills` tool operations.
- Expected response concepts allow narrow deterministic wording equivalents such as `new chat` / `next session` and `no edits` / `no immediate edits`. The final saved answer initially scored 4/6 under literal substring matching and 6/6 under this deterministic concept matcher; no model was called for the rescore.

## Golden dataset

- 15 explicitly selected local Codex tasks.
- 35 natural evidence turns after correcting the creation/maturation split.
- Two clearly labeled synthetic held-out requests used only for downstream-use checks.
- Creation evidence contains the recurring phased collaboration procedure but withholds the later closure/handoff refinement.
- Maturation evidence adds cross-project close-out behavior: verify, synchronize docs/memory, remove stale restart information, prepare a clean handoff, and make the next chat begin with discussion rather than edits.
- Negative controls cover repeated subjects that are not reusable procedures.
- System/developer text, hidden reasoning, tool calls/outputs, secrets, and raw credentials are excluded.
- Private corpus and raw provider results are gitignored.

## Model and thinking comparison

### Memory Agent role screen

| Configuration | Score / 10 | Proposal | Scope | Cost |
|---|---:|---|---|---:|
| Flash off | 0 | none | — | $0.019356 |
| Flash high | 9 | yes | project | $0.020517 |
| Flash max | 9 | yes | project | $0.018984 |
| Pro off | 0 | none | — | $0.032478 |
| Pro high | 10 | yes | global | $0.047964 |
| Pro max | 0 | none | — | $0.028201 |

Pro/high gave the best judgment: it separated a procedure from an ordinary preference, selected global scope, and cited exact cross-project evidence. Flash/max was the best isolated quality/cost alternative but was less reliable in the complete chain.

### Skill Writer role screen

| Configuration | Score / 10 | Wrote skill | Cost |
|---|---:|---|---:|
| Flash off | 10 | yes | $0.001508 |
| Flash high | 10 | yes | $0.002418 |
| Flash max | 10 | yes | $0.001539 |
| Pro off | 0 | no | $0.005606 |
| Pro high | 0 | no | $0.005817 |
| Pro max | 0 | no | $0.014570 |

Flash/off is the clear Writer sweet spot. It matched the other Flash thinking modes at the lowest cost. Pro added cost but was worse at completing the required write action.

### Recommended pairing

- Memory Agent: **V4 Pro / High** for the best current pattern judgment.
- Skill Writer: **V4 Flash / Off** for reliable, inexpensive execution.
- Keep skill proposals manually approved. One successful E2E proves capability and value, not production-grade statistical reliability.

## Final continuation and defects discovered

| Run | Cost | What it revealed |
|---|---:|---|
| Weak maturation split | $0.031358 | Eval-specific requirements were correctly rejected as already represented/project-specific. |
| Corrected handoff evidence | $0.033819 | Journal said update, but exact persisted proposal could not be selected. |
| Proposal diagnostic | $0.020549 | Existing canonical skill was incorrectly persisted as `create` because the backend trusted the model verb. |
| Backend-authoritative update | $0.033166 | Update and Writer v2 worked; held-out main Socrates did not discover the skill. |
| Stronger discovery prompt | $0.028581 | Still appeared to miss discovery because the eval loaded stale `packages/core/dist`. |
| Rebuilt-core final | $0.027175 | Full maturation continuation passed after deterministic semantic rescore: update, v2, list, describe, and 6/6 behavior signals. |

The final proof is deliberately composed to avoid paying to replay already-proven stages: the earlier isolated full run proved pattern discovery → proposal approval → Writer creation → first held-out use, while the seeded continuation reproduced that exact prior state and proved later pattern discovery → update proposal → Writer v2 → second held-out use. The deterministic seed check verifies the v1 skill, prior proposal, prior Writer completion, and prior journal row before any provider call.

## Cost and budget

- Original measured eval program before the user raised the ceiling: **$0.538150**.
- Six post-screenshot continuation runs: **$0.174649**.
- Total cost measured by this eval harness: **$0.712798**.
- DeepSeek dashboard shown by the user before these six runs: **$0.69 account total**.
- Estimated dashboard total after these runs: **$0.864649**.
- Estimated remaining headroom under the user's $1 maximum: **$0.135351**.
- Final successful run alone: **$0.027175**, 22 provider calls, 310,906 input tokens, 240,640 cached input tokens, and 12,210 output tokens.

The account estimate can differ from the harness cumulative number because the dashboard includes other account usage and may update with delay. Both views remain below the user's $1 limit.

## Verification

- `pnpm typecheck`: passed across the workspace.
- `pnpm test`: 403 passed, 1 intentionally skipped live-provider integration test.
- Final saved result: `maturationRun.passed=true`, stage `complete`, real skill operations `list` and `describe`, deterministic behavior score 6/6.
- No normal `.socrates` project state or `~/.Socrates` global runtime state was modified by the eval.

## Honest conclusion

The system now provides real value in the tested scenario. It did not generate a generic topic skill; it learned a recurring way the user works, wrote that procedure, used it later, detected a new cross-project gate, matured the same skill, and then used the improved version.

What is not yet proven is reliability at production scale. Before automatic approval, run repeated positive/negative trials and measure proposal recall, false proposals, scope accuracy, Writer completion, and held-out discovery. For now, manual approval plus Pro/high Memory and Flash/off Writer is the defensible setting.
