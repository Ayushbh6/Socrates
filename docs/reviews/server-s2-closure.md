# S2 live connection closure

Reviewed on **2026-10-04**, starting from **153164f** on `socrates-v2`, in the primary Documents checkout. `main` and other checkouts were not changed. This review covers the S2 contract in `architecture/server.md`, its HTTP evidence route, store notifications, and the underlying harness paths required for actual lane concurrency.

**S2 is complete and verified locally.** The web app remains the next stage: conversation panels, composer controls, approval UI, folder/settings screens and the browser launcher. This report does not claim frontend acceptance.

## Findings closed

| Gap | Final behavior | Evidence |
|---|---|---|
| All turns shared one serial tool queue. A pending approval or foreground command blocked unrelated lanes. The original live evaluation's completion-time comparison was tautological. | Tool submission order is scoped to each turn. Independent turns work concurrently; file freshness/write sections retain their shared workspace lock. | Simultaneous main/lane approvals are isolated. Existing serial editing tests still pass. The live evaluation waits for main's actual `npm test` call, then checks that the lane's result arrived before main's result. |
| Settings/key changes did not notify live pages; messages queued before setup could remain stuck after a rebuild. | Runtime changes broadcast readiness to subscribed tabs, refuse sends during rebuilding, and resume queued work when ready. | Gated HTTP settings rebuild, two live pages and automatic queue drain; real API key setup updates an already connected page. |
| A send could reuse a queued ID, and completed IDs could run twice after reconnect. Unknown lanes emitted acceptance before asynchronous refusal. Input validation stripped message whitespace. | Accepted IDs remain reserved for the launch across tabs, queue transitions and completed messages. Invalid lanes are refused before acceptance. Exact nonblank message text is preserved. | Queued-ID collision, a second tab, completed-message resend after reconnect, closed/unknown lanes and exact text. |
| Moving a compound message's first part into a lane changed the whole run's panel, even while later parts still owned main. | Compound messages retain their main reservation and aggregate result. Main cancellation reaches the compound run; lane cancellation reaches its active handed-off part and cancels the remaining parts. Status lines follow the active part. `mainReleased` distinguishes single-part and compound handoffs. | Compound handoff cancelled through main and through its lane; existing single-part handoff still frees main. |
| Activity could arrive before `hello` and then arrive again during replay. A cursor ahead of a replaced ledger silently missed work. Reentrant store listeners could deliver newer events before the rest of a committed batch. | Subscription starts at hello/replay. Replay and fresh events do not overlap; ahead-of-ledger cursors reset. After-commit notifications preserve sequence order through reentrant writes. | Event saved between upgrade and hello arrives exactly once; exact replay comparison; future/stale cursor reset; nested transaction rollback and reentrant listener ordering. |
| `/api/evidence` returned model-shortened output although complete terminal/MCP recordings were retained. | The route returns retained output or full structured results and public failure details, capped at 200,000 characters. Output loss is reported separately; internal diagnostics are excluded. Pending calls return null. | A real terminal recording retains its middle text beyond the 2,000-character live preview. Large synthetic output checks the route cap and loss flag; pending and full MCP failure records and invalid numeric selectors are checked. |
| Settled approvals retained abort listeners. Cancellation/shutdown needed proof with more than one conversation. | Approval settlement removes its listener. Pending approvals belong to their run, remain visible on reconnect, and settle on answer, cancellation or shutdown. | Two simultaneous approvals, approval from another tab, independent grant/refusal, late answer rejection and shutdown while approval waits. |
| Hub close was not fully idempotent; it began too late in listener shutdown. Executable shutdown closed the runtime concurrently with hub result cleanup. An unresponsive page could prolong close by 30 seconds. | Hub close starts in `preClose`, shares its drain promise and prevents later commands/broadcasts. The executable drains the app/hub before closing the runtime and ledger. WebSocket close waits at most one second for a page. | Real unresponsive WebSocket peer; server shutdown during an active turn; live Ctrl-C while main waits for approval and a lane runs a command, followed by restart with zero recovery work and both cancellations already saved. |

The review also repaired the baseline reconnect test, which waited for a second state packet that need not exist, and corrected an evidence fixture that unintentionally called an invalid tool schema. Evaluation connection deadlines and waiter cleanup now avoid leftover timeout work on failures.

## Validation

- Baseline: clean typecheck; **486/487 tests passed**, with the reconnect test timing out.
- `pnpm typecheck`: passed after fixes.
- `pnpm test`: **501 tests across 41 files passed**, including **14 new regression cases** and existing migration, tool-ordering, lane, cancellation and recovery tests.
- Targeted live/evidence regressions after the final evidence coverage additions: **22/22 passed**.
- `git diff --check`: passed.
- `SOCRATES_ENV_FILE=.env pnpm eval:server`: **8/8 real process scenarios passed**, using Gemini `gemini-3.8-flash` and local Ollama. The server is driven through authenticated HTTP and WebSocket commands; only disposable synthetic project content reaches the provider.
- Live artifact: ignored `.socrates/evals/server-gemini-E9e2SE/results.json`.
- A separate read-only audit found **25 recorded routing/agent responses, zero operational warnings, three cancelled turns and one restart interruption**. The temporary provider key file is empty after cleanup, and `NOTES.md` contains exactly `lanes work` followed by a newline.

The live scenarios cover setup/readiness broadcasts, a socket-delivered approval and its actual command output, a lane writing a file while main runs its suite, automatic queue execution, mid-tool cancellation, exact reconnect catchup, SIGKILL recovery with a truthful model response, and graceful active-work shutdown verified after reopening.

## Protocol and scope

`handed_off` adds `mainReleased`; evidence adds `outputLost` and returns complete retained recordings rather than model-shortened text. IDs must be unique across tabs for each server launch; rejected submissions do not reserve them. Queues, approval prompts and ID reservations are in memory for that launch. Durable user messages, tool recordings, turn interruptions and lane histories stay in the ledger. A restart clears messages still waiting in the main queue; it does not silently present them as executed.

No event history is rewritten, no ledger migration is required, and settings/key file formats are unchanged. Architecture documents describe the final behavior and the web app boundary.
