# A1 access modes: review and closure

Reviewed on 2026-10-04 in the Documents Socrates checkout, on `socrates-v2`, starting at builder commit `dfec41e`. Baseline: 514 tests and a clean typecheck. The review covered the Access contracts in `architecture/agent-harness.md` and `architecture/server.md`, tools, agent context, background retrieval, settings, HTTP and live transport.

**A1 is closed for its defined harness/server scope.** My folders/full access, ask/auto approvals, absolute and home-relative paths, per-message outside-folder grants, protected data paths, live settings changes and durable tool evidence are implemented and verified. W1 is the next stage. Commands remain unsandboxed, as the A1 contract specifies: cwd checks and approval are not an OS filesystem boundary. No sandbox or web-app completion is claimed.

## Gaps fixed

| Gap | Fix and verification |
|---|---|
| Existing terminals could restart or accept input after folder access was revoked. | Restart/input recheck the current cwd policy before executing; refusal preserves the existing session, and termination remains available. Tests cover changed folders and protected cwd; the live evaluation refuses a restart after changing full access to my folders. |
| Protected search data was filtered only after ripgrep traversal; a protected folder's own symlink target was not protected. | Canonical protected targets and escaped, anchored exclusion globs prune data directories before traversal, including positive inclusion globs. Regressions include a protected directory with glob metacharacters and a malformed ignore file. |
| Outside-folder approvals and mutation-lock waits allowed stale resolved paths. | Revalidate canonical targets after approvals and lock acquisition. Read/edit/patch regressions replace an approved target with a link to protected data and confirm no disclosure or mutation. Unresolvable paths fail closed. |
| Canonical outside files could be mutated concurrently from different workspaces. | Shared canonical file locks cover edit and every patch source/destination, acquired in sorted order alongside the existing workspace lock. A competing edit gets `stale_file` rather than overwriting another workspace's edit. |
| A file approval implicitly granted a subtree; compound parts discarded grants too early. | Directory grants recurse only when approved as directories. Grants are shared across the message's parts, with independent reference/cursor state, and expire before the next message. Canonical allowed paths are compared with their actual case, including case-sensitive macOS volumes. |
| Action previews could silently omit input, including command tails, environment overrides, control keys and changing MCP input. | Complete submitted input or change previews are sent for action approval. Inputs exceeding the preview bound fail with `approval_too_large` before prompting or executing; auto mode retains its existing behavior. |
| Automatic project context, anchor hashing and file embeddings bypassed access settings. | Automatic reads use configured access without silently granting outside-folder permission. Protected anchors/related files and revoked workspaces are omitted. Indexing checks traversal/read access and document admission; revoked workspace sections are removed, and settings changes schedule a refresh. Tests inspect actual embedder inputs and model context for absent private sentinels. |
| Working-folder auto-add could exceed the settings schema's 50-folder limit; stored aliases could change targets. | Revalidate the final merged settings before saving, including auto-added folders, and ignore missing or redirected stored folder permissions. Invalid selection leaves persisted settings unchanged. |
| Live settings updates carried no access value for other tabs to render. | `state.access` and `/api/status.access` expose current settings. Authenticated two-page tests and the live evaluation verify both pages receive the policy. |

The existing valid activated Skill resource grant remains read-only and confined to its revalidated directory. This trusted capability path can read installed Skill resources within server data; it does not authorize general reads of settings, keys, history or other server files. Architecture wording now makes that distinction explicit. Repository metadata remains read-only to direct file mutation, including case variants.

## Validation

- `pnpm typecheck`: passed.
- `pnpm test`: **534/534 tests across 44 files passed**, including **20 added regression cases**; existing capability, classic approval, lane, cancellation and recovery coverage passes.
- `git diff --check`: passed.
- `SOCRATES_ENV_FILE=.env pnpm eval:server`: **13/13 real process scenarios passed**, Gemini `gemini-3.8-flash` with local Ollama embeddings. Authenticated HTTP and WebSocket clients exercised setup, action approval/refusal, outside-folder consent, protected data, full/auto access, policy broadcasts and existing-terminal refusal, parallel lanes, queueing, cancellation, reconnect, crash recovery and graceful shutdown.
- Ignored live artifact: `.socrates/evals/server-gemini-n1woZe/results.json`.
- `SOCRATES_ENV_FILE=.env pnpm eval:server-core`: **9/9 passed**, including real routing/agent tool evidence, on-disk restart, exact pending-call recovery and event-only replay; eight model calls.
- Ignored core artifact: `.socrates/evals/server-core-gemini-Q5fztk/results.json`.

Only disposable synthetic evaluation content was submitted to the provider. No real project documents or user data were used as evaluation fixtures. The live evaluator removes its temporary provider key on completion. No ledger migration or history rewrite is required. The review is committed locally on `socrates-v2`; pushing and work on `main` are outside this closure.
