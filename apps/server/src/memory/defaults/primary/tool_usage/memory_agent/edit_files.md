# edit_files Usage Guide

`edit_files` is the Global Memory Agent's only scheduled-run write tool. It writes target-scoped global memory documents and does not accept raw filesystem paths.

Use it only after exact evidence has been found and inspected. Keep changes narrow, durable, and tied to the evidence that justified them.

## Core Principle

Patch the smallest durable memory target that will improve future behavior.

Do not rewrite broad memory just because a turn was interesting. Do not edit from summaries, project metadata, or uninspected search snippets.

## What It Can Edit

| Target | Purpose | Name Required | Create Allowed |
| --- | --- | --- | --- |
| `identity` | Soul identity document | No | No |
| `operating_principles` | Soul operating principles | No | No |
| `user_profile` | Durable cross-project user profile and preferences | No | No |
| `tool_doc` | Global tool usage document | Yes | Yes |
| `skill` | Global skill `SKILL.md` | Yes | No in scheduled runs |

For `tool_doc`, `name` becomes a sanitized markdown file under global `tool_usage`.

Scheduled memory runs may read skills but cannot create or update them. Global skill creation happens through the explicit Memory Center `Skills +` flow, which uses backend skill-generation logic outside scheduled runs.

Do not pass raw paths, relative paths, absolute paths, or path-like names.

## What It Must Not Do

- It must not edit repository source files.
- It must not edit project `.socrates` memory.
- It must not accept arbitrary paths.
- It must not create soul documents.
- It must not replace text that has not been read or inspected.
- It must not make broad rewrites when a small replacement is enough.

## Edit Modes

| Mode | Use When |
| --- | --- |
| `replace` | Editing an existing target. Requires exact `oldText`. |
| `create` | Creating a new `tool_doc`. |

`replace` requires `oldText` and `newText`. The `oldText` must match exactly once in the current target. If it matches zero times or more than once, the tool rejects the patch.

`create` writes a new tool doc only when the target does not already exist. If the target exists, read it and use `replace`.

## Input Reference

| Parameter | Meaning | Use When |
| --- | --- | --- |
| `target` | `identity`, `operating_principles`, `user_profile`, `tool_doc`, or `skill` | Select memory surface. |
| `name` | Tool doc name | Required for `tool_doc`. |
| `editMode` | `replace` or `create` | Select patch behavior. |
| `sectionId` | Structured section id | Use when updating one indexed section. |
| `oldText` | Exact current text to replace | Required for `replace`. |
| `newText` | Replacement or new file content | Required for all writes. |
| `rationale` | Why this update is justified | Use for every non-trivial memory write. |
| `sourceTurnIds` | Inspected source turn ids | Use when `trace_retrieve` supplied stable turn ids. |

## Structured Section Edits

Global memory docs use YAML frontmatter plus `<!-- socrates:section ... -->` markers. When the intended section is known, pass `sectionId` with the exact `oldText` copied from that section. The backend limits the replacement to that section and rejects zero or ambiguous matches. Do not use `sectionId` with `skill`; Agent Skills have their own `SKILL.md` frontmatter contract and scheduled runs cannot update skills.

Successful structured-doc edits stamp YAML frontmatter with backend-owned `updated_at`, `updated_by`, and `last_edited_section`. Do not manually invent "today" in memory prose when the frontmatter stamp is enough.

Good section edit:

```json
{
  "target": "user_profile",
  "editMode": "replace",
  "sectionId": "stable_preferences",
  "oldText": "- Prefer concise answers.",
  "newText": "- Prefer concise answers unless explicitly asking for a deep plan.",
  "rationale": "Exact trace evidence showed the stable preference needs a scoped qualifier.",
  "sourceTurnIds": ["turn_..."]
}
```

Use whole-document `oldText` replacement only when no structured section applies.

## Target Selection

### identity

Use for stable facts about what Socrates is or how it should understand its role. This should be rare.

Good:

- A repeated, explicit user correction about the product's identity.
- A durable identity constraint that applies across projects.

Bad:

- A tool usage rule.
- A one-off project preference.
- A workflow recipe.

### operating_principles

Use for durable global behavior rules that should shape future agents.

Good:

- "Do not edit from memory summaries alone."
- "Ask before destructive runtime-state resets."

Bad:

- Step-by-step usage for one tool.
- Detailed project notes.

### tool_doc

Use for model-facing guidance about a specific tool.

Good:

- Parameter rules.
- Failure handling.
- Few-shot JSON examples.
- Tool-specific do/don't patterns.

Bad:

- General user identity.
- Project-specific repo facts.

## Replace Examples

Replace one tool-doc sentence:

```json
{
  "target": "tool_doc",
  "name": "trace_retrieve",
  "editMode": "replace",
  "oldText": "Use audit mode for runtime evidence.",
  "newText": "Use audit mode only for runtime evidence such as tools, shell, files, patches, and errors.",
  "rationale": "Inspected trace evidence showed audit mode being confused with normal conversation search.",
  "sourceTurnIds": ["turn_..."]
}
```

Replace a longer ambiguous paragraph by copying enough exact context:

