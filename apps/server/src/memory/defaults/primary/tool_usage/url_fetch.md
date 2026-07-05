---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# url_fetch Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

Use `url_fetch` to read one exact http(s) URL as bounded text or metadata without saving files. It is an internet read primitive, not a web search engine.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The user gives a specific URL and asks Socrates to read, summarize, compare, inspect redirects, or extract request/response details.
- A docs page, JSON endpoint, CSV, plain-text page, or HTML page must be compared with local files.
- You need content type, status, final redirected URL, or a bounded text sample before deciding the next step.
- Do not use `url_fetch` for broad web search, crawling a site, downloading binaries, or saving remote files.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `url` must be an exact `http` or `https` URL.
- `charLimit` caps returned decoded text. The backend also applies a byte cap before decoding.
- `timeoutMs` caps the network wait.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Fetch only the exact URL needed for the user request.
2. Check `status`, `finalUrl`, `contentType`, `warnings`, and `truncation` before relying on the text.
3. If text is truncated but the needed section may be missing, use a narrower URL or a small Terminal script only when the task justifies it.
4. Combine with `read`/`search` for local comparisons and Terminal for bounded parsing or conversion work.
5. Cite or mention the source URL when the fetched page is evidence for the answer.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If `url_fetch` returns metadata only, the response was likely non-text; do not invent content.
- If the fetch times out, retry only when a shorter or more specific URL is available.
- If the user needs current web research rather than one exact URL, use configured search/MCP capabilities if available or explain what external search capability is missing.
- Do not bypass approval gates with Terminal network commands.
<!-- /socrates:section -->
