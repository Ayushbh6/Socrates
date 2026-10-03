# Server S1 closure

Reviewed baseline: `81b1463` on `socrates-v2`.
Completed 2026-10-04 against `architecture/server.md`, `architecture/agent-harness.md` and `architecture/Goal-router.md`.

S1 is closed: data ownership, settings and keys, startup and recovery, security, read APIs, workspace selection and shutdown are implemented and verified. S2's live transport, Send/Queue/lane controls, interactive approvals, cancellation controls and anchor decisions remain the next stage. Approval-gated work is denied by default until that connection exists.

## Findings fixed

| Gap | Final behavior | Verification |
| --- | --- | --- |
| A second server could interrupt the live owner's turns before failing to listen. | An exclusive SQLite sidecar lock is acquired before ledger access, recovery or service startup. The OS releases it after process death. | Same-process duplicate refusal leaves a turn in progress; real duplicate processes fail; SIGKILL permits immediate restart; failed configuration and port binding release ownership. |
| Data isolation checked only the immediate folder; existing directories could remain public. | Classic locations, nested folders and aliases are refused before mutation. Existing directories become private; managed paths cannot redirect through symlinks. Broad home/ancestor selections are refused. | Classic fixture remains unchanged; new nested folders are never created; private modes and rejected key-file aliases are checked. |
| An open vector index was reported as a ready embedder, even without Ollama. | A generic embedding request is probed within three seconds before the index opens. Failure reports keyword fallback; later provider failures update availability. | Failed and signal-ignoring clients degrade correctly; real Ollama passes the live probe. |
| Idle checks did not protect overlapping asynchronous rebuilds. | Configuration owns the runtime through teardown and startup; overlapping settings/key writes receive 409. The old agent is detached before close; shutdown drains a pending update and releases all resources. | Gated rebuild rejects a second change, preserves the accepted setting and key file, and closes/reopens cleanly; lane-only work also blocks changes. |
| Recovery could overwrite active work's note with a queued turn's zero-call note. | All unfinished turns recover atomically with their own evidence and interruption records. The task retains the continuation for work that ran. Settings are validated before recovery. | Running-plus-queued recovery and event replay retain the one-call note; invalid settings leave unfinished turns untouched. |
| Keys with literal backslashes changed when read back; inherited keys were shown as absent; provider errors could echo credentials. | Single-quoted key values round-trip exactly. Effective presence includes inherited keys. Atomic private writes use exclusive temporary files; setup and diagnostic messages redact secrets. Embedding URLs reject embedded credentials and unusable schemes. | Key round-trip, inherited presence, private modes, credential-bearing URL refusal and injected provider-error redaction. The live API never returns its real key; that temporary key file is removed afterwards. |
| Stored working folders were accepted merely because their path existed. | Selection and new-work resolution revalidate an existing canonical directory. Files, changed aliases, classic data, this server's data and its ancestors are refused. | A selected folder changed into a file or redirected into the data home becomes unavailable; virtual workspaces cannot be selected; real model work binds to the chosen fixture. |
| Turn-based pagination could omit compound parts or messages saved before routing. | History pages whole messages in send order with a stable message-event cursor. Unrouted and queued messages remain visible; a compound message may expand the turn budget. `next` is null when no older message exists. | Interleaved compound pages retain every message exactly once; 35 unrouted messages paginate; lane queues remain separate; executable recovery retains an unbound message; live restart and replay reproduce both histories. |
| Shutdown handlers were installed only after startup; partial initialization could leave resources open. | SIGINT/SIGTERM cover startup, including MCP discovery and embedding probes. Partial catalog/store initialization closes on failure; runtime close is idempotent and releases ownership even after service errors. | Real signal tests cancel a stalled embedding request and reap a stalled stdio MCP child; SIGINT closes an established listener; running lane work persists an interruption. |
| Malformed query values produced 500s; unknown routes used a different error shape; authentication responses could be cached; logs grew until restart. | Query schemas reject duplicate values; failures use the documented envelope; malformed JSON cannot echo a key-bearing body. Responses disable caching/referrers/framing; cross-site fetch metadata is checked. Logs rotate while running. | HTTP injection and real-socket Host/Origin/session checks; malformed-query and 404 checks; response headers and in-process log rotation. |

## Validation

- `pnpm typecheck`: passed.
- `pnpm test`: **477 tests across 40 files passed**, up from 454, including existing version 1/2/4 database migrations.
- `git diff --check`: passed.
- `SOCRATES_ENV_FILE=.env pnpm eval:server-core`: **9/9 live scenarios passed**, Gemini `gemini-3.8-flash` for chat and routing, **9 model calls**, local Ollama ready, **zero operational warnings**. Only synthetic fixture content reaches providers.
- Live artifact: ignored `.socrates/evals/server-core-gemini-xZ2wXO/results.json`. A read-only audit of its ledger confirmed zero warnings, and its temporary provider key was removed.

The live evaluation checks real HTTP authentication, setup-needed startup, key and model configuration, partial settings updates, actual router/agent tool use, workspace binding, separate lane history, on-disk restart, recovery with pending evidence, truthful continuation and event-only replay. Since S1 has no message transport, the evaluation executes messages through the server's actual runtime; it does not claim to test S2's WebSocket or UI.

## Compatibility

Settings retain their existing shape. Key deletion restores an inherited value when present. History adds `unrouted`; `before` and `next` remain numeric but now identify message events, so clients must use the returned cursor and discard older project-turn cursors. No event history is rewritten and no ledger version change is required; the two lookup indexes are added during normal store opening. The server reserves `.server-lock.db` inside its data folder for runtime ownership.
