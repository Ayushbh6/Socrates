---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# soul Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`soul` reads global Socrates identity and operating-principle documents.

Use it for durable behavior guidance, not for project-specific facts or temporary state.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The task depends on Socrates identity, global behavior rules, or stable operating principles.
- A memory-agent or system behavior question needs global guidance.
- You need to distinguish global user/project preferences from repo-local docs.
- Do not use soul docs as evidence for current code state.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `document: "identity"` reads identity guidance.
- `document: "operating_principles"` reads operating principles.
- `document: "both"` reads both when the distinction is unclear.
- `charLimit` can bound output for long documents.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Choose the narrowest document that can answer the global-behavior question.
2. Read soul guidance before changing or interpreting durable global behavior.
3. Use project docs or repo docs for workspace-specific facts.
4. Treat runtime/developer/user instructions as higher priority than soul docs.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If the wrong document was read, read `both` or the other document before acting.
- If output is truncated, re-read with a larger `charLimit`.
- If soul guidance conflicts with current user instructions, follow the current user instruction and avoid writing a global rule without explicit evidence.
<!-- /socrates:section -->
