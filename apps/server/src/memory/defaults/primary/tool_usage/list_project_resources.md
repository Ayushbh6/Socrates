---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# list_project_resources Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`list_project_resources` lists active uploaded resources recorded for the current project, especially files under `.socrates/resources`, without shell probing.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The user asks about uploaded project files or the exact resource path is unknown.
- Use it before Terminal directory probing for managed project resources.
- Do not use it for chat image attachments, ordinary workspace files, or deleted-resource provenance.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- Optional `kind` narrows the resource type.
- Optional `limit` bounds results.
- Output returns recorded filenames and metadata, not file contents.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. List resources with the smallest useful scope.
2. Select the exact returned resource path.
3. Use `read` for bounded content inspection.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If no resource is listed, distinguish that from ordinary workspace files; search the workspace only when the request calls for it.
- Never invent a resource path or deleted conversation provenance.
<!-- /socrates:section -->
