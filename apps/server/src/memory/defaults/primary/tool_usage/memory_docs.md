# memory docs tools

Socrates has separate tools for conversation evidence, tool guidance, reusable skills, project state, repo doctrine, and soul context.

## Tool map

| Need | Tool |
| --- | --- |
| Prior conversation text, screenshots provenance, tool calls, shell output, patches, errors | `trace_retrieve` |
| Global tool usage guidance | `tool_docs` |
| Reusable workflows and learned patterns | `skills` |
| Workspace project memory and working notes | `project_docs` |
| Durable repo doctrine | `repo_docs` |
| Identity and operating principles | `soul` |

## project_docs

`project_docs({ operation, area })` targets the active workspace:

- `area: "memory"` -> `.socrates/MEMORY.md`
- `area: "notes"` -> `.socrates/PROJECT_NOTES.md`

Use `editMode: "append"` for active notes. Use `editMode: "replace"` for curated durable memory updates.

## tool_docs

`tool_docs` is read-only for the main agent. Use it for exact tool guidance under `~/.Socrates/tool_usage`.

## skills

`skills` is read-only for the main agent. Use `list` or `search` to discover visible builtin, global, and project skills, then `read` the relevant skill body or a referenced file inside that skill. Internal builder guidance such as `socrates-skill-writer` is reserved for backend skill generation and is not part of normal model-visible skill discovery.

## repo_docs

`repo_docs` reads/searches/edits only `CORE_IDEA.md`, `REPO_NAVIGATION.md`, `REPO_RULES.md`, and `CONTRACTS.md`.
