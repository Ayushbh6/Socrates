---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# terminal Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

Use Terminal/bash for commands, diagnostics, tests, builds, git inspection, local servers, long-running process supervision, and bounded one-off scripts when no exact structured tool exists.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- You need command output, test results, build results, process status, or repo inspection.
- A local server or watcher must run while other verification continues.
- Shell tools are the safest way to inspect file lists, git state, ports, or generated artifacts.
- A task needs a small temporary capability such as parsing data, converting formats, rendering/OCRing a document with available local tools, calling a local CLI, or verifying a hypothesis.
- Exact structured tools are missing or insufficient, and a short script can solve the gap without installing packages or creating durable app state.
- Do not use Terminal to mutate Socrates-owned docs/memory paths when a dedicated tool exists.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- Always set the correct `cwd` for repo work.
- For the small safe-diagnostic lane, prefer `argv` with a literal executable and arguments, for example `["git", "status", "--short"]` or `["pwd"]`. It runs without a shell, so pipes, redirects, substitutions, and shell syntax are unavailable.
- Use raw `command` for real shell work, scripts, tests, builds, servers, REPLs, and one-off programs. Outside full-access mode, raw commands require explicit approval even when they look read-only.
- Commands should be concrete and non-interactive unless an ongoing terminal session is intended.
- Use `operation: "list"` before complex Terminal work or when several named sessions may exist. It returns at most 12 compact rows; use its human names for later controls.
- Raw `run` commands that remain active past the foreground window detach automatically into a conversation Terminal. The command continues unchanged; inspect it with `status` or `output` and do not start a duplicate.
- `charLimit` is capped at 16,000 characters and Terminal list output is capped at 12,000 characters. Request only the evidence needed; full logs remain in the UI/audit store.
- Protected-path preflight rejects obvious mentions of Socrates-owned docs/memory/tool paths before execution; this is not a process sandbox.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Use targeted commands and avoid noisy chained output.
2. For one-off scripts, prefer existing local runtimes and standard libraries before installing anything.
3. Keep outputs bounded and observable. Prefer stdout or temporary files near the relevant source, then inspect the result before relying on it.
4. Check command exit status and the relevant output before claiming success.
5. After detachment, continue independent work. When every remaining step depends on background Terminals, call `wait` with their names and `wakeOn: ["completed", "failed", "input_required"]`. `wait.reason` is required, at most 7 words and 64 characters. It suspends the task without a final answer; it is event-driven and has no polling interval.
6. Stop servers or watchers that are part of the task before final handoff unless the user needs them running.
7. For file creation, verify parent paths and current repo state first.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If a command exits nonzero, read the error and choose the next diagnostic command.
- If a process awaits input, tell the user exactly what is needed. The user alone sends raw Terminal input; a `wait` task wakes on `input_required` so Socrates can hand off cleanly.
- If a timeout occurs, poll output before deciding whether the process is hung.
- If protected-path preflight rejects a command, route through the dedicated Socrates docs/memory tool.
- If a simple one-off script fails because an optional dependency is missing, try a standard-library or already-installed alternative before asking to install packages.
- Do not keep retrying broad network fetches, crawls, large downloads, or package installs without explicit user approval.
<!-- /socrates:section -->
