# Socrates server

The server is the local app process around the harness: it builds the one `Socrates` from the user's settings and keys, keeps it running, and exposes it to the web app on this machine only. Everything the agent does is defined in `agent-harness.md` and `Goal-router.md`; this document covers only how the app runs it.

It is built in two changes:

- **S1, core:** the data folder, settings and keys, startup and recovery, security, and the HTTP API (status, settings, keys, history, goals, lanes, workspaces, folders).
- **S2, live connection:** a WebSocket for sending (Send, Queue, Send in a lane), live activity, approvals, cancellation, and anchor decisions.

Run it with `pnpm server`. It prints a link to open; the web app arrives in a later change. `pnpm eval:server` drives the real server process through its API and live connection with real models.

## Data folder

Everything lives in one folder, `~/.socrates-v2` unless `SOCRATES_HOME` names another, created readable only by the user:

| Path | Holds |
|---|---|
| `ledger.db` | the event log and ledger |
| `ledger.db.lance` | the embedding index |
| `settings.json` | the user's choices (see "Settings") |
| `.env` | API keys, mode `600` |
| `skills/`, `mcp.json` | global Skills and MCP servers |
| `logs/server.log` | diagnostics; one previous log of up to 5 MB is kept |
| `.server-lock.db` | the exclusive runtime ownership lock, automatically released when its process stops |

A folder that holds Socrates 0.1's `socrates.sqlite`, its descendants, and aliases of them are refused, as is the old `~/.socrates` location itself. On macOS `~/.Socrates` and `~/.socrates` are the same folder, and this Socrates must never read or write the live 0.1 data. The home folder and its ancestors cannot be used as the data folder. Existing data and log directories are made private; managed paths cannot redirect through symbolic links.

The server listens on `127.0.0.1` port `4200` (`SOCRATES_PORT` changes it), beside Socrates 0.1's `4100` and `3100`.

## Startup

1. Claim the data folder exclusively, validate settings, then open the ledger and interrupt every turn a stopped process left running (`turn_interrupted` with reason `restarted`, a mechanical continuation note, and its exact evidence kept), so the user can continue it. A second server using the same data folder is refused before it can recover the live owner's turns. Recovery is atomic; zero-call queued handoffs do not replace the continuation note of work that already ran.
2. Open the installed Skills and MCP servers from the data folder. A failure is logged and Socrates runs without them.
3. Probe the chosen embedder with a generic query, bounded to three seconds, then open its embedding index. A failure is logged and reported in status; memory search then uses keywords only. Opening an index alone never means that Ollama or a hosted provider is reachable. Later embedding failures update status too; each model and endpoint uses its own index namespace.
4. Choose the models. The chosen chat model, or else the first provider with a key (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek) and its default models. The router model is the chosen one, or the chat provider's default router model.
5. Build `Socrates`. Without a usable chat model the server still starts, reports what setup is needed, and takes no messages.

Settings and keys can change only while Socrates is idle (no main-conversation message and no lane running); a change rebuilds Socrates from the new values. This claim lasts through the entire rebuild, and overlapping changes receive `busy`. The old runtime is detached before teardown; close drains a pending change and is idempotent. Stopping the server (Ctrl-C or SIGTERM) cancels running work, which is recorded as interrupted, then closes terminals, MCP servers, and the index. Signals during startup also cancel service discovery and embedding probes, including child processes started before the HTTP listener exists.

## Settings

`settings.json`, validated on load and on every change. A broken file stops the server with a clear message rather than being reset.

| Setting | Default | Meaning |
|---|---|---|
| `chat` | `null` | `{ provider, model }` of the working agent; `null` detects it from the keys |
| `router` | `null` | `{ provider, model }` of the Goal Router; `null` uses the chat provider's router default |
| `embeddings` | Ollama, `embeddinggemma` | `{ provider, model, url }` as in `agent-harness.md`, "Embeddings and hybrid retrieval" |
| `timeZone` | `null` | an IANA time zone; `null` follows the machine |
| `workingFolder` | `null` | the workspace new work is bound to |