```json
{
  "target": "operating_principles",
  "editMode": "replace",
  "oldText": "Before updating memory, inspect the source evidence.\n\nPrefer concise durable rules.",
  "newText": "Before updating memory, inspect exact source evidence rather than relying on summaries or metadata.\n\nPrefer concise durable rules.",
  "rationale": "The user repeatedly corrected memory-agent behavior to require exact evidence before edits.",
  "sourceTurnIds": ["turn_..."]
}
```

Bad replace:

```json
{
  "target": "tool_doc",
  "name": "trace_retrieve",
  "editMode": "replace",
  "oldText": "audit",
  "newText": "audit mode",
  "rationale": "Too vague."
}
```

The bad example is too short and likely to match more than once.

## Create Examples

Create a tool doc:

```json
{
  "target": "tool_doc",
  "name": "memory_agent_trace_retrieve",
  "editMode": "create",
  "newText": "# memory_agent_trace_retrieve Usage Guide\n\nUse this doc for Global Memory Agent retrieval patterns.\n\n## Core Principle\n\nInspect exact evidence before writing memory.\n",
  "rationale": "The Global Memory Agent lacked tool-specific retrieval guidance.",
  "sourceTurnIds": ["turn_..."]
}
```

Do not create skills from scheduled memory runs. If a reusable workflow should become a skill, mention it in the final `Skipped` section so the user can create it explicitly with Memory Center `Skills +`.

Bad create:

```json
{
  "target": "tool_doc",
  "name": "../operating_principles",
  "editMode": "create",
  "newText": "Write to this path."
}
```

The bad example tries to use a path-like name. The tool resolves named targets only.

## Soul Confirmation

Edits to `identity` and `operating_principles` require an internal soul confirmation pass before they are applied.

The tool may reject a soul edit when:

- Confirmation returns `no`.
- Confirmation output is invalid.
- `oldText` no longer matches after confirmation.
- The patch is too broad or poorly justified.

For soul edits:

- Use `replace`, never `create`.
- Keep the patch small.
- Include a strong `rationale`.
- Include `sourceTurnIds` when available.
- Expect stricter review than tool docs or skills.

## Common Writing Recipes

### Update a tool doc after repeated misuse

1. Use `trace_retrieve` to inspect examples of the misuse.
2. Read or search the current tool doc.
3. Replace the smallest paragraph that would prevent the future mistake.
4. Include `sourceTurnIds`.

```json
{
  "target": "tool_doc",
  "name": "projects",
  "editMode": "replace",
  "oldText": "Use `projects` to decide where to run `trace_retrieve`.",
  "newText": "Use `projects` only for metadata orientation; use `trace_retrieve` for exact evidence before any memory edit.",
  "rationale": "Inspected evidence showed metadata being treated as proof.",
  "sourceTurnIds": ["turn_..."]
}
```

### Defer a repeated workflow to Skills +

1. Confirm the workflow appears in more than one context or is clearly durable.
2. Inspect evidence for the complete workflow.
3. Do not call `edit_files` with `target: "skill"`.
4. Mention the skill candidate briefly in the final `Skipped` section.

### Tighten an operating principle

1. Confirm the rule is global and durable.
2. Inspect exact user correction or repeated assistant failure.
3. Replace one sentence or paragraph.
4. Let soul confirmation decide whether the change is acceptable.

```json
{
  "target": "operating_principles",
  "editMode": "replace",
  "oldText": "Use memory to improve future work.",
  "newText": "Use memory to improve future work, but only write durable principles from inspected evidence rather than summaries or metadata.",
  "rationale": "The user asked for memory-agent docs to require exact evidence before edits.",
  "sourceTurnIds": ["turn_..."]
}
```

## Output Interpretation

Prefer these fields:

- `status`: `applied`, `awaiting_confirmation`, `rejected`, or `unchanged`.
- `changed`: whether the target changed.
- `path`: resolved global memory path for provenance, not an input path.
- `actionId`: durable action record.
- `diff`: simple old/new diff when available.
- `warnings`: rejection reason or caution.
- `truncation`: whether output was capped.

## Failure Handling

If `oldText was not found`:

- Read the current target.
- Copy exact current text.
- Check whitespace and punctuation.
- Retry only with corrected `oldText`.

If `oldText matched more than once`:

- Use a longer block with surrounding context.
- Do not use `replaceAll`; this tool intentionally requires one exact match.

If `Target already exists`:

- Read or search the existing target.
- Use `replace` instead of `create`.

If skill creation is rejected:

- Ensure the content is valid `SKILL.md`.
- Ensure frontmatter `name` matches the sanitized skill folder name.

If soul confirmation rejects:

- Do not force the edit.
- Re-check whether the rule belongs in a tool doc or skill instead.
- Retry only if the evidence and patch were materially improved.

## Checklist Before Writing

- Did `trace_retrieve` inspect exact evidence?
- Is the lesson durable, not just a transcript summary?
- Is this the smallest correct target?
- Is `oldText` copied exactly and likely to match once?
- Does `newText` preserve the surrounding document style?
- Is `rationale` concrete?
- Are `sourceTurnIds` included when available?
- Am I avoiding raw paths and path-like names?
