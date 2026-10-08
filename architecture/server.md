# Socrates server

The server is the local app process around the harness: it builds the one `Socrates` from the user's settings and keys, keeps it running, and exposes it to the web app on this machine only. Everything the agent does is defined in `agent-harness.md` and `Goal-router.md`; this document covers only how the app runs it.

It is built in two changes:

- **S1, core:** the data folder, settings and keys, startup and recovery, security, and the HTTP API (status, settings, keys, history, goals, lanes, workspaces, folders).
- **S2, live connection:** a WebSocket for sending (Send, Queue, Send in a lane), live activity, approvals, cancellation, and anchor decisions.

Run it with `pnpm server`, which prints a link to open, or with `pnpm socrates`, which also builds the web app (`web.md`) and opens the link in the default browser. `pnpm eval:server` drives the real server process through its API and live connection with real models.

## Data folder

Everything lives in one folder, `~/.socrates-v2` unless `SOCRATES_HOME` names another, created readable only by the user:

| Path | Holds |
|---|---|
| `ledger.db` | the event log and ledger |
| `ledger.db.lance` | the embedding index |
| `calls.db` | every model call, kept apart from the ledger and forgotten after 30 days (`observability.md`) |
| `settings.json` | the user's choices (see "Settings") |
| `attachments/` | images the user attached to messages, named by content hash (see "Attachments") |
| `.env` | API keys, mode `600` |
| `skills/`, `mcp.json` | global Skills and MCP servers |
| `logs/server.log` | diagnostics; one previous log of up to 5 MB is kept |
| `standard.json` | the number of the goal standard mode shows as its plain "Chats", made with the first chat outside a goal |
| `terminals.json` | the process groups of running terminal sessions, each with its start time, so that ones a crashed server left running are stopped at the next start (`agent-harness.md`, "terminal") |
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
| `chat` | `null` | `{ provider, model, effort? }` of the working agent; `null` detects it from the keys. `effort` is its thinking level (`agent-harness.md`, "Thinking levels"); `null` or absent is Socrates' default for the model |
| `router` | `null` | `{ provider, model }` of the Goal Router; `null` uses the chat provider's router default |
| `compactor` | `null` | `{ provider, model }` of the model that writes history checkpoints when a long turn is compacted (`agent-harness.md`, "Context and compaction"); `null` uses the chat model. Changing it rebuilds Socrates, like the chat and router models; `/api/status` reports it as `models.compactor` (null when it is the chat model) |
| `titler` | `null` | `{ provider, model }` of the model that names standard-mode chats from their first question and answer; `null` uses `qwen/qwen3-30b-a3b-instruct-2507` on OpenRouter when there is an OpenRouter key, else the router model. Reported as `models.titler` |
| `embeddings` | Ollama, `embeddinggemma` | `{ provider, model, url }` as in `agent-harness.md`, "Embeddings and hybrid retrieval" |
| `timeZone` | `null` | an IANA time zone; `null` follows the machine |
| `workingFolder` | `null` | the workspace new work is bound to; choosing it adds its folder to `access.folders` |
| `access` | my folders, none yet; ask first | `{ scope, folders, approvals }`: where Socrates may work and when it asks (see "Access") |
| `prices` | none | what a model costs, by client id such as `deepseek:deepseek-flash`: `{ input, cachedInput, cacheWrite, output }` in US dollars per million tokens, over the list prices Socrates looks up (`observability.md`, "Cost"); applies to the next call without a rebuild |
| `profile` | no name, not onboarded | `{ name, onboarded }`: the user's name (up to 80 characters, or null) and whether they finished onboarding (`web.md`, "Welcome and onboarding"); also in `/api/status`; the name reaches the working agent as `<USER>` from the next message |

A change sends only the fields that change; the others keep their values, inside `access` and `profile` too. Three kinds of change apply at once, even while Socrates works, and only a rebuild in progress refuses them: `access`, `profile` and `prices`, and a `chat` that names the chat model already running (a new thinking level, or the detected model now chosen). The level applies to the next model request; one the model does not accept is refused with a message listing its levels. Every other change, including another chat model, rebuilds Socrates and is refused with `busy` while it works.

