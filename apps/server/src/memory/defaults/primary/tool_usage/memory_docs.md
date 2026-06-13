# memory docs tools

Socrates has separate tools for conversation evidence, tool guidance, reusable skills, project state, repo doctrine, and soul context. Main Socrates and the Global Memory Agent use different tool sets; check the right section before acting.

## Main Socrates Tools

| Need | Tool |
| --- | --- |
| Prior conversation text, screenshots provenance, tool calls, shell output, patches, errors | `trace_retrieve` |
| Global tool usage guidance | `tool_docs` |
| Reusable workflows and learned patterns | `skills` |
| Workspace project memory and working notes | `project_docs` |
| Durable repo doctrine | `repo_docs` |
| Identity and operating principles | `soul` |

Main Socrates also has normal workspace tools such as `read`, `search`, `edit`, `apply_patch`, `bash`, `list_project_resources`, and `mcp_registry`.

## Global Memory Agent Tools

| Need | Tool |
| --- | --- |
| Cross-project conversation and audit evidence | `trace_retrieve` |
| Metadata-only project/conversation orientation | `projects` |
| Tool usage guidance, including this folder | `tool_docs` |
| Existing reusable skills | `skills` |
| Identity and operating principles | `soul` |
| Global tool docs, global skills, and gated soul edits | `edit_files` |

Memory-agent specific guidance lives under `tool_usage/memory_agent/`:

- `memory_agent/trace_retrieve_global.md`
- `memory_agent/projects.md`
- `memory_agent/edit_files.md`

The Global Memory Agent does not receive generic `edit`, `apply_patch`, `bash`, `project_docs`, or `repo_docs`. Project-level writing stays with main Socrates.

## project_docs

`project_docs({ operation, area })` targets the active workspace:

- `area: "memory"` -> `.socrates/MEMORY.md`
- `area: "notes"` -> `.socrates/PROJECT_NOTES.md`

Use `editMode: "append"` for active notes. Use `editMode: "replace"` for curated durable memory updates.

## tool_docs

`tool_docs` is read-only for main Socrates and the Global Memory Agent. Use it for exact tool guidance under `~/.Socrates/tool_usage`.

## skills

`skills` is read-only for the main agent. Use `list` or `search` to discover visible builtin, global, and project skills, then `read` the relevant skill body or a referenced file inside that skill. Internal builder guidance such as `socrates-skill-writer` is reserved for backend skill generation and is not part of normal model-visible skill discovery.

## repo_docs

`repo_docs` reads/searches/edits only `CORE_IDEA.md`, `REPO_NAVIGATION.md`, `REPO_RULES.md`, and `CONTRACTS.md`.
