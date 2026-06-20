---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# repo_docs Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`repo_docs` reads, searches, and edits the active workspace's durable repo doctrine in `.socrates/repo_docs/*.md`.

Use these docs as the operating map for repo architecture, navigation, rules, and contracts.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Before meaningful implementation, architecture diagnosis, or repo-state claims.
- When durable repo behavior, contracts, workflows, navigation, or pitfalls change.
- When a user asks for handoff readiness or expects the next agent to start from current repo truth.
- Not for temporary todos or scratch notes; use `project_docs area:"notes"` for those.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `path` selects one repo doc: `CORE_IDEA.md`, `REPO_NAVIGATION.md`, `REPO_RULES.md`, or `CONTRACTS.md`.
- `operation: "read"`, `"search"`, `"read_index"`, `"read_section"`, `"patch_section"`, or `"edit"`.
- `patch_section` requires `path`, `sectionId`, exact `oldText`, and `newText`.
- `edit` replacement requires exact `oldText` and `newText`; append uses `text`.
- Outputs may include backend-owned current date/time metadata.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Read the relevant repo doc before making or changing durable repo claims.
2. Use `search` when the target doc is unclear.
3. Use `read_index` or `read_section` before precise structured edits.
4. Update repo docs when implementation changes durable contracts, command workflows, ownership maps, or known pitfalls.
5. Keep repo docs stable and doctrine-like; do not store transient terminal output or short-lived todos here.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If `path` is wrong, read or search the repo-doc index and choose one of the four known files.
- If exact replacement fails, re-read the section and retry with current text.
- If a fact is temporary or uncertain, put it in project notes instead of repo docs.
- If docs conflict with inspected code, update the doc after verifying the current implementation.
<!-- /socrates:section -->