**Keys** are not settings. They live in the data folder's `.env`, which holds only known key names (each provider's keys and `SOCRATES_EMBEDDINGS_API_KEY`) and is written atomically with mode `600`, preserving literal backslashes. Keys there take precedence over the process environment. The API never returns a key, only its effective presence, including inherited keys. Deleting a stored key restores any inherited value of the same name. Provider diagnostics and setup messages redact secrets. Embedding URLs must be HTTP or HTTPS base URLs without embedded credentials, query parameters or fragments.

**Working folder.** A goal is bound to a workspace permanently when its work starts (`Goal-router.md`, "Workspace resolution"). The server binds a new goal to the workspace chosen as the working folder; without one, the goal works without files and the agent asks where the work belongs. A workspace is added from a folder's full path: an existing directory, by its real path, never the whole disk, the home folder itself, classic Socrates data, or a folder inside or containing this server's data. Selection and new-goal binding revalidate the stored path; a missing folder, file, or changed alias is unavailable. Adding the same folder again returns its workspace; a second folder with the same name gets a numbered name.

## Access

The `access` setting is the harness's access policy (`agent-harness.md`, "Access"), read before every tool call:

| Field | Values | Meaning |
|---|---|---|
| `scope` | `folders` (default), `full` | `folders`: file and command tools work freely only in `folders`, and any other path asks first; `full`: anywhere on the Mac |
| `folders` | real folder paths, at most `50` | validated like a working folder (an existing directory, never the disk, the home folder, or Socrates' data, Socrates 0.1's included), stored by real path without duplicates; a missing folder or changed alias matches nothing. The limit also applies after automatically adding a working folder |
| `approvals` | `ask` (default), `auto` | `ask`: every edit, patch, command and changing MCP call waits for the user's approval; reading never asks. `auto`: none of them asks |

Direct file access, searches and command working directories exclude this server's data folder and `~/.socrates`, including their real targets when symlinked. The harness's existing read-only access to a valid activated Skill's contained resources remains available. Automatic project context and workspace embeddings respect the configured file scope without silently obtaining an outside-folder grant. With no live page connected, every approval is refused. Commands are not sandboxed: the scope decides where a command starts, not everything it can reach, so a command in `auto` mode can still read or change other files.

A folder added to `access.folders` (or taken away) counts from the very next tool call, and so from the next message: the policy is read at every call, and a message's `<ACCESS>` block is built when it starts. Access-only updates are broadcast as `state.access` to every subscribed page and returned in `/api/status`; they do not rebuild Socrates. Existing terminals recheck folder access before restart or input. Action approvals carry the complete submitted input; previews larger than `20,000` characters are refused, rather than silently shortened.

## Security

The server can run shell commands on the user's machine, so:

- it listens on `127.0.0.1` only;
- each launch makes a random 256-bit secret. The printed link `/auth?token=…` exchanges it for an `HttpOnly`, `SameSite=Strict` session cookie and redirects, so the secret leaves the address bar; scripts may send it as `Authorization: Bearer …`;
- every request's `Host` must be this server's own address (`127.0.0.1` or `localhost` with its port), so a site cannot reach it through a rebound domain name;
- a request carrying a browser `Origin` must come from this server, so another site open in the browser cannot drive the agent;
- requests marked cross-site by the browser are refused, even without an `Origin`;
- everything except `/api/health` and `/auth` requires the session, the web app's page and files included. A browser opening a page without it gets a short page saying how to open Socrates instead of JSON.

Responses cannot be cached, the launch link cannot become a referrer, and the page cannot be framed. Cookies are scoped to a host, not a port; the Origin and Host checks remain necessary when other local apps use that host.

## HTTP API

