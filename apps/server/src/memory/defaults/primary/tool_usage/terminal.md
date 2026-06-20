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

Use Terminal/bash for commands, diagnostics, tests, builds, git inspection, local servers, and long-running process supervision.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- You need command output, test results, build results, process status, or repo inspection.
- A local server or watcher must run while other verification continues.
- Shell tools are the safest way to inspect file lists, git state, ports, or generated artifacts.
- Do not use Terminal to mutate Socrates-owned docs/memory paths when a dedicated tool exists.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- Always set the correct `cwd` for repo work.
- Commands should be concrete and non-interactive unless an ongoing terminal session is intended.
- Long-running commands may need a session name, polling, or explicit shutdown.
- Protected-path preflight rejects obvious mentions of Socrates-owned docs/memory/tool paths before execution; this is not a process sandbox.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Use targeted commands and avoid noisy chained output.
2. Check command exit status and the relevant output before claiming success.
3. Poll long-running sessions until ready, failed, or no longer needed.
4. Stop servers or watchers that are part of the task before final handoff unless the user needs them running.
5. For file creation, verify parent paths and current repo state first.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If a command exits nonzero, read the error and choose the next diagnostic command.
- If a process awaits input, either provide required input or terminate it before final answer.
- If a timeout occurs, poll output before deciding whether the process is hung.
- If protected-path preflight rejects a command, route through the dedicated Socrates docs/memory tool.
<!-- /socrates:section -->
