---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# skills Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`skills` lets the Global Memory Agent list and describe reusable workflow guidance.

Skills are readable background guidance for scheduled memory runs and are not evidence for user behavior by themselves. Use them to understand what already exists before proposing a new skill or update through `edit_files`.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- A reusable workflow or skill may help interpret a repeated pattern.
- The manifest or a `memory_notes` lead suggests a procedural skill candidate that should become a user-visible proposal.
- You need to understand an existing skill before deciding whether evidence is already represented elsewhere.
- You are about to propose updating an existing skill and need to read its current `SKILL.md` carefully.
- Do not use skills as proof of user behavior or current project state.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "list"` lists skills with exact ids, names, scopes, and descriptions.
- `operation: "describe"` reads a specific skill by exact `id` or `name` and optional `scope`.
- `n` controls list size; `charLimit` controls described skill content size.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. List skills when reusable guidance may apply.
2. Describe the most specific skill before relying on it.
3. Use `trace_retrieve` for exact evidence before any memory write.
4. If an existing skill should change, describe/read it first so the proposal reflects the current contents.
5. If a new or changed skill seems useful, decide project/global scope, use a human-facing skill slug, then call `edit_files` with `target: "skill"`, `scope`, and a concise Skill Writer request. This records a proposal; it does not write final markdown during your run.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If no skill matches, continue with trace evidence and existing memory surfaces.
- If the list is too broad, narrow by scope or describe only the strongest exact match.
- If a skill is missing or stale, propose a new skill or update only when the evidence is durable and reusable.
- If a skill proposal is rejected, do not retry unless the error points to a simple name or request correction.
<!-- /socrates:section -->