API responses are JSON. A failure, including an unknown route, is `{ "error": { "code", "message" } }` with a message meant for the user: `invalid_request` (400), `unauthorized` (401), `forbidden_host` or `forbidden_origin` (403), `not_found` (404), `busy` (409, a change while Socrates works or rebuilds), or `internal` (500, details only in the log). Repeated query parameters and malformed JSON are rejected without echoing a key-bearing request body. `/auth` redirects. `/` and the files beside it are the built web app from `apps/web/dist` (`web.md`); without a build, `/` says to run `pnpm socrates`.

| Route | Returns |
|---|---|
| `GET /api/health` | `{ ok: true }`, without a session |
| `GET /api/status` | readiness and setup needed, the models in use and why (the chat model with whether it can see images and, when it has them, its thinking levels: `effort: { levels, default, current }`), embedding state and index size, time zone, whether main is busy, the lanes, the working folder, and how many turns startup interrupted |
| `GET`, `PUT /api/settings` | the settings; `PUT` takes any subset and returns the result |
| `GET /api/keys` | each known key name with whether it is set |
| `GET /api/thinking?seq=…` | `{ seq, text }`: a step's complete thinking, by the sequence number of its `step` activity (which shows the first `20,000` characters); `not_found` when that event has none |
| `GET /api/providers` | each model provider with its default chat and router models and the keys it reads, for the settings screen |
| `GET /api/models?provider=…` | `{ models: [{ id, name? }] }`: the provider's chat models from its own list (only models that can call tools; OpenAI's and Gemini's speech, image and embedding models left out), kept for ten minutes. A provider without a key, or one that cannot be reached, is `invalid_request` with a message that never carries a key |
| `PUT`, `DELETE /api/keys/:name` | set (`{ value }`) or remove a key |
| `GET /api/goals` | every goal, most recently updated first, with its objective, status, note and workspace, and `chats: true` on the goal standard mode shows as its plain chats; each task includes its title, status, objective, completion criteria, continuation note, its number of chats (more than one after a rollover) and update time |
| `PATCH /api/goals/<goal>` and `PATCH /api/goals/<goal>/tasks/<task> { title }` | rename a goal or a chat (task) by number; the name is trimmed and 1–120 characters. A task's name chosen this way is recorded (`task_renamed`) and is never replaced by the namer or anything else |
| `POST /api/goals/<goal>/archive` and `…/restore`, `POST /api/goals/<goal>/tasks/<task>/archive` and `…/restore` | hide a goal or a chat everywhere but the archive, or bring it back. Refused with `busy` while Socrates is working in it, and the Chats list itself cannot be archived. Nothing is erased: the history stays in the log, and an archived chat is no longer found by the router, `ledger_query`, `context_retrieve`, semantic search, the recent-activity notepad, or "the current chat" of flow mode |
| `POST /api/goals/<goal>/status` and `POST /api/goals/<goal>/tasks/<task>/status { status }` | set a goal's or task's status (`open`, `completed`, `superseded`) as the user's choice (`agent-harness.md`, "Task status"); a goal's tasks keep theirs. `GET /api/goals` lists each task's `closed`: `{ by: "user" \| "socrates", reason, at }` for a task that is not open (Socrates' reason from the turn that closed it), else null |
| `GET /api/archived` | the archived goals (with their chat counts) and the archived chats whose goal is not archived, newest first |
| `POST /api/goals { title }` | standard mode's **New goal**: a goal the user names (1–120 characters), with no task until its first chat; returns it as `GET /api/goals` lists it |
| `GET /api/history` | one conversation's messages (see "History") |
| `GET /api/lanes` | open lanes with whether each is running or waiting for approval |
| `POST /api/attachments?name=…` | store one image for a message (the body is its bytes, with its image content type); answers its id, name, format and size |
| `GET /api/attachments/:id` | one stored image, for the page to show |
| `GET /api/evidence?task=gN/tN&handle=eN` | the complete retained tool recording, bounded to 200,000 characters, with truncation and output-loss flags |
| `GET`, `POST /api/workspaces` | the workspaces; `POST { path }` adds one |
| `GET /api/observe/…` | the model-call log joined with the ledger, for the inspect console: `summary`, `series`, `recent`, `costly`, `questions`, `questions/:id`, `questions/:id/trace`, `calls/:id`, `prices`; and a read-only look into the ledger and call databases: `db`, `db/:db/:table`, `db/:db/:table/:rowid` (`observability.md`). `unavailable` (503) when the call log could not be opened |
| `GET /api/folders?path=` | a folder's visible subfolders (default: the home folder), for choosing a workspace |

