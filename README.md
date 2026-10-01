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
| `@socrates/providers` | Anthropic and OpenAI-compatible model adapters, a scripted test model, token calibration |
| `@socrates/router` | The Goal Router: input assembly, candidate retrieval, validation, repair, escalation, fallback, binding |

## Development

Requires Node 22.13 or later (for `node:sqlite`) and pnpm.

```sh
pnpm install
pnpm typecheck
pnpm test
```

`pnpm eval:router` sends the routing fixtures (Q1–Q12, T1–T10 from `Goal-router.md`) to a live model and grades the decisions. It runs only when credentials are set:

```sh
ANTHROPIC_API_KEY=... pnpm eval:router                     # router claude-haiku-4-5, escalation claude-opus-5-5
SOCRATES_ROUTER_MODEL=claude-opus-5-5 pnpm eval:router      # route with the main model
SOCRATES_PROVIDER=deepseek DEEPSEEK_API_KEY=... pnpm eval:router
```
