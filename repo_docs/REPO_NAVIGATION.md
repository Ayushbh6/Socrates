# Repo Navigation

## Top-Level Map

```text
apps/web        Next.js frontend
apps/server     Fastify API, WebSocket runtime, SQLite stores, memory/docs orchestration
apps/desktop    Tauri shell and runtime packaging glue
packages/core   Agent orchestration, prompt, model-visible tool registry
packages/contracts Zod schemas and shared TypeScript contracts
packages/workspace Local file/search/edit/patch/bash/resource tools
packages/providers Model provider abstraction and AI SDK adapters
packages/mcp     MCP registry/runtime helpers
packages/shared  Generic IDs/errors/time utilities
repo_docs/       Checked-in repo handoff docs
```

## Key Files

- `packages/contracts/src/tools.ts`: model-visible tool names and input/output schemas.
- `packages/core/src/tools/registry.ts`: base tool registry order and descriptors.
- `packages/core/src/prompts/socratesPrompt.ts`: lean Socrates system prompt.
- `packages/core/src/prompts/memoryPrompt.ts`: backend memory-agent system prompt and runtime prompt builder.
- `apps/server/src/services/store/memoryStore.ts`: global docs, project docs, repo docs, soul, wake context, memory worker.
- `apps/server/src/services/store/memoryAgentGlobalSettingsStore.ts`: global memory-agent settings and watermark state.
- `apps/server/src/services/store/memoryAgentRunner.ts`: specialized backend memory-agent turn runner built on `SocratesAgent`.
- `apps/server/src/services/store/memoryAgentToolExecutors.ts`: memory-only tool executor mapping.
- `apps/server/src/services/store/traceStore.ts`: project-scoped and global trace retrieval over indexed conversation/tool evidence.
- `apps/server/src/routes/httpRoutes.ts`: HTTP APIs including `/api/memory-agent`.
- `apps/server/src/services/store/memorySoulDefaults.ts`: strict global soul markdown templates.
- `apps/server/src/services/store/memorySkills.ts`: skill discovery, validation, slugging, and fallback markdown helpers.
- `apps/web/src/components/settings/MemoryAgentPanel.tsx`: settings UI for global memory-agent cadence, model, manual run, and run logs.
- `apps/server/src/ws/commandHandlers/chatMessageSend.ts`: tool executor wiring and mutation queue integration.
- `packages/workspace/src/tools/common.ts`: generic mutation guardrails for Socrates-owned docs.
- `apps/server/src/memory/defaults/`: bundled global tool-usage and workspace repo-doc templates.

## Test Navigation

- Contracts: `packages/contracts/src/contracts.test.ts`
- Core agent: `packages/core/src/test/SocratesAgent.test.ts`
- Workspace tools: `packages/workspace/src/workspace.test.ts`
- Server integration: `apps/server/src/test/server.test.ts`

## Generated Output

Package `dist/` folders are build output. Avoid editing them directly.