## History

`GET /api/history?conversation=main|<lane id>&before=<cursor>` returns a conversation's messages in send order, newest first, with a budget of `30` turns per page; a message with no bound turn counts as one. `next` is the `before` value of the following page, or `null` when no older message exists. The cursor is a stable message-event sequence; callers pass the returned value, never a project-turn number. A message's compound parts always stay on one page, even when they interleave with other messages.

Each item holds the exact message, the images attached to it (without where they are stored), and its event sequence number (a page resumes the live connection from just before an unfinished message), `unrouted` when no part has been bound yet, the router's question when it asked one instead, and one entry per part: its project turn, status, goal and task (number and title), the lane it ran in, its answer, why it was interrupted, and its tool calls as one line each with their evidence handle and status. A message saved before routing, or queued in a lane, remains visible after restart. The main conversation lists the messages sent there, including parts handed to a lane (marked `handedOff`); a lane lists messages sent there and parts handed to it.

The response also carries its snapshot `seq`; each item carries `throughSeq`, ordered `activities` (routing, narration, tool starts/results, warnings and approval decisions), and each part its `turnId`. These let a page recover an unfinished turn from history without replaying beyond the event window or losing its current draft. Snapshot activities use the same public output bounds as live activities.

## Attachments

The composer stores each image the user attaches before the message is sent (`POST /api/attachments`): a PNG, JPEG, GIF or WebP image up to `5` MB, checked by its header, saved readable only by the user as `attachments/<hash>.<ext>`, so the same image is stored once. The message then names its images by id and the user's file name (only the name's last part, without control characters). The saved message keeps each image's id, name, stored path, format and pixel size; the working agent is shown them, or told their names when its model cannot see, and every later turn keeps their paths (`agent-harness.md`, "Images"). Pages never learn the stored path; they show an image from `GET /api/attachments/:id`. The router is told a message has images, by name, and so is its recent history. A message may be only images: its text is saved exactly as sent, even when empty (`agent-harness.md`, "Images").

## Live connection

`GET /api/live` upgrades to a WebSocket, under the same Host, Origin and session rules as every request; a refused upgrade is answered and its connection closed. It carries JSON messages. All live state is held by the server, so a reload or a second tab sees exactly the same thing.

A page loads the status (which carries `seq`, the event it reflects) and the history, then sends `hello` with `after: seq`. Subscription begins with `hello`, so an event saved between upgrading and catching up arrives once. The server answers with the current state and every activity after that event; a page more than `5,000` events behind, or with a cursor ahead of this ledger, gets `reset` and reloads its history instead. A command sent without `hello` subscribes to fresh updates without replay.

Changes to settings or keys also broadcast state to every subscribed page. `ready` is false during a rebuild; sends receive `busy`, and the main queue resumes when the new runtime is ready. Queue entries and pending approvals survive page disconnections but are held in memory for this server launch. A restart clears the main queue; messages already accepted by the harness remain in history and follow normal interruption recovery.

**From a page:**

