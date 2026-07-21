---
socrates_doc: tool_doc
schema_version: 1
owner_tool: tool_docs
scope: global
index_tags: [tool_usage]
---

# skills Usage Guide

<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->
## Purpose

`skills` discovers and reads reusable Socrates skill instructions. It can also securely preview and install one Agent Skill ZIP from an exact user-supplied public HTTPS URL or a ZIP attached to the current user message. `skill_manager` owns approval-gated creation and deletion of project skills through the configured Skill Writer path.

Skills are procedural guidance for repeatable workflows; they are not evidence for facts about the current repo or prior conversation.
<!-- /socrates:section -->

<!-- socrates:section id="when_to_use" kind="routing" tags="tools" -->
## When To Use

- A reusable workflow, specialized procedure, or domain-specific instruction may apply.
- The user names a skill or asks for a kind of work covered by an installed skill.
- You need to inspect project, global, or builtin skill guidance before acting.
- The user supplies an exact Agent Skill ZIP URL or attaches a ZIP and asks to review or install it globally or for the current project.
- The user explicitly asks Socrates to create or delete a project skill; use `skill_manager` rather than writing `.socrates/skills` directly.
- Do not use skills as proof of current code state; inspect files or traces for evidence.
- This tool does not search the web. If the user asks Socrates to find a skill without supplying a URL, use an explicitly configured search MCP or explain that discovery is unavailable.
<!-- /socrates:section -->

<!-- socrates:section id="inputs" kind="schema" tags="tools" -->
## Inputs

- `operation: "list"` lists visible skills with exact ids, names, scopes, and descriptions.
- `operation: "describe"` reads one skill by exact `id` or `name` and optional `scope`.
- `operation: "read"` reads one supporting file by exact skill `id` plus a relative path returned or referenced by that skill, such as `references/checklist.md`.
- `operation: "preview_import"` safely inspects one ZIP. Provide `scope: "project" | "global"` plus exactly one exact public HTTPS `url` or exact `.socrates/attachments/*.zip` `attachmentPath` shown in the current user message; project is the default.
- `operation: "commit_import"` installs the exact staged `previewId`. It is approval-required. `conflictStrategy` defaults to `reject`; use `replace` only when the user explicitly wants the existing same-name skill replaced.
- `n` controls list size; it defaults low and is capped by the runtime.
- `scope` may be `builtin`, `global`, or `project` when supported by the runtime.
- Some skills reference relative files; resolve them relative to the skill file first.
- `skill_manager operation:"create"` requires a human-facing `name` and the user's bounded `request`; it delegates authoring to the structured Skill Writer and requires approval.
- `skill_manager operation:"delete"` requires the exact project-skill `name`, deletes only that skill after approval, and must not target builtin or global skills.
<!-- /socrates:section -->

<!-- socrates:section id="workflow" kind="workflow" tags="tools" -->
## Workflow

1. List when the relevant skill is unknown.
2. Describe the selected skill before applying it.
3. Follow the skill's routing instructions and only open referenced files needed for the task.
4. When `SKILL.md` references a supporting file, use `skills read` with the same canonical id and exact relative path. Do not guess filesystem paths.
5. Combine skill guidance with current repo evidence and higher-priority user/developer instructions.
6. Mention if an expected skill is missing and continue with the best fallback.

For project-skill creation or deletion:

1. Confirm the user explicitly requested the lifecycle change and inspect current skills with `skills list` or `describe`.
2. Call `skill_manager` with the exact human-facing name and operation. Never create, rewrite, or remove `.socrates/skills` through Terminal or generic edit tools.
3. Let the approval flow complete, then verify the result with `skills list` or `describe`.

For an import:

1. Require an exact user-supplied public HTTPS ZIP URL or current-message ZIP attachment path. Never invent a package source and never use Terminal to bypass this importer.
2. Call `preview_import`. URL downloads are capped at 30 MB and block local/private destinations and unsafe redirects. Chat ZIP attachments are capped at 20 MB and must belong to the current user turn. Both sources use the same extraction/file/path/depth caps and never execute package contents.
3. Tell the user the skill name, destination scope, package size and file count, whether a conflict exists, and every returned warning. The model preview is capped at 30 file paths and 10 warnings; truncation flags reveal omitted entries.
4. Call `commit_import` with the exact returned `previewId` only when installation is requested. Normal approval UI must complete before the atomic install runs.
5. If a conflict exists, keep `reject` unless the user explicitly requested replacement. Never silently overwrite a skill.
6. Verify the installed skill with `list` or `describe` before claiming success.
<!-- /socrates:section -->

<!-- socrates:section id="failure_handling" kind="recovery" tags="tools" -->
## Failure Handling

- If no skill matches, continue from repo evidence and note the missing reusable guidance if relevant.
- If multiple skills match, describe the most specific one first.
- If a referenced skill file is missing, state the issue and use the next-best local evidence.
- If a skill conflicts with explicit user/developer instructions, follow the higher-priority instruction.
- If a URL is not HTTPS, resolves to a local/private address, redirects too many times, is larger than 30 MB, or does not return a ZIP, ask for a valid direct public HTTPS ZIP URL.
- If an import preview expires, call `preview_import` again; do not reuse or fabricate a preview id.
- If `skill_manager` reports a conflict or missing skill, refresh with `skills list`; do not guess another name or bypass the structured Skill Writer path.
- If preview warnings identify network access, package installation, destructive commands, allowed-tools, or possible secrets, report them plainly. Installing a skill never pre-approves the commands it describes.
<!-- /socrates:section -->
