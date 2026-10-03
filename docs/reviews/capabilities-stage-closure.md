# PR4 capabilities-stage closure

Baseline: `d79c587` and `c48b389` on `socrates-v2`.
Completed 2026-10-03 against `architecture/agent-harness.md` and `architecture/Goal-router.md`.

All six agreed review findings are addressed. OAuth sign-in, embeddings and the other explicitly deferred architecture segments remain outside PR4.

| Finding | Final behavior | Regression evidence |
| --- | --- | --- |
| 1: overlapping MCP identities | Exact canonical identities flow through search references, activation, approval subjects, dispatch and event replay. Plain names retain compatibility; escaped components use a separate, dot-free namespace. No longest-prefix inference. | Two real HTTP servers whose dotted display names collide each receive only their own call; approvals remain separate; restart and event replay restore both tools; an ambiguous legacy activation is not rebound. |
| 2: stale Skill cache | Turn setup discards prior runtime context before any asynchronous refresh; revalidation clears cached bodies, withholds changed/missing/unreadable Skills and exposes a corrective stale notice. Reactivation validates the current file and records its new version. | Same-process edited, removed and unreadable Skills disappear from context; invalid frontmatter cannot activate; live edited-Skill reactivation follows the new instructions. |
| 3: deactivation exposure | Capability context is synchronized before the next request. Deactivated or superseded bodies leave both the active block and in-flight activation rendering, while exact stored evidence remains intact. Current activation bodies are carried once, including after compaction. | Same-turn and later-turn deactivation; original evidence preserved; existing compaction test; live deactivation followed by further MCP work. |
| 4: global Skill resources | Active context retains resource location and dependencies. `read` permits absolute resource paths under valid active Skill roots, even without a workspace. Realpath containment and goal scope apply; write tools retain workspace restrictions. | Global template read with/without a workspace; denied inactive, other-goal, deactivated, stale, unrelated, traversal and symlink-escape paths; denied edit; restart context retains metadata; live template read outside the workspace. |
| 5: first discovery recovery | Part setup retries servers without a recorded listing after backoff. Search never connects, and known servers retain lazy connection behavior. | Initial HTTP failure, no retry during backoff or search, successful refresh after recovery, activation and call without restarting. |
| 6: cancellation and deadlines | Signals cover connection, listing, activation, restoration, dispatch and definition refresh. Late aborted lists cannot publish snapshots. Part setup consumes the turn's wall-time allowance; expiry permits only bounded tool-free finalization. | Cancellation during an HTTP listing leaves no new snapshot or activation; subsequent activation succeeds; stalled restoration is cancelled without a worker call; stalled setup and post-step refresh reach tool-free deadline wrap-up. |

## Validation

- `pnpm typecheck`: passed.
- `pnpm test`: **341 tests across 25 files passed**, including 15 additional regression cases.
- `git diff --check`: passed.
- `SOCRATES_ENV_FILE=.env pnpm eval:capabilities`: **10/10 live scenarios passed**, Gemini `gemini-3.8-flash`, 33 model calls, zero operational warnings.
- `SOCRATES_ENV_FILE=.env pnpm eval:compaction`: **5/5 live scenarios passed**, 39 model calls; checkpoint recall, rollover, restart, ceiling and replay verified. Largest calibrated request: **10,475 tokens**, below the configured **44,861-token ceiling**. Four expected target-miss/failsafe warnings; no ceiling breach. Artifact: `.socrates/evals/compaction-gemini-imfQDN/results.json`.
- Live capability artifact: ignored local `.socrates/evals/capabilities-gemini-jBrnoq/results.json`.

The live evaluation retains coverage for discovery, activation and immediate calls, approval reuse, instruction deduplication, server restart, schema replacement and event-only replay. It now also checks global resource access, edited-Skill reactivation and deactivation while work continues. Transport failures, cancellation and identity collisions use deterministic real-HTTP fixtures, rather than depending on a model to provoke them.

Existing ordinary `server.tool` identities and approvals remain unchanged. Older identities whose components require escaping fail closed and require a fresh search/activation; their old active records can be explicitly deactivated. They are never silently assigned to another server. No event history is rewritten and no database migration is required.

Original review reproductions remain under ignored `.socrates/reviews/capabilities-c48b389/`; those scripts assert the former defects. The committed tests assert the corrected behavior.
