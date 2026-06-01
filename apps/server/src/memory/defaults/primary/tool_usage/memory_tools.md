# Memory Tools Usage Guide

This guide covers Socrates' memory-facing tools and memory surfaces:

- `socrates_memory`
- `project_notes`
- project memory pages
- `soul`

There is no separate model-visible tool named `project_memory` in the current contract. Project memory is accessed through `socrates_memory` categories such as `project_brief`, `project_memory`, and `diary`, while the writable workspace-local project note is accessed through `project_notes`.

There is a separate non-memory doctrine tool named `repo_docs`. It reads/searches/patches `<workspace>/.socrates/repo_docs/*.md` for durable repo contracts and workflows. Use `repo_docs` for repo truth, not `socrates_memory`.

## Core Principle

Use memory to recover durable context, not to override current evidence. Memory is a guide; current files, current tool outputs, and higher-priority runtime instructions win.

## Memory Surfaces

| Surface | Path | Access Tool | Writable By Main Agent |
| --- | --- | --- | --- |
| Learned patterns | `~/.Socrates/primary/learned_patterns.md` | `socrates_memory` | No |
| Tool usage docs | `~/.Socrates/primary/tool_usage/*.md` | `socrates_memory` | No |
| Project brief | `~/.Socrates/projects/<projectId>/project_brief.md` | `socrates_memory` | No |
| Project memory | `~/.Socrates/projects/<projectId>/MEMORY.md` | `socrates_memory` | No |
| Project diary | `~/.Socrates/projects/<projectId>/diary/YYYY/MM/YYYY-MM-DD.md` | `socrates_memory` | No |
| Project notes | `<workspace>/.socrates/PROJECT_NOTES.md` | `project_notes` | Yes, through `project_notes.patch` only |
| Repo doctrine | `<workspace>/.socrates/repo_docs/*.md` | `repo_docs` | Yes, through `repo_docs.patch` only |
| Identity | `~/.Socrates/primary/identity.md` | `soul` | No |
| Operating principles | `~/.Socrates/primary/operating_principles.md` | `soul` | No |

## `socrates_memory`

`socrates_memory` is a read-only investigation tool over Socrates-owned memory pages under `~/.Socrates`.

Use it for:

- learned patterns
- tool usage docs
- project brief
- project memory
- diary entries
- queryless browsing of memory pages
- exact or keyword lookup across memory files

Do not use it for:

- raw prior conversation transcripts
- old tool calls or shell output
- identity or operating principles
- writing memory files
- editing project notes

Use `trace_retrieve` for raw conversation/tool provenance. Use `soul` for identity and operating principles. Use `project_notes` for workspace-local notes.

## `socrates_memory` Input

```json
{
  "operation": "search",
  "scope": "primary",
  "category": "tool_usage",
  "query": "turnNo",
  "searchMode": "keyword_all",
  "limit": 5,
  "charLimit": 8000,
  "contextLines": 8
}
```

## `socrates_memory` Parameter Reference

| Parameter | Applies To | Meaning | Use When |
| --- | --- | --- | --- |
| `operation` | all | `"search"` or `"read"` | Select browsing/searching versus exact file read. |
| `scope` | search | `"primary"`, `"project"`, or `"all"` | Choose global memory, current-project memory, or both. |
| `category` | all | `learned_patterns`, `tool_usage`, `project_brief`, `project_memory`, or `diary` | Narrow to one kind of memory page. |
| `path` | read/search | Memory path such as `primary/tool_usage/memory_tools.md` or `diary/2026/06/2026-06-01.md` | Read one known page or constrain lookup to one file. |
| `query` | search | Text or regex to find | Search for a phrase, concept, error code, tool name, date, or heading. |
| `searchMode` | search with query | `exact_phrase`, `keyword_all`, `keyword_any`, `whole_word`, or `regex` | Control lexical matching style. Requires `query`. |
| `memoryLimit` | search | Maximum memory pages/files to consider, max 50 | Browse recent pages without loading every memory file. |
| `memoryOffset` | search | Skip N memory pages/files before considering | Page through memory files. |
| `limit` | search | Maximum result units, max 20 | Keep returned evidence bounded. |
| `offset` | search | Skip N result units | Page through result units. |
| `charLimit` | all | Output character cap, max 80,000 | Increase when reading a known long page. |
| `contextLines` | search | Lines before/after a line match, max 100 | Get more surrounding context around matches. |
| `includeSections` | search | Return markdown sections as result units | Browse headings and structure without a query. |
| `modifiedAfter` / `modifiedBefore` | search | File modified-time bounds | Find memory pages changed during a time period. |
| `diaryDateAfter` / `diaryDateBefore` | diary search | Diary page date bounds | Inspect diary pages for a date range. |
| `entryAfter` / `entryBefore` | diary search | Diary entry timestamp bounds | Narrow within diary entries when headings contain timestamps. |
| `year`, `month`, `day` | diary search | Calendar filters | Browse diary pages for a year/month/day. |

