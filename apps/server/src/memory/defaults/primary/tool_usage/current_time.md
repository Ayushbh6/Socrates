---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# current_time Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`current_time` returns the backend-owned current date, ISO timestamp, and time zone.

Use it as the date authority when a task depends on today's date, relative dates, filenames, timestamps, or time-sensitive memory/docs wording.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The user asks about today, yesterday, tomorrow, this week, deadlines, recency, or date-sensitive status.
- You need to stamp or reason about generated notes, filenames, or reports.
- Prior context includes dates that may be stale or from another time zone.
- A docs or memory update needs a human-readable date and the backend frontmatter stamp is not enough.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- No input arguments are required.
- The output includes `currentDate`, `currentDateTime`, `timeZone`, and `source: "system"`.
- Treat the output as authoritative over model memory or old conversation context.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Call `current_time` before making a date-sensitive claim.
2. Use `currentDate` for plain dates and `currentDateTime` for precise timestamps.
3. Mention the date explicitly when correcting user confusion around relative dates.
4. Prefer backend-owned docs frontmatter stamps over manually writing dates into prose when a visible date is not necessary.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If `current_time` is unavailable, avoid precise relative-date claims and say the date could not be verified.
- If a prior note conflicts with `current_time`, use `current_time` and state the concrete date.
- If a memory/doc edit only needs backend metadata, do not duplicate the same timestamp in prose.
<!-- /socrates:section -->
