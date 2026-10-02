# Socrates

A coding-agent harness built around one continuous conversation. You never create or pick chats or projects: a Goal Router decides which goal (project) and task (chat) each message belongs to, and the working agent sees only that task's context.

The design lives in [`architecture/`](architecture):

- [`agent-harness.md`](architecture/agent-harness.md): tools, the agent loop, context layout, compaction, caching.
- [`Goal-router.md`](architecture/Goal-router.md): goals, tasks, routing, the ledger, rollover.

## Packages

| Package | What it holds |
|---|---|
| `@socrates/contracts` | Zod schemas for router decisions, `ask_user`, `ledger_query`; the normalized model contract; event types |
| `@socrates/shared` | o200k token counting, injectable clock, ids |
| `@socrates/store` | SQLite event log (append-only) and ledger: goals, tasks, revisions, chats, turns, anchors, FTS index, `ledger_query` |
| `@socrates/providers` | Anthropic, DeepSeek, OpenRouter, OpenAI-compatible and Gemini Interactions model adapters, a scripted test model, token calibration |
| `@socrates/router` | The Goal Router: input assembly, candidate retrieval, validation, repair, escalation, fallback, binding |
| `@socrates/tools` | The working agent's ten permanent tools behind one tool runner: corrective errors, workspace access and approval policy, bounded results, persisted evidence (`eN`), the terminal supervisor, and the capability catalog interface |
| `@socrates/agent` | The working agent: `Socrates.handle` runs one message end to end (route, bind, agent loop per part, `FinalAnswer` validation and persistence), context assembly in the canonical layout, three-tier history with N−1 fitting, per-turn limits, cancellation, and prompt-cache breakpoints |

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
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:provider # real function call/result continuation with native metadata
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:goal     # real router and scoped worker, persistent goals and artifacts
pnpm eval:tools                                          # all ten tools, persistent restart and event replay
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:tools --live # also verify a provider-selected tool call
SOCRATES_ENV_FILE=/absolute/path/to/.env pnpm eval:agent  # real router and working agent on a disposable project
```

`eval:agent` runs the working agent through `Socrates.handle` on a disposable calculator project under `.socrates/evals/agent-*`: a multi-step fix with real edits and test runs, continuation, a restart that rebuilds history from the event log, a compound message, cancellation and recovery, a step-limit wrap-up, and event-only replay. Only the synthetic fixture reaches the provider.

`eval:goal` writes disposable Markdown deliverables and SQLite databases to a fresh run directory inside this repository's ignored `.socrates/evals/` folder. It verifies continued and resumed work, independent tasks, general conversation, dependent compound work, clarification recovery after restart, historical ledger tools, deliberate invalid-answer escalation, event-only recovery, and metadata budgets. The worker uses real LLM responses and validated, explicitly allowed artifact names. Its worker is a scoped stand-in; the real working agent is exercised by `eval:agent`.

Gemini uses the stable [Interactions API](https://ai.google.dev/api/interactions-api-v1) in stateless mode (`store: false`); native output steps, thought signatures and function call IDs are replayed intact. Compatible adapters preserve the entire native assistant message under the exact endpoint/model identity, including DeepSeek reasoning and OpenRouter signed reasoning details. Provider failures have bounded timeouts and secret-free errors.

The event log now contains the identities and links needed to reconstruct every implemented projection with `LedgerStore.restoreEvents`. Restoration requires an empty target and fails atomically on incomplete logs. Pre-fix development logs that omitted identities cannot be reconstructed from events alone; preserve their original SQLite projections. Opening an existing store does not reset its data.