Use `memoryLimit` for page/file count and `limit` for final result count. Do not confuse them.

## Operations

### search

Use for both query search and queryless browsing.

Queryless search:

```json
{
  "operation": "search",
  "scope": "primary",
  "category": "tool_usage",
  "includeSections": true,
  "limit": 10
}
```

Query search:

```json
{
  "operation": "search",
  "scope": "all",
  "query": "project notes",
  "searchMode": "keyword_all",
  "limit": 10
}
```

### read

Use when you already know the path.

```json
{
  "operation": "read",
  "path": "primary/tool_usage/memory_tools.md",
  "charLimit": 20000
}
```

## Scopes

### primary

Reads global non-soul memory:

- `learned_patterns.md`
- `tool_usage/*.md`

Use for tool behavior, cross-project lessons, and durable global patterns.

### project

Reads current-project memory:

- `project_brief.md`
- `MEMORY.md`
- diary pages

Use for project-specific operating context and recent diary notes.

### all

Reads both primary and current-project memory.

Use when unsure whether a memory belongs globally or to the current project.

## Categories

### learned_patterns

Durable global lessons learned across projects.

Example:

```json
{
  "operation": "search",
  "scope": "primary",
  "category": "learned_patterns",
  "query": "release verification",
  "searchMode": "keyword_all"
}
```

### tool_usage

Professional guidance for how to use Socrates tools.

Example:

```json
{
  "operation": "read",
  "path": "primary/tool_usage/trace_retrieve.md"
}
```

### project_brief

Short project summary and operating context.

### project_memory

Current project's persistent `MEMORY.md`.

Example:

```json
{
  "operation": "search",
  "scope": "project",
  "category": "project_memory",
  "query": "release",
  "searchMode": "keyword_any"
}
```

### diary

Daily project diary pages written by the backend memory agent.

Example:

```json
{
  "operation": "search",
  "scope": "project",
  "category": "diary",
  "diaryDateAfter": "2026-06-01",
  "limit": 10
}
```

## Search Modes

### exact_phrase

Use for exact strings.

```json
{
  "operation": "search",
  "query": "project_notes_dedicated_tool_required",
  "searchMode": "exact_phrase"
}
```

### keyword_all

Use when all words should appear.

```json
{
  "operation": "search",
  "query": "soul confirmation",
  "searchMode": "keyword_all"
}
```

### keyword_any

Use for broad recall.

```json
{
  "operation": "search",
  "query": "diary memory notes",
  "searchMode": "keyword_any"
}
```

### whole_word

Use for exact terms where substrings would be misleading.

```json
{
  "operation": "search",
  "query": "soul",
  "searchMode": "whole_word"
}
```

### regex

Use only when pattern matching is necessary.

```json
{
  "operation": "search",
  "query": "memory\\.(agent|soul)\\.",
  "searchMode": "regex"
}
```

## Paging And Limits

Use page controls to avoid broad dumps.

- `memoryLimit`: how many memory pages/files to consider.
- `memoryOffset`: skip pages/files before considering.
- `limit`: final result units returned.
- `offset`: skip result units.
- `charLimit`: output character budget.
- `contextLines`: context around line matches.

Example:

```json
{
  "operation": "search",
  "scope": "project",
  "category": "diary",
  "memoryLimit": 5,
  "limit": 10,
  "contextLines": 8
}
```

## Date Filters

Use file modified-time filters for memory pages:

```json
{
  "operation": "search",
  "scope": "all",
  "modifiedAfter": "2026-06-01T00:00:00.000Z"
}
```

Use diary-date filters for diary pages:

```json
{
  "operation": "search",
  "scope": "project",
  "category": "diary",
  "diaryDateAfter": "2026-06-01",
  "diaryDateBefore": "2026-06-30"
}
```

