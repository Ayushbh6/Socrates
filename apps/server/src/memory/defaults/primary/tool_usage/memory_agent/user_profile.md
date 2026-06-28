---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# user_profile Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`user_profile` reads the global durable profile for the user, `user_profile.md`, before memory-agent profile edits.

The profile is the durable model of the user, not Socrates' identity.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- Before any proposed `user_profile` edit.
- When exact evidence contains stable user facts, durable preferences, collaboration style, recurring project context, interests, boundaries, or dislikes.
- When deciding whether a candidate memory is already represented.
- Do not use profile docs as evidence; use `trace_retrieve` for evidence.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "read"` reads the full user profile as bounded markdown. Use it only when the whole profile is genuinely needed, and pass a tight `charLimit`.
- `operation: "read_index"` returns the structured section map.
- `operation: "read_section"` reads one known section by `sectionId`.
- `sectionId` can be `profile_summary`, `stable_preferences`, `collaboration_style`, `work_and_projects`, `personal_interests`, `boundaries_and_dislikes`, `active_context`, or `evidence_index`.
- `charLimit` bounds output.

Section meanings:
- `profile_summary`: compact high-level user context.
- `stable_preferences`: durable preferences that apply across projects.
- `collaboration_style`: how the user likes agents to work, communicate, verify, and report.
- `work_and_projects`: stable workspaces, repos, study areas, and recurring project context.
- `personal_interests`: hobbies or personal interests only when explicit and useful.
- `boundaries_and_dislikes`: explicit dislikes, boundaries, and strong corrections.
- `active_context`: short-lived but currently useful user-life context that is global across projects and should be pruned as it ages. It may include a compact source project/conversation label, but not project-local task state.
- `evidence_index`: traceable source anchors for important profile claims. It should record where important profile facts came from: date, project title/id, conversation title/id, turn/message/event ids or trace handles when available, the supported claim, and which profile section uses that claim.

Evidence index entry shape:
- `YYYY-MM-DD | project: <title/id> | conversation: <title/id> | turnId/messageId/event: <id or trace handle>`
  `supports: <short claim this evidence supports>`
  `used_by: <profile section ids>`

Use exact ids/handles when they make the source retrievable. If ids are unavailable, use the best project title, conversation title, date, and trace handle. Do not put vague summaries or routine turns here.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Start with `read_index` unless you already know the exact section id from this run.
2. Read the relevant profile section before considering a profile edit.
3. Compare the current document against inspected trace evidence.
4. Use `edit_files` only for small, durable, global profile changes.
5. When adding or materially changing an important profile claim, add or update a compact `evidence_index` anchor for the source turn/message/trace.
6. Keep profile facts useful and non-invasive; do not store secrets or sensitive personal data.
7. For mixed evidence turns, split strictly: profile only the global user fact, and leave project-local implementation plans, feature sequencing, repo todos, or workspace reminders out of `user_profile`.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If output is truncated, re-read with a larger `charLimit`.
- If the wrong section was selected, use `read_index` and then read the better section.
- If evidence is only project-specific or temporary, skip profile edits unless it is truly global user active context; record the skip reason when closing the memory note.
- If correcting a profile fact, update the content section and `evidence_index` together so anchors support the corrected claim.
<!-- /socrates:section -->