A change sends only the fields that change; the others keep their values.

**Keys** are not settings. They live in the data folder's `.env`, which holds only known key names (each provider's keys and `SOCRATES_EMBEDDINGS_API_KEY`) and is written atomically with mode `600`, preserving literal backslashes. Keys there take precedence over the process environment. The API never returns a key, only its effective presence, including inherited keys. Deleting a stored key restores any inherited value of the same name. Provider diagnostics and setup messages redact secrets. Embedding URLs must be HTTP or HTTPS base URLs without embedded credentials, query parameters or fragments.

**Working folder.** A goal is bound to a workspace permanently when its work starts (`Goal-router.md`, "Workspace resolution"). The server binds a new goal to the workspace chosen as the working folder; without one, the goal works without files and the agent asks where the work belongs. A workspace is added from a folder's full path: an existing directory, by its real path, never the whole disk, the home folder itself, classic Socrates data, or a folder inside or containing this server's data. Selection and new-goal binding revalidate the stored path; a missing folder, file, or changed alias is unavailable. Adding the same folder again returns its workspace; a second folder with the same name gets a numbered name.

## Security

The server can run shell commands on the user's machine, so:

- it listens on `127.0.0.1` only;
- each launch makes a random 256-bit secret. The printed link `/auth?token=…` exchanges it for an `HttpOnly`, `SameSite=Strict` session cookie and redirects, so the secret leaves the address bar; scripts may send it as `Authorization: Bearer …`;
- every request's `Host` must be this server's own address (`127.0.0.1` or `localhost` with its port), so a site cannot reach it through a rebound domain name;
- a request carrying a browser `Origin` must come from this server, so another site open in the browser cannot drive the agent;
- requests marked cross-site by the browser are refused, even without an `Origin`;
- everything except `/api/health` and `/auth` requires the session.

Responses cannot be cached, the launch link cannot become a referrer, and the page cannot be framed. Cookies are scoped to a host, not a port; the Origin and Host checks remain necessary when other local apps use that host.

## HTTP API

API responses are JSON. A failure, including an unknown route, is `{ "error": { "code", "message" } }` with a message meant for the user: `invalid_request` (400), `unauthorized` (401), `forbidden_host` or `forbidden_origin` (403), `not_found` (404), `busy` (409, a change while Socrates works or rebuilds), or `internal` (500, details only in the log). Repeated query parameters and malformed JSON are rejected without echoing a key-bearing request body. `/auth` redirects; `/` currently serves the app placeholder.

| Route | Returns |
|---|---|
| `GET /api/health` | `{ ok: true }`, without a session |
| `GET /api/status` | readiness and setup needed, the models in use and why, embedding state and index size, time zone, whether main is busy, the lanes, the working folder, and how many turns startup interrupted |
| `GET`, `PUT /api/settings` | the settings; `PUT` takes any subset and returns the result |
| `GET /api/keys` | each known key name with whether it is set |
| `PUT`, `DELETE /api/keys/:name` | set (`{ value }`) or remove a key |
| `GET /api/goals` | every goal, most recently updated first, with its tasks, notes and workspace |
| `GET /api/history` | one conversation's messages (see "History") |
| `GET /api/lanes` | open lanes with whether each is running or waiting for approval |
| `GET`, `POST /api/workspaces` | the workspaces; `POST { path }` adds one |
| `GET /api/folders?path=` | a folder's visible subfolders (default: the home folder), for choosing a workspace |

## History

`GET /api/history?conversation=main|<lane id>&before=<cursor>` returns a conversation's messages in send order, newest first, with a budget of `30` turns per page; a message with no bound turn counts as one. `next` is the `before` value of the following page, or `null` when no older message exists. The cursor is a stable message-event sequence; callers pass the returned value, never a project-turn number. A message's compound parts always stay on one page, even when they interleave with other messages.