| Command | Effect |
|---|---|
| `hello { after? }` | the state, then the activities after `after` |
| `send { id, text, to, anchorDecisions?, attachments? }` | `to` is `main`, `new_lane`, or an open lane's id. `attachments` names stored images (`{ id, name }`, at most `10`); one that is not stored is refused with `attachment_missing`. A message needs words or at least one image; one with neither is refused with `empty_message`, and its text is otherwise kept exactly as sent. `main` is refused with `main_busy` while main works: the composer queues instead. A fifth running lane is refused with `lane_limit`. `anchorDecisions` are the user's explicit anchor selections (`agent-harness.md`, "Final result"). `chat { goal, task }` is standard mode's choice of where the message goes, with `to: "main"`: `goal` is a goal number, or `null` for the Chats goal (made on first use); `task` is a chat (task) number of it, or `null` for a new chat. Such a message is never routed: it is bound to that task, or to a new task named for now by the message's first six words (its objective is the message), and its chat never rolls over however often it is compacted. A missing goal or chat is refused with `not_found`. `keep { goal, task }` is flow mode's "Keep my next message in this task": the message is bound to that task without routing (`route: "pinned"`), reopening it as the user's choice if it is closed, and rolls over as usual; a task that is gone is refused with `not_found`, and `keep` with `chat`, or to a lane, with `bad_request`. When a new chat's first message completes, the titler names it in the background (see "Chat names") |
| `queue { id, text, attachments?, chat?, keep? }` | wait for the main conversation, with its images and its chosen chat or kept task; queued messages run in order as soon as main is free (at most `20`) |
| `queue_edit { id, text }`, `queue_remove { id }`, `queue_to_lane { id }` | change, drop, or send a queued message in a new lane instead; an edit may clear the text only when the message has images |
| `cancel { conversation }` | stop what runs in `main` or a lane, including a message handed to that lane |
| `approve { approval, granted }` | answer a pending approval |
| `close_lane { lane }` | close an idle lane |

`id` is the page's own name for a message (letters, digits, `_` and `-`, at most 100), echoed in every reply about it. Use unique IDs across tabs, such as UUIDs. Accepted IDs, including queued, removed and completed messages, remain reserved until the server restarts; resending one receives `duplicate` and never starts a second run. Text is at most `100,000` characters, preserved exactly; empty or whitespace-only messages are refused. Unknown and closed lanes are refused before acceptance.

**From the server:**

