# Socrates server

The server is the local app process around the harness: it builds the one `Socrates` from the user's settings and keys, keeps it running, and exposes it to the web app on this machine only. Everything the agent does is defined in `agent-harness.md` and `Goal-router.md`; this document covers only how the app runs it.

It is built in two changes:

- **S1, core:** the data folder, settings and keys, startup and recovery, security, and the HTTP API (status, settings, keys, history, goals, lanes, workspaces, folders).
- **S2, live connection:** a WebSocket for sending (Send, Queue, Send in a lane), live activity, approvals, cancellation, and anchor decisions.

Run it with `pnpm server`. It prints a link to open; the web app arrives in a later change.

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

A folder that holds Socrates 0.1's `socrates.sqlite` is refused. On macOS `~/.Socrates` and `~/.socrates` are the same folder, and this Socrates must never read or write the live 0.1 data.

The server listens on `127.0.0.1` port `4200` (`SOCRATES_PORT` changes it), beside Socrates 0.1's `4100` and `3100`.

## Startup

1. Open the ledger and interrupt every turn a stopped process left running (`turn_interrupted` with reason `restarted`, a mechanical continuation note, and its exact evidence kept), so the user can continue it.
2. Open the installed Skills and MCP servers from the data folder. A failure is logged and Socrates runs without them.
3. Open the embedding index with the chosen embedder. A failure (no Ollama, an index from another model) is logged and reported in status; memory search then uses keywords only.
4. Choose the models. The chosen chat model, or else the first provider with a key (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek) and its default models. The router model is the chosen one, or the chat provider's default router model.
5. Build `Socrates`. Without a usable chat model the server still starts, reports what setup is needed, and takes no messages.

Settings and keys can change only while Socrates is idle (no main-conversation message and no lane running); a change rebuilds Socrates from the new values. Stopping the server (Ctrl-C) cancels running work, which is recorded as interrupted, then closes terminals, MCP servers, and the index.

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

**Keys** are not settings. They live in the data folder's `.env`, which holds only known key names (each provider's keys and `SOCRATES_EMBEDDINGS_API_KEY`) and is written whole with mode `600`. Keys there take precedence over the process environment. The API never returns a key, only whether it is set.

**Working folder.** A goal is bound to a workspace permanently when its work starts (`Goal-router.md`, "Workspace resolution"). The server binds a new goal to the workspace chosen as the working folder; without one, the goal works without files and the agent asks where the work belongs. A workspace is added from a folder's full path: an existing directory, by its real path, never the whole disk, the home folder itself, or the data folder. Adding the same folder again returns its workspace; a second folder with the same name gets a numbered name.

## Security

The server can run shell commands on the user's machine, so:

- it listens on `127.0.0.1` only;
- each launch makes a random 256-bit secret. The printed link `/auth?token=…` exchanges it for an `HttpOnly`, `SameSite=Strict` session cookie and redirects, so the secret leaves the address bar; scripts may send it as `Authorization: Bearer …`;
- every request's `Host` must be this server's own address (`127.0.0.1` or `localhost` with its port), so a site cannot reach it through a rebound domain name;
- a request carrying a browser `Origin` must come from this server, so another site open in the browser cannot drive the agent;
- everything except `/api/health` and `/auth` requires the session.

## HTTP API

Every response is JSON. A failure is `{ "error": { "code", "message" } }` with a message meant for the user: `invalid_request` (400), `unauthorized` (401), `forbidden_host` or `forbidden_origin` (403), `not_found` (404), `busy` (409, a change while Socrates works), or `internal` (500, details only in the log).

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

`GET /api/history?conversation=main|<lane id>&before=<project turn>` returns a conversation's messages, newest first, `30` turns per page; `next` is the `before` value of the following page, or `null`. A message's compound parts always stay on one page.

Each item holds the exact message, the router's question when it asked one instead, and one entry per part: its project turn, status, goal and task (number and title), the lane it ran in, its answer, why it was interrupted, and its tool calls as one line each with their evidence handle and status. The main conversation lists the messages sent there, including parts handed to a lane (marked `handedOff`); a lane lists the parts that ran in it.

## Approvals

Every approval belongs to the message that asked (`agent-harness.md`, "Lanes"). Until the live connection supplies each message's approval, the server's default denies, so nothing that needs approval can run unseen.
