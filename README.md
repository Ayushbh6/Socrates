<p align="center">
  <img src="./apps/web/public/brand/socrates-logo.png" width="132" alt="Socrates logo" />
</p>

<h1 align="center">Socrates</h1>

<p align="center">
  A local-first AI workspace for coding, research, planning, and long-running project memory.
</p>

<p align="center">
  <strong>One-command local app.</strong>
  <strong>Real tools.</strong>
  <strong>Replayable history.</strong>
  <strong>User-owned data.</strong>
</p>

---

Socrates is a personal AI collaborator that runs locally and works directly with your projects. It is built for the workflows where a normal chat box breaks down: multi-turn repo work, tool use, context compression, local resources, model switching, command output, and durable memory.

The goal is not to hide the work behind a black box. Socrates shows what it is doing, keeps the project history inspectable, and stores the meaningful runtime trail locally.

## What It Does

- Organizes work into projects and conversations.
- Attaches local workspaces and project resources.
- Streams model responses, reasoning, tool calls, and context state live.
- Runs local tools for file inspection, search, shell commands, git status, and patch application.
- Uses explicit approval gates for sensitive local actions.
- Tracks model usage and model-facing context usage separately.
- Compresses long conversations so active projects can keep going.
- Stores sessions, turns, model calls, tool calls, errors, events, and feedback in SQLite.
- Runs from npm as a local browser app, with desktop packaging still available for future signed releases.

## Why It Exists

Most AI tools are either polished chat apps with no real local agency, or powerful CLIs that do not preserve enough user-facing context. Socrates aims for the middle ground:

```text
a desktop AI workspace
  -> connected to your local projects
  -> backed by durable local memory
  -> transparent about tools and context
  -> provider-agnostic by design
```

## Current Capabilities

Socrates already includes the core shape of the app:

- npm CLI launcher for a one-command local app.
- Tauri desktop shell with packaged backend and web sidecars.
- Next.js frontend for onboarding, project dashboards, chat, and settings.
- Fastify backend with HTTP and WebSocket APIs.
- Provider abstraction over OpenRouter, OpenAI, and Google through the AI SDK.
- Provider-aware context token counting with safety margins and compression thresholds.
- DeepSeek V4 Flash context compression path.
- SQLite persistence for conversations, events, model calls, tool calls, and context snapshots.
- Local provider-key persistence for npm/browser mode.
- OS keychain integration for future packaged desktop credentials.
- Unsigned GitHub Release runtime bundles for macOS and Windows.

## Sneak Peek

The next slices are focused on making the npm distribution smooth:

- first published `@socrates-ai/cli` package,
- first unsigned runtime release bundles on GitHub,
- smoother provider-key onboarding,
- richer settings for local-vs-hosted embeddings,
- tighter public docs and screenshots.

## Install

After the first npm package and GitHub runtime release are published:

```bash
npx @socrates-ai/cli
```

Or install the command globally:

```bash
npm install -g @socrates-ai/cli
socrates
```

The CLI downloads the matching unsigned runtime bundle from GitHub Releases, verifies `SHA256SUMS`, stores it under `~/.Socrates/runtimes/`, starts Socrates on `127.0.0.1`, and opens the browser.

## Local Development

Install dependencies:

```bash
pnpm install
```

Run the desktop app with local services:

```bash
pnpm desktop:dev
```

Build the packaged runtime:

```bash
pnpm desktop:runtime
```

Build an unsigned npm runtime archive:

```bash
pnpm runtime:archive
```

Build local desktop artifacts:

```bash
pnpm desktop:bundle
pnpm desktop:release:local
```

Build release installer targets:

```bash
pnpm desktop:bundle:mac
pnpm desktop:bundle:windows
```

Durable app data defaults to:

```text
~/.Socrates/socrates.sqlite
```

Use `SOCRATES_HOME` to change the app-data directory, or `SOCRATES_DB_PATH` to point at a specific SQLite file.

## Provider Keys

The npm/browser app stores provider credentials in:

```text
~/.Socrates/.env
```

Future packaged desktop builds store provider credentials in the OS keychain.

- OpenRouter is required for the default chat and compression path.
- OpenAI is required only when hosted embeddings are selected instead of local Ollama embeddings.
- Google is optional.

Secrets must not be stored in SQLite, logs, model-call JSON, events, or frontend persisted state.

## Architecture

```text
apps/
  desktop/     Tauri shell, runtime bundling, signing, updater, keychain commands
  web/         Next.js frontend
  server/      HTTP and WebSocket backend

packages/
  core/        agent orchestration and context management
  workspace/   local file, search, shell, git, and patch operations
  providers/   model providers, token counting, embeddings
  contracts/   shared schemas, events, tools, approvals
  shared/      small cross-package utilities

repo_docs/     deeper architecture notes and repo rules
```

The dependency direction is intentionally strict:

```text
frontend shows state
backend transports events
core runs the agent
workspace performs local operations
providers talk to models
contracts define shared truth
SQLite records the runtime history
```

## Release Packaging

Tagged releases such as `v0.1.0` build unsigned npm runtime bundles through GitHub Actions:

- `socrates-runtime-darwin-arm64.zip`,
- `socrates-runtime-darwin-x64.zip`,
- `socrates-runtime-win32-x64.zip`,
- `SHA256SUMS`.

The signed Tauri desktop workflow is manual and reserved for a future polished release path. It is designed to publish:

- macOS Apple Silicon DMG,
- Windows x64 NSIS setup EXE,
- Tauri updater artifacts and signatures,
- `latest.json`,
- `SHA256SUMS`,
- one-command installer scripts.

Real release builds require Apple Developer ID/notary secrets, Azure Trusted Signing secrets, and a Tauri updater signing key configured in GitHub.

## Troubleshooting

- Node.js 20 or newer is required.
- First launch downloads a runtime bundle from GitHub Releases.
- App data lives under `~/.Socrates` unless `--home` is used.
- Provider keys stay local and are not stored in SQLite.
- macOS/Windows app signing is not needed for the npm launcher path.

## Repository Docs

For implementation details and active engineering rules, see:

- [`repo_docs/REPO_RULES.md`](repo_docs/REPO_RULES.md)
- [`repo_docs/REPO_STRCUTURE.md`](repo_docs/REPO_STRCUTURE.md)
- [`repo_docs/DB_STRUCTURE.md`](repo_docs/DB_STRUCTURE.md)
- [`repo_docs/PROVIDER_USAGE.md`](repo_docs/PROVIDER_USAGE.md)
- [`repo_docs/APP_FLOW.md`](repo_docs/APP_FLOW.md)
- [`repo_docs/FRONTEND_BACKEND_CONTRACT.md`](repo_docs/FRONTEND_BACKEND_CONTRACT.md)

## Status

Socrates is under active development. The app is usable locally, and the current focus is the npm launcher plus unsigned runtime release flow.