Use year/month/day for calendar browsing:

```json
{
  "operation": "search",
  "scope": "project",
  "category": "diary",
  "year": 2026,
  "month": 6
}
```

## `project_notes`

`project_notes` is the constrained interface for `<workspace>/.socrates/PROJECT_NOTES.md`.

Use it for:

- current repo/project notes
- working conventions discovered in the repo
- reminders that should stay with the workspace
- durable notes the main agent is allowed to patch

Do not use generic `edit` or `apply_patch` to mutate `PROJECT_NOTES.md`.

### Parameter Reference

| Parameter | Applies To | Meaning | Use When |
| --- | --- | --- | --- |
| `operation` | all | `"read"`, `"search"`, or `"patch"` | Select the project-notes action. |
| `query` | search | Literal text to find | Search the current workspace notes. |
| `oldText` | patch | Exact existing text to replace | Add or update a note safely. |
| `newText` | patch | Replacement text | The desired updated notes text. |
| `replaceAll` | patch | Replace every occurrence of `oldText` | Only when every occurrence should change. |
| `charLimit` | read/search | Output character cap | Read larger notes or bound output. |

### Read

```json
{
  "operation": "read",
  "charLimit": 12000
}
```

### Search

```json
{
  "operation": "search",
  "query": "release",
  "contextLines": 8
}
```

### Patch

```json
{
  "operation": "patch",
  "oldText": "## Notes\n",
  "newText": "## Notes\n\n- Use `pnpm test` before release.\n"
}
```

Patch rules:

- `oldText` must match.
- Use a long enough `oldText` to avoid ambiguity.
- Use `replaceAll` only when every occurrence must change.
- Keep notes concise and repo-specific.

## Project Memory Pages

Project memory pages are read through `socrates_memory`, not edited directly by the main agent.

Current project files:

- `~/.Socrates/projects/<projectId>/project_brief.md`
- `~/.Socrates/projects/<projectId>/MEMORY.md`
- `~/.Socrates/projects/<projectId>/diary/...`

Use these pages to orient, not to override current repo evidence.

## `soul`

`soul` is the read-only exact access tool for core identity and operating principles.

Use it when:

- the user asks what Socrates is supposed to be
- identity wording matters
- operating principles need exact inspection
- current behavior must be compared against core principles

### Parameter Reference

| Parameter | Meaning | Use When |
| --- | --- | --- |
| `operation` | Always `"read"` | Soul is read-only. |
| `document` | `"identity"`, `"operating_principles"`, or `"both"` | Select exact soul document content. |
| `charLimit` | Output character cap, max 80,000 | Increase when reading both docs and output truncates. |

### Read Identity

```json
{
  "operation": "read",
  "document": "identity",
  "charLimit": 12000
}
```

### Read Operating Principles

```json
{
  "operation": "read",
  "document": "operating_principles",
  "charLimit": 12000
}
```

### Read Both

```json
{
  "operation": "read",
  "document": "both",
  "charLimit": 20000
}
```

Soul rules:

- The main agent cannot edit soul docs.
- `socrates_memory` cannot read soul docs.
- Soul updates are backend memory-agent controlled.
- Soul updates require exact oldText/newText patches.
- Soul updates require internal confirmation.
- Only exact normalized `yes` applies a soul patch.
- Applied soul updates create durable notifications.

## Choosing The Right Memory Tool

| Need | Use |
| --- | --- |
| Prior conversation source | `trace_retrieve` |
| Prior tool call or shell output | `trace_retrieve` with `mode: "audit"` |
| Learned global pattern | `socrates_memory`, `category: "learned_patterns"` |
| Tool usage docs | `socrates_memory`, `category: "tool_usage"` |
| Current project diary | `socrates_memory`, `category: "diary"` |
| Current project memory page | `socrates_memory`, `category: "project_memory"` |
| Workspace-local project notes | `project_notes` |
| Identity and operating principles | `soul` |

## Common Workflows

### Learn how to use a tool

```json
{
  "operation": "read",
  "path": "primary/tool_usage/trace_retrieve.md"
}
```

### Search all memory for a behavior

```json
{
  "operation": "search",
  "scope": "all",
  "query": "stale content",
  "searchMode": "keyword_all",
  "limit": 10
}
```

### Inspect current project diary

```json
{
  "operation": "search",
  "scope": "project",
  "category": "diary",
  "memoryLimit": 3,
  "includeSections": true,
  "limit": 10
}
```

