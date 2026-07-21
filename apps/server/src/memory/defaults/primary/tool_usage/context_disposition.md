---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# context_disposition Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`context_disposition` keeps substantial current-turn tool outputs from occupying later model requests when their exact contents are no longer needed. It changes only the model-facing copy; immutable tool evidence remains available for audit.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- After inspecting a long read, search, Terminal, MCP, URL, or retrieval result that the runtime exposes as a result handle.
- Use it only when the same response also calls at least one functional tool.
- Prefer `distill` or `release` for large outputs. Keep exact content only when the next step genuinely requires exact wording or bytes.
- Do not call it before a final answer; the turn is ending and no later provider request needs pruning.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `decisions` contains one decision per listed `result_N` handle, up to 8.
- `action: "distill"` requires a concise faithful `summary` of only what later steps need.
- `action: "release"` removes the model-facing copy from later calls.
- `action: "keep_exact"` preserves exact output; `action: "unresolved"` defers briefly when the next result is needed to judge relevance.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Bound large reads at source whenever possible.
2. Inspect the returned evidence once.
3. If another functional tool is needed, call it in parallel with one `context_disposition` call covering the listed handles.
4. Distill to paths, findings, citations, constraints, or decisions; release output that has served its purpose.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- Never call this control tool alone; that creates an unnecessary model round trip.
- If the runtime rejects an omitted classification, retry the functional call once with the required parallel disposition.
- If exact evidence becomes necessary after release, retrieve or read it again from the authoritative source rather than inventing it.
<!-- /socrates:section -->
