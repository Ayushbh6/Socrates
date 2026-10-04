# Socrates

A coding-agent harness built around one continuous conversation. You never create or pick chats or projects: a Goal Router decides which goal (project) and task (chat) each message belongs to, and the working agent sees only that task's context.

The design lives in [`architecture/`](architecture):

- [`agent-harness.md`](architecture/agent-harness.md): tools, the agent loop, context layout, compaction, caching.
- [`Goal-router.md`](architecture/Goal-router.md): goals, tasks, routing, the ledger, rollover.
- [`server.md`](architecture/server.md): the local app server: data folder, settings and keys, startup, security, and its API.
- [`web.md`](architecture/web.md): the web app: the welcome page, flow mode (the orb, the notes, the question sidebar, the composer), standard mode (goals, main and lane panels), approvals, tool output, settings, and how it stays in sync.

## Packages

| Package | What it holds |
|---|---|
| `@socrates/contracts` | Zod schemas for router decisions, `ask_user`, `ledger_query`; the normalized model contract; event types |
| `@socrates/shared` | o200k token counting, injectable clock, ids |
| `@socrates/store` | SQLite event log (append-only) and ledger: goals, tasks, revisions, chats, turns, anchors, FTS index, `ledger_query` |
| `@socrates/providers` | Anthropic, DeepSeek, OpenRouter, OpenAI-compatible and Gemini Interactions model adapters; embedding clients (local Ollama by default, OpenRouter, OpenAI, or any OpenAI-compatible endpoint); a scripted test model and a deterministic test embedder; token calibration |
| `@socrates/router` | The Goal Router: input assembly, candidate retrieval, validation, repair, escalation, fallback, binding |
| `@socrates/tools` | The working agent's ten permanent tools behind one tool runner: corrective errors, workspace access and approval policy, bounded results, persisted evidence (`eN`), the terminal supervisor, the capability catalog interface, the frozen Skill shelf, per-turn capability candidates, and MCP approvals |
| `@socrates/capabilities` | The installed capability sources behind the catalog interface: global Skills in `~/.socrates-v2/skills/` and global MCP servers in `~/.socrates-v2/mcp.json` (stdio and streamable HTTP through the official SDK, connected when first needed), with recorded tool-list snapshots |
| `@socrates/retrieval` | The embedding index of Socrates' memory: LanceDB storage beside the ledger, background indexing of goals, tasks, exchanges, tool calls, capabilities and workspace files (secrets and generated files excluded), meaning search with similarity floors, and the one hybrid (reciprocal rank fusion) scoring function |
| `@socrates/agent` | The working agent: `Socrates.handle` runs one message end to end (route, bind, agent loop per part, `FinalAnswer` validation and persistence) in the main conversation or a parallel lane, one run per task, recovery of turns a stopped process left running, context assembly in the canonical layout, three-tier history with N−1 fitting, per-turn limits, cancellation, and prompt-cache breakpoints, and compaction: history checkpoints, in-turn linearization, the failsafe, automatic rollover with handover capsules, and `<RETRIEVED_HISTORY>` |
| `@socrates/server` (`apps/server`) | The local app server: builds the one Socrates from `~/.socrates-v2` (settings, keys, Skills, MCP servers, embedding index), interrupts turns left running at startup, and serves the session-protected HTTP API and live WebSocket on `127.0.0.1:4200`: Send, Queue and Send in a lane, live activity, per-conversation approvals, and cancel; and where Socrates may work (my folders or full access) and when it asks (ask first or work freely) |
| `@socrates/web` (`apps/web`) | The web app the server serves: the welcome page and setup, flow mode with the orb and the task and goal notes, the question sidebar with lanes, the composer (Send, Queue, Send in a new lane, stop, approvals mode), the access menu and approval cards; standard mode with goals, the main conversation and a panel per lane; the full tool-output viewer; and settings for models, keys, memory search, time zone and access |

## Running Socrates

```sh
pnpm socrates
```