### Update project notes after discovering repo convention

```json
{
  "operation": "patch",
  "oldText": "# Project Notes\n",
  "newText": "# Project Notes\n\n- Server tests require package builds before Vitest.\n"
}
```

### Compare behavior to Socrates identity

```json
{
  "operation": "read",
  "document": "both"
}
```

### Investigate a memory-related user question

If the user asks, "What does Socrates remember about X?":

1. Search `socrates_memory` with `scope: "all"`.
2. If results point to tool usage, read the exact tool doc.
3. If results point to project diary/memory, inspect current project files if the answer depends on current repo truth.
4. If the user asks about identity/principles, use `soul`.

```json
{
  "operation": "search",
  "scope": "all",
  "query": "memory backfill",
  "searchMode": "keyword_all",
  "limit": 10,
  "contextLines": 8
}
```

### Add a durable current-project note

1. Read current project notes.
2. Patch with exact old/new text.
3. Keep the note specific and short.

```json
{
  "operation": "read",
  "charLimit": 12000
}
```

```json
{
  "operation": "patch",
  "oldText": "# Project Notes\n",
  "newText": "# Project Notes\n\n- Runtime archives must include server memory asset docs.\n"
}
```

## Access Verification

Socrates has exactly three model-visible memory tools in the current contract:

- `socrates_memory`: broad read-only memory-page search/read.
- `project_notes`: constrained read/search/patch for the active workspace's `PROJECT_NOTES.md`.
- `soul`: read-only exact access to identity and operating principles.

The current model-visible registry also includes other non-memory tools such as `repo_docs`, `trace_retrieve`, `read`, `search`, `edit`, `apply_patch`, `bash`, `list_project_resources`, and `mcp_registry`. `repo_docs` is a controlled workspace-doctrine write surface, not a Socrates memory tool.

To confirm the tool-usage docs are accessible:

```json
{
  "operation": "read",
  "path": "primary/tool_usage/memory_tools.md"
}
```

To browse all tool docs:

```json
{
  "operation": "search",
  "scope": "primary",
  "category": "tool_usage",
  "includeSections": true,
  "limit": 20
}
```

## FAQ

### Is there a `project_memory` tool?

No. `project_memory` is a `socrates_memory` category, not a separate model-visible tool. Use:

```json
{
  "operation": "search",
  "scope": "project",
  "category": "project_memory"
}
```

### Which tool can write memory?

The main agent can write only `PROJECT_NOTES.md`, and only through `project_notes.patch`. The backend memory agent can update diary, learned patterns, tool-usage docs, and soul docs through controlled backend patch flows.

### Can `socrates_memory` read identity or principles?

No. Use `soul`.

### Can `soul` write identity or principles?

No. `soul` is read-only. Soul edits are backend-memory-agent controlled and require exact internal confirmation.

### Should memory be trusted over current files?

No. Memory helps orient Socrates. Current repo files, current tool output, and runtime instructions are stronger evidence.

### What should Socrates do if memory and trace history disagree?

Use the tool appropriate to the evidence type. `trace_retrieve` is source history; `socrates_memory` is synthesized memory. If exact historical provenance matters, trust inspected trace evidence over synthesized memory.

## Anti-Patterns

Avoid:

- using `socrates_memory` for raw old chats
- using `trace_retrieve` for memory docs
- editing memory files directly
- editing `PROJECT_NOTES.md` with `edit` or `apply_patch`
- treating diary entries as current repo truth without verification
- using soul docs as permission to violate runtime instructions
- searching all memory repeatedly with vague queries

## Good Final Answer Pattern

When memory shaped the answer:

```text
I checked Socrates memory and found <source>. Current repo evidence says <current fact>. So the reliable answer is <answer>.
```

When memory and current evidence conflict:

```text
Memory says <old fact>, but current files/tool output show <new fact>. I am using the current evidence.
```

When project notes were updated:

```text
Updated PROJECT_NOTES.md through project_notes with <short note>. No generic edit tool was used.
```

## Checklist

- Am I looking for memory docs, project notes, soul docs, or raw chat history?
- Did I choose the correct tool?
- Did I use bounded limits?
- Did I avoid generic edits to `PROJECT_NOTES.md`?
- Did I treat memory as context rather than authority?
- Did I verify current files/tool output when the answer depends on current state?
