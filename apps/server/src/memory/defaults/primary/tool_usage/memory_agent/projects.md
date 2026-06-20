---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# projects Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`projects` gives the Global Memory Agent metadata-only orientation across visible Socrates projects and conversations.

It helps decide where to run `trace_retrieve`; it is not evidence for a memory edit.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The relevant project or conversation is unclear from the manifest.
- A broad memory-agent run needs a project/conversation map before targeted trace retrieval.
- Conversation titles, update times, or project names can narrow the next `trace_retrieve` call.
- Do not use project metadata as proof of user preferences, assistant behavior, tool output, or file contents.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "list_projects"` lists visible projects.
- `operation: "list_conversations"` lists conversations for a project.
- `projectId` selects a project for conversation listing.
- `limit` and `offset` page large result sets.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. List projects when the manifest does not clearly identify the target.
2. List conversations for a candidate project when a conversation title or recent activity matters.
3. Use returned metadata to choose a focused `trace_retrieve` search.
4. Inspect trace evidence before making any memory decision.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If the project list is too broad, narrow by names from the manifest or recent activity.
- If `projectId` is wrong or missing, list projects again and choose a visible project.
- If titles are repeated or ambiguous, use timestamps and then verify exact evidence with `trace_retrieve`.
- If `projects` returns only metadata, do not infer message bodies, tool calls, file changes, or preferences from it.
<!-- /socrates:section -->
