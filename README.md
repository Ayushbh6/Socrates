# Socrates

> A local-first AI partner that thinks with you, plans with you, and works beside you.

Socrates is being built as a personal AI assistant with a real working memory, a clean interface, and the ability to reason through tasks with the user instead of acting like a black box.

It is not intended to be only a chat window or only a coding CLI. The goal is a full personal partner that can help with coding, research, retrieval, planning, debugging, writing, and everyday knowledge work while showing exactly what it is doing.

## Vision

Socrates should feel like a thoughtful collaborator:

- It can discuss a task before acting.
- It can plan work clearly.
- It can inspect local context.
- It organizes work into projects.
- It can attach local workspaces and resources to a project.
- It can use tools with user-approved permissions.
- It can run commands, read files, propose edits, and explain outcomes.
- It can switch models and providers per query.
- It can show thinking/reasoning separately from final responses when providers expose it.
- It can accept voice input, transcribe it, and send it as a normal user query.
- It can read assistant responses aloud.
- It can collect thumbs up/down feedback on responses.
- It can track context usage live.
- It can store a full audit trail of every meaningful step.

The long-term goal is simple:

```text
one personal assistant
  -> many providers
  -> local workspace access
  -> transparent reasoning and tool use
  -> durable memory and replayable history
```

## What Socrates Is

Socrates is a local-first agent application with:

- A polished web interface.
- First-run onboarding.
- Project-based workspaces.
- A backend agent runtime.
- WebSocket-based live communication.
- Voice input, read-aloud output, and feedback flows.
- SQLite as the source of truth.
- Provider-agnostic model access.
- Explicit tool and approval contracts.
- Full event logging for replay and debugging.

It should be able to help with:

- Coding and repo work.
- Reading and retrieving information.
- Planning projects.
- Explaining technical topics.
- Running local workflows.
- Reviewing files and outputs.
- Acting as a personal assistant across tasks.

## Architecture

The planned repo shape:

```text
apps/
  web/          # frontend UI
  server/       # HTTP and WebSocket backend

packages/
  core/         # agent runtime and orchestration
  workspace/    # local file, shell, search, git, and patch operations
  providers/    # model provider abstraction and adapters
  contracts/    # schemas, events, tool contracts, approvals, sessions
  shared/       # small generic reusable utilities

repo_docs/      # architecture and implementation rules
```

Initial app flow:

```text
/welcome
  -> /onboarding on first launch
  -> /projects for returning users

/projects
  -> /projects/new
  -> /projects/:projectId

/projects/:projectId
  -> /projects/:projectId/chats/:conversationId
```

The core dependency rule:

```text
Frontend shows state.
Backend transports events.
Core runs the agent.
Workspace performs local operations.
Providers talk to models.
Contracts define shared truth.
SQLite records everything.
```

## Provider Strategy

Socrates will start with Vercel AI SDK, but it will not be hardwired to it.

V1:

```text
Vercel AI SDK behind Socrates' own ModelProvider interface
  -> OpenAI
  -> Anthropic
  -> Google
  -> OpenRouter
```

V1.5:

```text
Add Ollama/local model support.
```

V2:

```text
Add direct provider wrappers for major providers where deeper control is needed.
```

The rest of the app should never import provider SDKs directly. Provider-specific code belongs inside `packages/providers`.

## Database Philosophy

Socrates uses SQLite as the durable source of truth.

The database should store:

- Local user profile and onboarding state.
- Projects.
- Project workspaces.
- Project resources.
- Project instructions.
- Conversations.
- Sessions.
- Turns.
- Messages.
- Runtime config per turn.
- Model calls.
- Model stream chunks.
- Tool calls.
- Approval requests and decisions.
- Voice input and transcription records.
- Read-aloud audio output records.
- Message feedback.
- Shell/file/git operations.
- Errors.
- Token usage.
- Context usage snapshots.
- Replayable events.

The goal is that any response can be reconstructed later:

```text
user query
  -> runtime settings
  -> model calls
  -> reasoning/answer stream
  -> tool calls
  -> approvals
  -> command output
  -> errors
  -> final response
  -> usage metadata
```

No black box.

## Design Principles

Socrates is being built around a few strict engineering rules:

- Keep package responsibilities clear.
- Store shared contracts in one place.
- Use typed WebSocket events.
- Avoid duplicate helpers and one-off implementations.
- Keep the server thin.
- Keep the agent core provider-agnostic.
- Route all local operations through the workspace layer.
- Require approval for dangerous actions.
- Record errors and failures, not only successful paths.
- Make runtime history replayable from the database.

## Current Status

This repository is in the architecture and foundation phase.

Initial docs:

- [`repo_docs/REPO_STRCUTURE.md`](repo_docs/REPO_STRCUTURE.md)
- [`repo_docs/REPO_RULEs.md`](repo_docs/REPO_RULEs.md)
- [`repo_docs/DB_STRUCTURE.md`](repo_docs/DB_STRUCTURE.md)
- [`repo_docs/PROVIDER_USAGE.md`](repo_docs/PROVIDER_USAGE.md)
- [`repo_docs/APP_FLOW.md`](repo_docs/APP_FLOW.md)
- [`repo_docs/FRONTEND_BACKEND_CONTRACT.md`](repo_docs/FRONTEND_BACKEND_CONTRACT.md)

## Working Agreement

Socrates should be built carefully from day one.

Every new feature should respect the package boundaries, shared contracts, database audit model, provider abstraction, and approval system. The codebase should stay easy to reason about as it grows.