| Message | Meaning |
|---|---|
| `state` | `seq`, readiness and setup needed, access and settings (without key values), whether main is busy, the lanes, the main queue, and pending approvals; sent on every change |
| `accepted { id, conversation }` | the message started; for `new_lane`, `conversation` is the new lane's id |
| `activity` | one saved event (see "Live activity") |
| `draft { conversation, turnId, call, kind, text, handle? }` | the reply a turn is writing now, its thinking, or what a running tool call prints (see "Live drafts") |
| `approval` | a new pending approval: its id, conversation and lane, task, kind (`action` or `outside_folder` under an access policy), tool, the one line the user approves, and a `preview` of what will change (an edit's texts, a patch, typed input) or null |
| `handed_off { id, conversation, lane, mainReleased }` | a part went to the lane busy with its task. A single-part message frees main; a compound message keeps main until all parts finish, and its aggregate result stays in main |
| `status { id, conversation, text }` | the plan of a split message, or a quiet status line during long work |
| `result { id, conversation, result }` | the message is done: its text, lane, per-part outcome, notices, and anchor changes |
| `error { id?, code, message }` | a refusal or failure, with a message meant for the user |
| `reset { seq }` | too far behind; reload the history |

## Terminal panel

The page's terminal panel (`web.md`, "Terminal panel") travels on the live connection. The server lists the agent's terminal sessions, in every workspace, as `terminals { terminals }`: after `hello`, and whenever the list changes (it is looked at twice a second, since a prompt waiting for input is noticed by time). A session is listed once it runs in the background or for two seconds, and after it ends; a quick foreground command never is. Each entry has its id, name, command, folder, task title, status and how it ended, whether it is a terminal (`pty`), readiness, `inputRequired`, the local ports it listens on (looked up every five seconds), and a terminal's size. Session ids (`term-<n>`) are numbered across workspaces for the server's lifetime.

| Command | Effect |
|---|---|
| `terminal_open { session }` | answered with `terminal_replay { session, data, cols, rows }`, the bytes that redraw what it shows now (a terminal's screen and up to `1,000` lines above it; the last `200,000` characters of a pipe's output, with `\r\n` line ends), then `terminal_output { session, data }` as it prints, gathered every `16` ms, with nothing lost or repeated between them. A session that is gone is ignored |
| `terminal_shut { session }` | stop sending it to this page |
| `terminal_input { session, data }` | the user's keys (at most `64` KiB); refused with `not_a_terminal` over pipes and `terminal_exited` once it ended. It counts as an answer to a prompt, and the agent's `write` waits (`agent-harness.md`, "terminal") |
| `terminal_resize { session, cols, rows }` | the panel's size for a running terminal (`20`–`500` × `5`–`200`) |
| `terminal_stop { session }` | stop the process tree, as `terminal_control terminate` |
| `terminal_restart { session }` | the same launch again, recorded as the first was; the stopped session leaves the list, and the page is answered with `terminal_restarted { session, next }` |
| `terminal_dismiss { session }` | remove an ended session from the list; one still running is refused with `terminal_running` |

A command for a session that no longer exists is refused with `not_found`. Sessions belong to the agent's tool runner, so a rebuild of Socrates (a settings change) stops them, as before.

## Chat names

A chat made in standard mode is a task named by the first six words of its first message. When that message completes, the titler (`settings.titler`) is asked once for a two-to-six-word name as a recorded call (`role: "other"`, `observability.md`). It gets the first message and the start of the answer (`1,500` and `600` characters) and is told to name the topic in its own words: the answer is context for a vague message, never a source of words, and the opening words of either are not a name. A name that is only the answer's first words (two or more) or the message's first four or more is asked for again once, with a note saying so; if the second also copies, or the model says nothing, the chat keeps its first words. The reply is cut to its first line and at most eight words, and the task is revised to it. The default titler is `qwen/qwen3-30b-a3b-instruct-2507`, an instruct model with no thinking mode at all (a thinking model is the wrong tool for a name: `xiaomi/mimo-v2.6-flash`, the first default, spent about 190 tokens thinking per name). An OpenRouter titler is still asked not to think (`effort: "off"`), so a thinking model chosen in settings does not either; the call allows `1,500` output tokens for a titler that thinks anyway. The chat also keeps its first words when the titler cannot start or fails, or when the task was renamed meanwhile. Only new chats are named; chats routed in flow mode keep the router's titles.

## Live drafts

A turn has a draft for its reply (`narration` or `answer`), one for the model's thinking (`kind: "thinking"`, the readable reasoning or summary so far), and one for each tool call that is printing while it runs (`kind: "output"`, with the call's evidence `handle`: the newest `4,000` characters of what a command has printed that the agent has not yet read, sent while `terminal` or a `terminal_control wait` waits on it; `agent-harness.md`, "terminal"). Each is kept, combined and replayed on its own, as below; a saved step that only thought replaces the thinking draft and leaves the reply's, and a call's `tool_finished` replaces its output draft.

While a turn's model writes its reply, the pages see it as it arrives. A `draft` carries the turn and its conversation, the model request it belongs to (`call`, counted from 1 within the turn; a retried or repaired request is a new one), and the readable text so far: `kind: "narration"` is the line before tool calls, `kind: "answer"` is the final message's `full_answer`, decoded as far as it has arrived (the rest of the final JSON object is never sent). Each draft holds everything readable so far, not only the newest piece, so a missed one costs nothing. They are combined to at most one per turn every `50` ms. A thinking draft longer than `4,000` characters carries only its last `4,000` as `text`, with its full `length`, since the page shows only the newest lines while it thinks; the saved step has all of it.

Drafts are temporary and are never saved: the event log, history and replay contain only what is saved, and the saved `step`, `answer` or `question` activity (or `finished`, when the turn ends without one) replaces the turn's draft, so no draft follows it. A page that connects while a reply is arriving receives the current drafts after its state and replay, and a reply that was saved before the next interval is never sent as a draft at all.

