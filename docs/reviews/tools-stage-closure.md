# Tools stage closure

Reviewed `c900702bd78645b003fa9586721276e902023728` against `architecture/agent-harness.md`, `architecture/Goal-router.md`, and the original tools review. The original regressions pass. This follow-up closes additional implementation gaps and completes the **Tools** stage in the architecture's staged build order.

## Additional findings fixed

| Area | Remaining gap at c900702 | Final behavior |
|---|---|---|
| Patch cancellation | Cancellation after commit began did not stop or roll back later writes | Cancellation is checked between writes and after the last write; completed changes are rolled back |
| Rollback | A skipped restoration could report success; recursive directory cleanup could delete concurrent user files | Restoration conflicts are reported explicitly; only empty directories created by the patch are removed; concurrent user content survives |
| Process ownership | Descendants inheriting stdout/stderr prevented `close`, so cleanup never started | Group cleanup starts at shell `exit`; `close` drains final output; shutdown clears lingering cleanup timers |
| Terminal restart/wait | Restart readiness ignored cancellation; polling leaked change listeners; ready waits could exceed their policy deadline | A cancelled replacement is stopped; polling cleans up timers/listeners; readiness obeys the remaining wait budget |
| Terminal output | JSON escaping could push a page over the ceiling, and the runner's fallback could break structured output | Terminal bounds count the rendered JSON; large escaped lines page without losing characters; loss flags remain truthful |
| Mutation approval | Terminal control and activated MCP calls could bypass the first-mutation gate | Write/restart/signal/terminate and MCP invocations go through the gate; read/list/wait remain observations |
| MCP input validation | Only required top-level arguments were checked | Ajv validates the advertised JSON Schema, including nested objects, types, bounds, enums and extra-property restrictions; invalid schemas fail activation |
| Capability freshness | Cached tools could remain callable after availability/schema changes; Skill version equality was insufficient | Dispatch revalidates availability and schema digest; changed schemas require refreshed definitions; Skills require matching content digests; aggregate refresh limits are checked before any replacements |
| Failure recovery | Stored server error detail was missing from evidence inspection | `context_retrieve inspect eN` exposes the bounded stored failure detail |
| Discovery | picomatch patterns differed from ripgrep's dialect; an explicit ignored file could bypass ignores | Native ripgrep glob matches are intersected with its ignore-respecting listing; explicit file targets also obey ignores; collection-cap metadata survives cursors |
| Context bounds | Post-page shrinking could remove rows already consumed by a cursor, replace object rows with strings, or leave `complete: true` | Paging accounts for bytes and lines as well as tokens; aggregate reduction preserves row types and correct omission/completeness metadata |
| Text and paths | Token-array spreading failed on large ordinary output; special-token literals threw; punctuation fallback lost indentation; impossible dates passed validation | Token accumulation avoids argument limits and treats special-token literals as text; Unicode fallback re-indents each occurrence; dates must be real; valid `..config` names are accepted while nested `.git` metadata is protected |
| Event replay | Replaying tool and terminal facts regenerated their identities | New fact IDs derive from their source event and index, so new workflow projections replay exactly |

Temporary sibling files are also cleaned up after write failures. Patch rollback deliberately preserves concurrent user edits and names conflicts rather than claiming success. Per-file rename/exclusive creation and a workspace mutation lock provide the commit protocol; this is not a crash-atomic multi-file filesystem transaction.

## Architecture coverage

| Stage-one contract | Evidence |
|---|---|
| Exactly ten permanent tools with fixed order and native definitions | Contract tests and the integration fixture |
| Shared validation, corrective errors, cancellation, approval and bounded results | Contract, filesystem, editing, terminal, memory and review regression suites |
| Workspace containment, canonical symlink policy, metadata protection and stale edits | Filesystem/editing tests plus both review suites |
| Terminal lifetime, readiness, paging, restart, deadlines, ownership and delayed test facts | Terminal tests plus both review suites |
| Permanent evidence handles, observations and derived ledger facts | Evidence tests, persistent restart and exact event replay |
| Goal-scoped capability activation and dispatch through the catalog interface | Skill/MCP tests, fresh-schema validation, aggregate-limit regression and integration fixture |
| Native provider call/result continuation through the actual runner | Live Gemini fixture with all ten definitions exposed, an actual `read` call and the correct final record ID |

## Validation

- `pnpm typecheck`: passed.
- `pnpm test`: **214 tests passed in 13 files**, including the original regressions and 19 closure regressions.
- `pnpm eval:tools`: passed; all ten permanent tools, file edits and creation, service restart/termination, Skill/MCP activation and invocation, invalid MCP arguments, evidence inspection, persistent restart and event-only projection replay.
- `SOCRATES_ENV_FILE=.env pnpm eval:tools --live`: passed with `gemini-3.8-flash`; only synthetic fixture content is sent to the provider. The result is archived in `tools-stage-live-results.json`.
- `git diff --check`: passed.

The reproducible fixture is `packages/tools/eval/run-tools-e2e.ts`. It writes synthetic workspace files, SQLite evidence and a result report under ignored `.socrates/evals/tools-*`, and closes its terminal supervisor and databases.

## Scope and remaining stages

No blocking implementation findings remain in the reviewed Tools stage. The catalog interface, activation state and MCP dispatch are implemented and tested. Real installed-Skill loaders, configured MCP transports, the Skill shelf and automatic capability candidates belong to stage four. The production working-agent loop, FinalAnswer, context assembly and caching belong to stage two; compaction and rollover belong to stage three. PTY support, terminal reconciliation across application restart and embeddings retain their documented later scope.

Background sessions retain four million characters and foreground commands sixteen million; dropped output is explicitly reported. Process supervision owns the command's process group, not arbitrary processes that deliberately create a different group. The implementation is not an OS sandbox. Legacy fact rows created before deterministic IDs retain their current IDs; replay reconstructs their values, attribution and timestamps, while new fact rows also retain identical IDs.
