---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# mcp_registry Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`mcp_registry` discovers, validates, configures, and deletes Model Context Protocol servers available to Socrates. Global servers are inherited by projects; project servers remain workspace-local.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The user asks for an external helper, integration, browser, search provider, screenshot capability, server, or custom tool.
- You need to inspect or validate an existing MCP server before calling one of its dynamic `mcp__...` tools.
- The user explicitly asks to configure or delete a project or global MCP server.
- Do not use MCP configuration as package discovery. Never invent a command, package, URL, environment variable, or credential.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "list"` returns bounded configured and bundled server summaries. `n` is capped at 35.
- `operation: "describe"` accepts the exact canonical `id` or exact listed `name` and returns server details and bounded tool descriptors.
- `operation: "check"` validates one exact server id through a real MCP handshake and tool listing.
- `operation: "configure"` accepts `scope: "project" | "global"` plus an exact trusted stdio `server` object. IDs are lowercase and capped at 64 characters; labels at 120; arguments at 40.
- Put only non-secret values in `env`. Declare credentials by key name through `secretBindings`, using `source: "user_input"` by default. Use `source: "workspace_env"` only when the user explicitly asked to reuse that exact key from a workspace env file. Never read an env/credential file, request the value in chat, or put a plaintext value in any tool call; the backend collects or resolves it privately.
- `operation: "delete"` accepts an exact id and scope. Bundled protected servers cannot be deleted.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Use `list` when the relevant server is not already known in the current turn.
2. Use `describe` with the exact canonical id. Dynamic `mcp__...` tools are exposed only after describe, successful check, or successful configure returns them.
3. Use `check` when current server health or tool discovery must be verified.
4. Configure only from an exact user-supplied or trusted stdio command. Configuration and deletion require normal user approval.
5. When one or more `secretBindings` are present, the backend collects one masked credential at a time after approval. Multiple keys or MCP configure calls remain sequential. Do not ask for, repeat, or inspect the value yourself.
6. Configure saves the server disabled first, performs the real handshake and tool listing, and enables it only on success. A failed check must not leave a new server enabled.
7. Use returned dynamic tools for the requested work; do not simulate their results.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If no server fits, say so and continue with available first-party tools when appropriate.
- If setup details are incomplete, request the missing exact command, arguments, scope, or secret names rather than guessing.
- If a handshake fails, report the bounded error and keep the server disabled. Correct the supplied configuration before retrying.
- If a dynamic tool is unavailable, describe or check its server again; never fabricate an `mcp__...` name or result.
- Never expose secret values in prose, tool previews, logs, or `mcp.json`.
<!-- /socrates:section -->
