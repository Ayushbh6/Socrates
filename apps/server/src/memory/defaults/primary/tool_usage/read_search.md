---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# read and search Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

Use read/search tools to find candidate workspace files, inspect exact evidence, and avoid editing or explaining code from guesses.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Any repo investigation where the relevant files are unknown.
- Before editing files, reviewing behavior, or making architecture claims.
- When file contents may be large and bounded reads are safer than full dumps.
- When uploaded project resources need to be listed before exact paths are known.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- Search modes: use file/path search to find files and text search to find content.
- Scope with `path` when the repo is large.
- Use regex only when the query is intentionally a regular expression.
- Use `charLimit`, `tokenLimit`, offsets, or line ranges for large files.
- Use resource-listing tools before reading uploaded resources when the exact resource path is unknown.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Search for filenames, symbols, strings, or config keys likely to anchor the task.
2. Read the exact files or line ranges that can prove the claim or guide the edit.
3. Re-read with a larger limit or offset when truncation hides the needed part.
4. Prefer `rg`/fast search patterns for broad repo scans.
5. Use evidence from current files over memory of prior runs.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If search has no hits, broaden the term, search filenames, or inspect nearby directories.
- If search has too many hits, add a path scope or more specific token.
- If output is truncated, re-read the relevant range with a higher limit or offset.
- If regex search fails unexpectedly, retry as a literal search unless regex behavior was required.
<!-- /socrates:section -->
