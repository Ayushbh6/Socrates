# Socrates Memory

This file is the repo-local memory and work log for Socrates.

## Source Of Truth

`repo_docs/` is the source of truth for any information related to the Socrates app.

Always inspect `repo_docs/` first when you need to understand:

- Product flow.
- Repo structure.
- Database design.
- Frontend/backend contracts.
- Provider strategy.
- Engineering rules.
- App route decisions.
- WebSocket event behavior.

Do not rely on stale chat context when the docs can answer the question.

## Current Architecture Decisions

- Socrates is a local-first AI partner app, not only a CLI.
- The app is project-first: no global unscoped chats in V1.
- Route flow is `/welcome -> /onboarding -> /projects -> /projects/:projectId -> /projects/:projectId/chats/:conversationId`.
- `/projects/:projectId` is the project dashboard. There is no separate dashboard id in V1.
- SQLite is planned as the source of truth for users, projects, conversations, turns, messages, events, tools, approvals, usage, and errors.
- WebSockets are the live event channel between frontend and backend.
- The frontend uses Socrates-owned hooks around Socrates contracts and WebSocket events.
- `@ai-sdk/react` is not the core chat state engine in V1.
- V1 provider access uses AI SDK provider packages behind Socrates' own provider abstraction.
- Vercel AI Gateway is not the default provider path in V1.

## First Contracts Sprint

Implemented the first TypeScript foundation:

- Added pnpm workspace scaffolding.
- Added `tsup`, `typescript`, and `vitest`.
- Added `@socrates/contracts`.
- Added Zod schemas and inferred TypeScript types.
- Added HTTP API envelope and error contracts.
- Added core entity contracts.
- Added V1 HTTP request/response contracts.
- Added WebSocket envelope, client command, and server event contracts.
- Added tests for API responses, entities, HTTP payloads, client commands, server events, and malformed payload rejection.

Verification commands passed:

```text
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

## Important V1 Runtime Rule

Only one active turn may run per conversation in V1.

Composer behavior:

```text
no active turn -> show send arrow and allow sending
active turn -> show stop button and block sending another query
stop button -> send chat.turn.cancel
turn.completed / turn.failed / turn.cancelled -> show send arrow again
```

If the frontend tries to send while a turn is already active, the backend should reject with:

```text
turn_already_active
```

V1 uses cancel/stop, not true pause/resume.

## Backend Foundation Sprint

Implemented the first backend foundation:

- Added `@socrates/shared` for reusable IDs, timestamps, and error helpers.
- Added `@socrates/server` with Fastify, `@fastify/websocket`, SQLite, Drizzle ORM, and Drizzle Kit migrations.
- Added DB schema and generated migration SQL for every table in `repo_docs/DB_STRUCTURE.md`, including post-V1 tables.
- Added DB bootstrap with `SOCRATES_DB_PATH` override.
- Development DB path defaults to `app-data/socrates.sqlite`.
- Future production/local app storage should move to `~/.socrates/socrates.sqlite`.
- Added DB-backed HTTP routes for onboarding, projects, resources, and conversations.
- Added WebSocket `/ws` skeleton that validates commands with `@socrates/contracts`, emits contract-shaped lifecycle events, enforces one active turn per conversation, supports `chat.turn.cancel`, and persists minimal feedback/error/event records.

This sprint intentionally does not implement real model providers, the agent loop, workspace tools, shell execution, real approvals, or frontend UI behavior.

## Current Repo Notes

- The tracked repo rules doc is `repo_docs/REPO_RULES.md`.
- The earlier `REPO_RULEs.md` casing mismatch was normalized with `git mv`.
- Build output under `packages/contracts/dist/` is generated and ignored.
- `node_modules/` and package-local `node_modules/` are ignored.

## FRONTEND AGENT LOGS

- Initialized Next.js workspace in `apps/web` utilizing App Router, Tailwind CSS v4, and TypeScript.
- Configured styling using `framer-motion`, `lucide-react`, and `shadcn/ui` mapping to a custom Apple-inspired warm cream/teal theme in `globals.css`.
- Implemented the `/welcome` page with a seamless cream background, gradient typography, and fade-in animations.
- Implemented the `/onboarding` page as a floating, unboxed form on the seamless cream background.
- Implemented the `/projects` page as a minimalist list with a `ProjectSearch` component and simplified `ProjectCard`s, removing the global sidebar.
- Implemented the `/projects/new` page as a clean, centered creation form.
- Implemented the `/projects/:projectId` dashboard with a 2-column layout (Left: Dashboard Composer & Conversation List; Right: Instructions & Files Panels).
- All UI elements have been properly compartmentalized into `apps/web/src/components/` according to `REPO_RULES`.
- **Note to Backend Agent:** Currently, the frontend is using mocked data hooks (e.g., `useCurrentUser` returning a mock user conforming to the `@socrates/contracts` schema). These mock contracts need to be swapped out with actual data fetches from the backend API endpoints in the future.
