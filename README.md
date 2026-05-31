<p align="center">
  <img src="./apps/web/public/brand/socrates-logo.png" width="132" alt="Socrates logo" />
</p>

<h1 align="center">Socrates</h1>

<p align="center">
  <strong>Your local-first AI co-pilot for real project work.</strong>
</p>

<p align="center">
  Local data. Real tools. Traceable results.
</p>

---

Socrates is a local-first coding and investigation workspace that keeps long project work coherent across turns. You can chat, run local tools, inspect evidence, and continue a large session without losing context.

## What Socrates Can Do

- Start work in the browser with one command.
- Maintain projects, conversations, and persistent session history.
- Run shell, search, patch, file, git, and workspace tools safely.
- Call AI models for coding, analysis, and planning in a provider-aware stack.
- Stream live tool use, output, errors, and assistant responses.
- Compress context for long sessions while preserving key details.
- Preserve context evidence with quote-friendly search and turn-aware trace retrieval.
- Keep a local SQLite trail of events, tools, messages, and run metadata.
- Download and run signed-free npm runtime bundles from GitHub Releases.

## Current Project State

- Release-ready milestone: **v0.1.3**.
- Distribution: `@socrates-ai/cli` ready to launch via `npx`.
- Runtime availability for macOS (arm64/x64) and Windows x64.
- Trace retrieval upgraded for broader match windows and exact quote context.
- Duplicate tool-call handling added to avoid repeated identical retrieval passes in one turn.
- Context compression path active for large conversations.

## Quick Start

Install and run (no setup):

```bash
npx @socrates-ai/cli
```

Or install globally:

```bash
npm install -g @socrates-ai/cli
socrates
```

## Local Development

```bash
pnpm install
pnpm desktop:dev
```

Useful build targets:

```bash
pnpm desktop:runtime    # build runtime payload
pnpm runtime:archive    # generate runtime zip
pnpm desktop:bundle     # local bundling artifacts
pnpm desktop:release:local
pnpm desktop:bundle:mac
pnpm desktop:bundle:windows
```

## Runtime Location

App data defaults to:

```text
~/.Socrates/socrates.sqlite
```

Use `SOCRATES_HOME` to point the workspace to a custom root or `SOCRATES_DB_PATH` for a specific SQLite file.

## Stack at a Glance

```text
apps/
  web/       Next.js interface, conversations, project views, settings
  server/    Fastify APIs, WebSockets, tool coordination, persistence
  desktop/   Tauri host shell and runtime packaging

packages/
  core/      agent orchestration and context logic
  workspace/ local operations and tool adapters
  providers/ model integrations and token handling
  contracts/ schemas for events and tool contracts
  shared/    utility types and helpers
```

## Notes

- Node.js 20+ is required.
- Runtime downloads and app data are kept local.
- Provider credentials stay outside message/event payloads.
