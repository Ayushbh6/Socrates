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

`soul` reads global Socrates identity and operating-principle documents for the memory agent.

It is the read path before rare edits to `identity` or `operating_principles`.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Before any proposed identity or operating-principles edit.
- When evidence may already be covered by global behavior rules.
- When a user correction appears global rather than project-specific.
- Do not use soul docs as evidence; use `trace_retrieve` for evidence.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "read"` reads soul documents.
- `document: "identity"` reads identity.
- `document: "operating_principles"` reads behavior principles.
- `document: "both"` reads both when the target is unclear.
- `charLimit` bounds output.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Read the relevant soul document before considering a soul edit.
2. Compare the current document against inspected trace evidence.
3. Use `edit_files` only for small, durable, global changes.
4. Let the soul confirmation pass reject weak or unsafe edits.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If output is truncated, re-read with a larger `charLimit`.
- If the wrong document was selected, read `both` before deciding.
- If confirmation rejects an edit, do not retry broadly; report the rejection.
- If evidence is project-specific, skip soul edits and leave project memory to the main Socrates agent.
<!-- /socrates:section -->
