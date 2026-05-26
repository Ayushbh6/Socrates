<p align="center">
  <img src="./apps/web/public/brand/socrates-logo.png" width="132" alt="Socrates logo" />
</p>

<h1 align="center">Socrates</h1>

<p align="center">
  A local-first AI workspace for coding, research, planning, and long-running project memory.
</p>

<p align="center">
  <strong>Desktop app.</strong>
  <strong>Real tools.</strong>
  <strong>Replayable history.</strong>
  <strong>User-owned data.</strong>
</p>

---

Socrates is a personal AI collaborator that runs as a desktop app and works directly with your local projects. It is built for the workflows where a normal chat box breaks down: multi-turn repo work, tool use, context compression, local resources, model switching, command output, and durable memory.

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
- Supports desktop packaging with OS-native app data and provider credential storage.

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

- Tauri desktop shell with packaged backend and web sidecars.
- Next.js frontend for onboarding, project dashboards, chat, and settings.
- Fastify backend with HTTP and WebSocket APIs.
- Provider abstraction over OpenRouter, OpenAI, and Google through the AI SDK.
- Provider-aware context token counting with safety margins and compression thresholds.
- DeepSeek V4 Flash context compression path.
- SQLite persistence for conversations, events, model calls, tool calls, and context snapshots.
- OS keychain integration for packaged provider credentials.
- Signed-release workflow scaffolding for macOS DMG and Windows NSIS installers.
- One-command install script entrypoints for GitHub Releases.

## Sneak Peek

The next slices are focused on turning the release pipeline into a real public distribution:

- first signed macOS Apple Silicon release,
- first signed Windows x64 installer,
- updater manifest validation from GitHub Releases,
- smoother provider-key onboarding,
- richer settings for local-vs-hosted embeddings,
- tighter public docs and screenshots.

## Install

After the first GitHub Release is published, the intended install paths are:

macOS Apple Silicon:

```bash
curl -fsSL https://github.com/Ayushbh6/Socrates/releases/latest/download/install-socrates.sh | bash
```

Windows x64:

```powershell
irm https://github.com/Ayushbh6/Socrates/releases/latest/download/install-socrates.ps1 | iex
```

The scripts fetch the latest release, download the matching installer, verify `SHA256SUMS`, and open or run the installer.

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

Packaged Socrates stores provider credentials in the OS keychain.

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

Tagged releases such as `v0.1.0` are built by GitHub Actions. The release workflow is designed to publish:

- macOS Apple Silicon DMG,
- Windows x64 NSIS setup EXE,
- Tauri updater artifacts and signatures,
- `latest.json`,
- `SHA256SUMS`,
- one-command installer scripts.

Real release builds require Apple Developer ID/notary secrets, Azure Trusted Signing secrets, and a Tauri updater signing key configured in GitHub.

## Repository Docs

For implementation details and active engineering rules, see:

- [`repo_docs/REPO_RULES.md`](repo_docs/REPO_RULES.md)
- [`repo_docs/REPO_STRCUTURE.md`](repo_docs/REPO_STRCUTURE.md)
- [`repo_docs/DB_STRUCTURE.md`](repo_docs/DB_STRUCTURE.md)
- [`repo_docs/PROVIDER_USAGE.md`](repo_docs/PROVIDER_USAGE.md)
- [`repo_docs/APP_FLOW.md`](repo_docs/APP_FLOW.md)
- [`repo_docs/FRONTEND_BACKEND_CONTRACT.md`](repo_docs/FRONTEND_BACKEND_CONTRACT.md)

## Status

Socrates is under active development. The app is usable locally, and the current focus is getting the first signed desktop release into a clean public distribution flow.