Each item holds the exact message, `unrouted` when no part has been bound yet, the router's question when it asked one instead, and one entry per part: its project turn, status, goal and task (number and title), the lane it ran in, its answer, why it was interrupted, and its tool calls as one line each with their evidence handle and status. A message saved before routing, or queued in a lane, remains visible after restart. The main conversation lists the messages sent there, including parts handed to a lane (marked `handedOff`); a lane lists messages sent there and parts handed to it.

## Live connection

`GET /api/live` upgrades to a WebSocket, under the same Host, Origin and session rules as every request; a refused upgrade is answered and its connection closed. It carries JSON messages. All live state is held by the server, so a reload or a second tab sees exactly the same thing.

A page loads the status (which carries `seq`, the event it reflects) and the history, then sends `hello` with `after: seq`. The server answers with the current state and every activity after that event; a page more than `5,000` events behind gets `reset` and reloads its history instead.

**From a page:**

| Command | Effect |
|---|---|
| `hello { after? }` | the state, then the activities after `after` |
| `send { id, text, to, anchorDecisions? }` | `to` is `main`, `new_lane`, or an open lane's id. `main` is refused with `main_busy` while main works: the composer queues instead. A fifth running lane is refused with `lane_limit`. `anchorDecisions` are the user's explicit anchor selections (`agent-harness.md`, "Final result") |
| `queue { id, text }` | wait for the main conversation; queued messages run in order as soon as main is free (at most `20`) |
| `queue_edit { id, text }`, `queue_remove { id }`, `queue_to_lane { id }` | change, drop, or send a queued message in a new lane instead |
| `cancel { conversation }` | stop what runs in `main` or a lane, including a message handed to that lane |
| `approve { approval, granted }` | answer a pending approval |
| `close_lane { lane }` | close an idle lane |

`id` is the page's own name for a message (letters, digits, `_` and `-`), echoed in every reply about it. Text is at most `100,000` characters.

**From the server:**

| Message | Meaning |
|---|---|
| `state` | `seq`, readiness and setup needed, whether main is busy, the lanes, the main queue, and pending approvals; sent on every change |
| `accepted { id, conversation }` | the message started; for `new_lane`, `conversation` is the new lane's id |
| `activity` | one saved event (see "Live activity") |
| `approval` | a new pending approval: its id, conversation and lane, task, kind, tool, and the one line the user approves |
| `handed_off { id, conversation, lane }` | a main message went to the lane busy with its task; main is free |
| `status { id, conversation, text }` | the plan of a split message, or a quiet status line during long work |
| `result { id, conversation, result }` | the message is done: its text, lane, per-part outcome, notices, and anchor changes |
| `error { id?, code, message }` | a refusal or failure, with a message meant for the user |
| `reset { seq }` | too far behind; reload the history |

## Live activity

Every event is shown to the pages once it is saved (after its transaction commits), as one compact activity with the event's `seq`, time, and conversation (`main` or a lane id; a turn's activities belong to the conversation it runs in now):

`message` (the exact text), `routed` (goal, task, lane), `question` (the router's clarification), `step` (the agent's narration before tool calls), `tool_started` (the call as one line, with its task and evidence handle), `tool_finished` (status and the first `2,000` characters of output), `answer`, `finished` (completed or interrupted, and why), `handed_off`, `lane` (opened or closed), `approval_decided`, `warning`, and `ledger` (goals or tasks changed: reload them).

`GET /api/evidence?task=gN/tN&handle=eN` returns one tool call's recorded output, up to `200,000` characters.

## Approvals

Every approval belongs to the message that asked (`agent-harness.md`, "Lanes"). It is shown to every page in the panel of the conversation that asked, and waits for an answer. Stopping that run, or the server, refuses it, and so does a run that ends while it waits. Work that nothing has asked approval for never waits.

## Stopping

Ctrl-C (or `SIGTERM`) cancels every running message and waits until each is recorded as interrupted, refuses pending approvals, disconnects every page, then closes terminals, MCP servers, and the index.