The agent suppresses callbacks from cancelled, failed or finished model requests. The hub accepts drafts only for an active run and an in-progress turn. The page retains the request watermark after saving a draft and ignores late callbacks, older requests and shorter copies. Stopping a turn while its answer is streaming keeps the answer as far as it was written, on the turn's interruption record (`agent-harness.md`, "Safety and long-running work"); it is never saved as a response. The `finished` activity of that turn carries it as `partial`, and its history part shows it as the part's `answer` with `interrupted: "cancelled"`.

## Live activity

Every event is shown to the pages once it is saved (after its transaction commits), as one compact activity with the event's `seq`, time, and conversation (`main` or a lane id; a turn's activities belong to the conversation it runs in now):

`message` (the exact text, and the images attached to it, without where they are stored), `routed` (goal, task, lane), `question` (the router's clarification), `step` (the agent's narration before tool calls, or `""`, and the model's readable `thinking` for that request, or null, shown up to `20,000` characters with `thinkingTruncated`; `GET /api/thinking` returns all of it), `tool_started` (the call with its task and evidence handle: `line`, its one-line form, and `call`, the call in plain words), `tool_finished` (status and `result`, what it returned in a form to read), `answer`, `finished` (completed or interrupted, and why), `handed_off`, `lane` (opened or closed), `approval_decided`, `warning`, and `ledger` (goals or tasks changed: reload them).

**Calls and results in plain words** (`apps/server/src/calls.ts`). The model-facing records are untouched; this is only how the pages read them. `call` is `{ kind, verb, active, target, detail }`: its kind (`read`, `search`, `edit`, `terminal`, `memory`, `capability`, `other`), the verb once done and while running ("Ran"/"Running", "Started" for a background command, "Typed", "Pressed", "Waited for", "Looked back for", "Used" for MCP and unknown tools), the file, pattern, command (its first line) or terminal it acts on, and a few words more ("in src", "in the background as web", "and pressed Enter", "to print \"ready\""; an absolute folder by its name). Keys pressed in a row are counted ("Down ×3, Enter"). `result` is `{ summary, preview, truncated, diff, verb, ms }`: a few words ("exit 1", "+5 −2", "12 matches in 3 files", "2 of 80 lines", "waiting for input", "failed"); a preview of up to `2,000` characters (a command's output from its end, where the outcome is; matches as `path:line: text`; file paths; a failure's message and correction); an edit's or patch's unified diff; "Created" when an edit made the file; and how long the call took.

The `handed_off` activity carries the destination `laneId` and exact goal/task as well as the lane number. The page creates that turn's lane exchange immediately, so its first draft is placed correctly before a tool or saved answer arrives.

`GET /api/evidence?task=gN/tN&handle=eN` returns one tool call's complete retained recording, up to `200,000` characters. Terminal output uses its full recording, MCP output uses its recorded content, other results use their structured JSON, and failed calls include their public error and recorded failure detail. Internal diagnostics are excluded. `truncated` says the route shortened the recording; `outputLost` says a terminal's retention limit already discarded some output. Interrupted calls without a result return `content: null`. Selectors must be positive safe integers.

After-commit listeners preserve sequence order even when a listener records another event. Activities and state never announce rolled-back events.

## Approvals

Every approval belongs to the message that asked (`agent-harness.md`, "Lanes"). It is shown to every subscribed page in the panel of the conversation that asked, and waits for an answer. Stopping that run, or the server, refuses it, and so does a run that ends while it waits. Settled approvals remove their cancellation listener; late answers receive `not_found`. Independent turns execute their tools independently, so one turn's approval or long command cannot block a different lane.

Cancelling main also cancels its compound message while a part waits in a lane. Cancelling that lane cancels the handed-off part and the remaining compound message; it cannot cancel later main work after that part has finished.

## Stopping

Ctrl-C (or `SIGTERM`) closes the live hub before draining the listener, cancels every running message and waits until each is recorded as interrupted, refuses pending approvals, disconnects every page, then closes terminals, MCP servers, the index and ledger. Repeated close calls share the same drain. A page that never answers its WebSocket close frame is disconnected after one second.
