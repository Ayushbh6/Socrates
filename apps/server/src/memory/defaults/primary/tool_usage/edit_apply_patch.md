---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# edit and apply_patch Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

Use edit tools to mutate workspace files after reading the current file contents and choosing the smallest safe change.

Use dedicated Socrates docs tools for `.socrates` memory/repo docs and global tool guidance instead of generic file mutation.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Use `edit` for a precise single-file replacement when the exact old string is known.
- Use `apply_patch` for multi-hunk edits, multi-file edits, adding files, deleting files, or clearer diff-shaped changes.
- Use neither tool until the target file has been read or searched recently enough to avoid stale edits.
- Do not use these tools for Socrates-owned memory surfaces when a dedicated docs/memory tool exists.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `edit`: target path plus exact `oldString` and `newString`, or whole-file `content` only when intentional.
- `apply_patch`: patch envelope with add, delete, or update hunks.
- Paths must stay inside the active workspace unless the tool explicitly allows otherwise.
- Preserve surrounding style, imports, formatting, and existing ownership boundaries.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Read or search the target file and identify the exact code/text to change.
2. Prefer the repo's existing patterns over new abstractions.
3. Apply the smallest patch that completes the requested behavior.
4. Run focused tests or typechecks when the changed surface has executable coverage.
5. Report changed files and any verification that could not be run.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If `oldString` does not match, re-read the file and patch against current contents.
- If an `apply_patch` hunk fails, inspect nearby lines and retry with tighter context.
- If a command rejects protected Socrates memory/docs paths, use `project_docs`, `repo_docs`, `tool_docs`, `skills`, `soul`, or the relevant memory surface instead.
- If generated output or user edits appear during work, preserve unrelated changes and adapt to the current file state.
<!-- /socrates:section -->