It builds the web app, starts the server, and opens Socrates in your browser. `pnpm server` starts only the server and prints the link to open, with this launch's session secret. Data lives in `~/.socrates-v2` (`SOCRATES_HOME` changes it), never in Socrates 0.1's folder. Without an API key the welcome page asks for one.

S1 is reviewed and closed in the [server-core closure report](docs/reviews/server-s1-closure.md). Run its live acceptance with `SOCRATES_ENV_FILE=.env pnpm eval:server-core`; it uses disposable data and synthetic project content. Message execution in this evaluation calls the runtime directly. S2 is closed in its [live-server report](docs/reviews/server-s2-closure.md), and A1 in the [access closure report](docs/reviews/access-a1-closure.md). `SOCRATES_ENV_FILE=.env pnpm eval:server` runs the real server process and drives it only through its API and live connection: an approval answered over the connection, the access modes (a refused edit, a folder outside the user's folders, Socrates' own data, full access working freely), access changes reaching two pages and an existing terminal, a lane beside main, a queued message, cancelling, catching up after a reconnect, recovery after the process is killed mid-turn, and a clean Ctrl-C. The web app's flow mode (W1) and standard mode with settings (W2) are built ([`web.md`](architecture/web.md)). Command process sandboxing remains deferred.

## Development

Requires Node 22.13 or later (for `node:sqlite`) and pnpm. `glob` and `grep` use ripgrep: the newer of an `rg` on `PATH` and the binary bundled through `@vscode/ripgrep`.

```sh
pnpm install
pnpm typecheck
pnpm test
```

`pnpm eval:router` runs the 22 architecture routing fixtures through a real model. It checks goal/task identity, creation, ordered compound work and dependencies; a fallback never counts as a passing live decision. Credentials are required: missing keys exit with an error.

```sh
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:router  # Gemini 3.8 Flash, stable Interactions API
SOCRATES_PROVIDER=deepseek SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:router
SOCRATES_PROVIDER=openrouter SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:router
```

Environment loading reads only known provider keys/configuration and never logs credentials. `SOCRATES_ROUTER_MODEL` overrides the routing model; `SOCRATES_MAIN_MODEL` chooses an escalation model (`none` disables it). Defaults are `gemini-3.8-flash` for Gemini, `google/gemini-3.8-flash` for OpenRouter, and `deepseek-v4-pro` for direct DeepSeek. DeepSeek's `deepseek-flash` can be selected explicitly; the Pro default was verified when Flash requests were stalling. Anthropic and OpenAI remain available with `SOCRATES_PROVIDER=anthropic|openai` and their corresponding keys.

```sh
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:provider # real function call/result continuation with native metadata, plain and streamed
SOCRATES_ENV_FILE=/absolute/path/to/.env SOCRATES_PROVIDER=gemini pnpm eval:vision # a real model reads a synthetic image, attached and from a tool
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:goal     # real router and scoped worker, persistent goals and artifacts
pnpm eval:tools                                          # all ten tools, persistent restart and event replay
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:tools --live # also verify a provider-selected tool call
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:agent  # real router and working agent on a disposable project
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:compaction # compaction and rollover with shrunken budgets
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:capabilities # installed Skills and a real stdio MCP server
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:embeddings   # meaning-based retrieval with local Ollama embeddinggemma
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:lanes        # parallel lanes beside the main conversation
```

`eval:compaction` shrinks the context budgets so a few real turns cross the compaction trigger: it checks that a history checkpoint carries an unanswered question verbatim and that the agent answers it afterwards, that rollover continues a turn in a linked chat, that a restart keeps the work, that no request reaches the ceiling, and that every projection replays from events. Ceiling checks cover calibrated worker and compactor requests, including native replay content. The [compaction-stage closure report](docs/reviews/compaction-stage-closure.md) records the six review fixes and their regression coverage.

