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

`skills` lists and describes reusable Socrates skill instructions.

Skills are procedural guidance for repeatable workflows; they are not evidence for facts about the current repo or prior conversation.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- A reusable workflow, specialized procedure, or domain-specific instruction may apply.
- The user names a skill or asks for a kind of work covered by an installed skill.
- You need to inspect project, global, or builtin skill guidance before acting.
- Do not use skills as proof of current code state; inspect files or traces for evidence.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "list"` lists visible skills with exact ids, names, scopes, and descriptions.
- `operation: "describe"` reads one skill by exact `id` or `name` and optional `scope`.
- `n` controls list size; it defaults low and is capped by the runtime.
- `scope` may be `builtin`, `global`, or `project` when supported by the runtime.
- Some skills reference relative files; resolve them relative to the skill file first.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. List when the relevant skill is unknown.
2. Describe the selected skill before applying it.
3. Follow the skill's routing instructions and only open referenced files needed for the task.
4. Combine skill guidance with current repo evidence and higher-priority user/developer instructions.
5. Mention if an expected skill is missing and continue with the best fallback.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If no skill matches, continue from repo evidence and note the missing reusable guidance if relevant.
- If multiple skills match, describe the most specific one first.
- If a referenced skill file is missing, state the issue and use the next-best local evidence.
- If a skill conflicts with explicit user/developer instructions, follow the higher-priority instruction.
<!-- /socrates:section -->
