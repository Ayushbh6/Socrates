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

`user_profile` reads the global durable profile for the user, `user_profile.md`.

Use it for stable user facts, preferences, collaboration style, boundaries, interests, and cross-project context. It is read-only for the main Socrates agent.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- The user asks what Socrates knows about them, their preferences, or their profile.
- The task depends on durable user context, collaboration style, dislikes, boundaries, or recurring projects.
- A personalized answer would materially improve the work.
- Do not use it as evidence for current repo state or temporary project facts.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "read"` reads the full user profile as bounded markdown. Use it only when the whole profile is genuinely needed, and pass a tight `charLimit`.
- `operation: "read_index"` returns the structured section map.
- `operation: "read_section"` reads one known section by `sectionId`.
- `sectionId` can be `profile_summary`, `stable_preferences`, `collaboration_style`, `work_and_projects`, `personal_interests`, `boundaries_and_dislikes`, `recent_context`, or `evidence_index`.
- `charLimit` can bound output for long documents.

Section meanings:
- `profile_summary`: compact high-level user context.
- `stable_preferences`: durable preferences that apply across projects.
- `collaboration_style`: how the user likes agents to work, communicate, verify, and report.
- `work_and_projects`: stable workspaces, repos, study areas, and recurring project context.
- `personal_interests`: hobbies or personal interests only when explicit and useful.
- `boundaries_and_dislikes`: explicit dislikes, boundaries, and strong corrections.
- `recent_context`: short-lived but currently useful context that should be pruned as it ages.
- `evidence_index`: traceable source anchors for important profile claims. It records where important profile facts came from: date, project title/id, conversation title/id, turn/message/event ids or trace handles when available, the supported claim, and which profile section uses that claim.

Evidence index entry shape:
- `YYYY-MM-DD | project: <title/id> | conversation: <title/id> | turnId/messageId/event: <id or trace handle>`
  `supports: <short claim this evidence supports>`
  `used_by: <profile section ids>`

Use exact ids/handles when they make the source retrievable. If ids are unavailable, use the best project title, conversation title, date, and trace handle. Do not treat vague summaries or routine turns as evidence-index entries.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. Start with `read_index` unless you already know the exact section id from this turn.
2. Use `read_section` when one profile section is enough.
3. Use full `read` only for whole-profile questions, with a tight `charLimit`.
4. Use project docs or repo docs for workspace-specific facts.
5. When a profile claim matters, inspect `evidence_index` for source anchors instead of treating profile prose as the evidence itself.
6. Treat runtime/developer/user instructions as higher priority than profile docs.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If the wrong section was read, use `read_index` and then read the better section.
- If output is truncated, re-read with a larger `charLimit`.
- If profile guidance conflicts with current user instructions, follow the current user instruction and avoid writing a global rule without explicit evidence.
<!-- /socrates:section -->