`eval:embeddings` needs a local Ollama with `embeddinggemma` (`ollama pull embeddinggemma`), the default embedding model. A real router and agent hold a conversation across three goals while the index fills in the background; the eval checks routing to a three-week-old goal by meaning alone, `context_retrieve` finding an exchange that keyword search misses, another task's history appearing on a strong match only, a Skill suggested by meaning, `<PROJECT_CONTEXT>` choosing the anchor plan's section for "today's lesson" through the task's note, an anchor edited on disk shown as it is now, a related code file found by meaning, a planted `.env` never indexed, keyword fallback with Ollama unreachable, and a restart and full rebuild of the index. Embeddings are chosen with `SOCRATES_EMBEDDINGS_PROVIDER` (`ollama`, `openrouter`, `openai`, `custom`), `SOCRATES_EMBEDDINGS_MODEL`, and `SOCRATES_EMBEDDINGS_URL`. The index also covers the files of every workspace bound to a goal: with the default local model they never leave the machine, but with a hosted embedding provider their contents are sent to that provider, as chat context is sent to the chat model.

`eval:lanes` runs one Socrates with lanes beside the main conversation on two disposable projects under `.socrates/evals/lanes-*`: a lane adds a changelog while main runs a slow test suite, a lane's follow-up continues its task without routing, main answers a question about a lane from `<LANES>` without disturbing it, an instruction for a lane given in main is routed to the lane's task and handed to it while main answers something else, lane notices, stopping one lane leaves another to finish, and lanes survive a restart and an event-only rebuild.

`eval:capabilities` gives the agent a disposable Socrates home under `.socrates/evals/capabilities-*` with two global Skills and an `mcp.json` that starts the SDK-built tracker fixture over stdio. It checks that a per-turn candidate is activated and its MCP tool called in the same turn, that the Skill pinned on the frozen shelf is activated and followed, that a mutating MCP tool asks for approval once per goal, that an active Skill's instructions appear exactly once in later requests, that a restart with a fresh server process restores the active tool, that a server changing an active tool's schema reaches the agent as one replacement schema, and that every projection, the shelf and the tool snapshots replay from events. It also verifies global Skill resource reads, edited-Skill reactivation and deactivation during continued work. The [capabilities-stage closure report](docs/reviews/capabilities-stage-closure.md) records the six review fixes, regression coverage and compatibility behavior.

`eval:agent` runs the working agent through `Socrates.handle` on a disposable calculator project under `.socrates/evals/agent-*`: a multi-step fix with real edits and test runs, continuation, a restart that rebuilds history from the event log, a compound message, cancellation and recovery, a step-limit wrap-up, explicit anchor approval, cancellation concurrent with a final response, and event-only replay. Only the synthetic fixture reaches the provider. The [Agent-stage closure report](docs/reviews/agent-stage-closure.md) records the reviewed safeguards and their regression coverage.

`eval:goal` writes disposable Markdown deliverables and SQLite databases to a fresh run directory inside this repository's ignored `.socrates/evals/` folder. It verifies continued and resumed work, independent tasks, general conversation, dependent compound work, clarification recovery after restart, historical ledger tools, deliberate invalid-answer escalation, event-only recovery, and metadata budgets. The worker uses real LLM responses and validated, explicitly allowed artifact names. Its worker is a scoped stand-in; the real working agent is exercised by `eval:agent`.

Gemini uses the stable [Interactions API](https://ai.google.dev/api/interactions-api-v1) in stateless mode (`store: false`); native output steps, thought signatures and function call IDs are replayed intact. Compatible adapters preserve the entire native assistant message under the exact endpoint/model identity, including DeepSeek reasoning and OpenRouter signed reasoning details. Provider failures have bounded timeouts and secret-free errors.

The event log now contains the identities and links needed to reconstruct every implemented projection with `LedgerStore.restoreEvents`. Restoration requires an empty target and fails atomically on incomplete logs. Pre-fix development logs that omitted identities cannot be reconstructed from events alone; preserve their original SQLite projections. Opening an existing store does not reset its data.
