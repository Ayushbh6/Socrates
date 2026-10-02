# Agent-stage review closure

Reviewed baseline: `81559f122ecc267ce6f3d7f9ba38d011a3deb9ef` on `socrates-v2`.
Completed 2026-10-02 against `architecture/agent-harness.md` and `architecture/Goal-router.md`.

All eleven agreed Agent-stage findings are addressed. Findings 1 (dynamic MCP activation) and 9 (historical Skill instruction duplication) remain Capabilities stage 4 follow-ups, as agreed; they are not Agent-stage blockers. Compaction, checkpoints and rollover retain their separate implementation stage.

| Finding | Implemented behavior | Verification |
| --- | --- | --- |
| 2: hard context ceiling | Every work, retry, wrap-up and repair request passes the calibrated 180,000-token gate, including native replay content. An oversized final request produces a mechanical partial answer without proposals. | Large tool batches, oversized repair and raw reasoning regression cases |
| 3: completed tasks reopen | A null completion proposal preserves task status; only explicit routing reopens work. | Historical answer preserves completion and timestamp; explicit reopening still works |
| 4: cancellation races | Cancellation is rechecked after model responses and before atomic persistence. | Ordinary and repaired final-response races; live cancellation with exact response retained |
| 5: wall deadline | Deadline reaches model, tools, retries and approval waits. Late results cannot resume mutations. Tool-free finalization has its own bounded allowance. | Slow and hanging providers, late edits and late approvals |
| 6: part setup failure | Workspace resolution and acknowledgment failures interrupt the failed part and finalize later bound parts as unstarted. | Recovery on next message, compound failure, thrown undefined, persistence rollback |
| 7: repair provider failure | Provider failure interrupts; it cannot masquerade as a returned-but-invalid repair. | Permanent repair error produces model-error evidence without displaying the candidate |
| 8: finalization tool calls | Unexpected native calls are recorded as refused and cannot supply accepted state proposals. | Repair and wrap-up refusal, matching tool results in repair history |
| 10: anchor lifecycle | User declarations and trusted application selections activate or supersede anchors; autonomous conflicts ask one persisted question. Rejection/ignore suppression, hash revalidation, repeated-use promotion and reversible removal are enforced. | Restart/replay confirmation, conflict batching, scoped decisions, stale/ambiguous approval, invalid/cancelled turns, repeated reads; live canonical declaration |
| 11: compound evidence | Test evidence is selected by the finalized source turn's event IDs, not overlapping timestamps. | Delayed older test excluded; current test retained |
| 12: exact assistant history | Received work, wrap-up and repair responses enter the event log before interpretation. Inspection exposes bounded text while native metadata stays internal. | Intermediate and invalid candidates survive replay and are retrievable |
| 13: exact current message | Current user payload preserves leading and trailing whitespace inside its delimiter. | Indented code and blank-line regression |

Final responses, anchor policy changes and turn completion share a transaction. An application persistence exception cannot leave half-applied completion state.

## Validation

- `pnpm typecheck`: passed.
- `pnpm test`: **277 tests passed across 19 files**, including 32 new regressions/lifecycle cases.
- `SOCRATES_ENV_FILE=.env pnpm eval:agent`: **9/9 live scenarios passed**, using Gemini `gemini-3.8-flash`, 47 model calls, zero operational warnings. Only synthetic calculator content was sent.
- Live evidence: ignored local `.socrates/evals/agent-gemini-zEHCj5/results.json`.
- `git diff --check`: passed.

The live run validates normal end-to-end behavior; deterministic tests exercise cancellation races, failures, deadlines and budget boundaries. The final additional ambiguous-confirmation guard is covered by the regression suite; it does not change the successful direct-declaration live scenario. Real MCP servers, Skill sources and compaction are not claimed as implemented by this closure.
