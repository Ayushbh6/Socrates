# repo_docs Usage Guide

`repo_docs` reads, searches, and edits the active workspace's durable repo doctrine.

It is the only normal way Socrates should update `.socrates/repo_docs/*.md`.

These docs are the project's durable operating map. They should be used proactively before meaningful repo work, not only after something breaks.

## Files

| File | Purpose |
| --- | --- |
| `CORE_IDEA.md` | Repo purpose, current state, current user direction. |
| `REPO_NAVIGATION.md` | Where important code lives and how to move through the repo. |
| `REPO_RULES.md` | Durable repo-specific engineering rules and constraints. |
| `CONTRACTS.md` | Important APIs, data contracts, tool contracts, frontend/backend contracts. |

## Mental Model

`repo_docs` is not a scratchpad. It is Socrates' durable doctrine for how this repo works.

Use it to preserve repo knowledge that should guide future implementation:

- What the repo is for and what state it is currently in.
- Where important code, tests, prompts, providers, routes, and data stores live.
- Repo-specific rules the user expects Socrates to follow.
- API, tool, database, prompt, provider, and frontend/backend contracts.
- Persistent pitfalls, required workflows, and commands that future Socrates should know.

## Expected Cadence

Before meaningful implementation or repo investigation, read the relevant repo docs first. If they are missing, stale, or conflict with known current repo state, update them before implementation so the work starts from aligned doctrine.

During active repo work, revisit repo docs roughly every 3-4 meaningful turns, or immediately when durable architecture, contracts, navigation, workflows, provider behavior, or repo rules change.

Do not write temporary notes here. Temporary investigation state belongs in `project_docs` notes.

## Common Calls

List repo-doc files:

```json
{
  "operation": "read"
}
```

Read parsed section indexes:

```json
{
  "operation": "read_index"
}
```

Read one structured section:

```json
{
  "operation": "read_section",
  "path": "REPO_RULES.md",
  "sectionId": "hard_rules"
}
```

Patch one structured section:

```json
{
  "operation": "patch_section",
  "path": "CONTRACTS.md",
  "sectionId": "tool_contracts",
  "oldText": "Old contract text.",
  "newText": "New contract text."
}
```

Read one file:

```json
{
  "operation": "read",
  "path": "REPO_RULES.md"
}
```

Search all repo docs:

```json
{
  "operation": "search",
  "query": "database contract"
}
```

Edit one durable rule:

```json
{
  "operation": "edit",
  "path": "CONTRACTS.md",
  "oldText": "Old contract text.",
  "newText": "New contract text."
}
```

All `repo_docs` outputs may include a `runtime` object with backend-owned `currentDate`, `currentDateTime`, `timeZone`, and `source: "system"`. Use it as the date authority for repo-doc workflows when a date is needed. Successful repo-doc edits also stamp YAML frontmatter with backend-owned `updated_at`, `updated_by`, and `last_edited_section`.

## Rules

- Use `repo_docs` for durable repo doctrine only.
- Do not write temporary notes here.
- Prefer `read_index`, then `read_section` or `patch_section`, when the relevant section is known.
- Prefer small `oldText`/`newText` replacements with enough context to match once.
- Do not use generic file edit or apply_patch on repo docs.
- Update repo docs when architecture, contracts, navigation, workflows, or persistent pitfalls change.
- If repo docs are stale and you know the corrected durable fact, fix the doc before implementing against that fact.

## Few-Shot Examples

User intent: "Make the provider cache behavior better."

Good first move:

```json
{
  "operation": "read_section",
  "path": "CONTRACTS.md",
  "sectionId": "tool_contracts"
}
```

Then inspect code. If the contract doc is stale, update the relevant contract before or alongside implementation.

User intent: "Where should I add the new memory endpoint?"

Good first move:

```json
{
  "operation": "read",
  "path": "REPO_NAVIGATION.md"
}
```

If the route map is missing the current server layout, update `REPO_NAVIGATION.md`.

User intent: Implementation changes a durable backend contract.

Good end-of-work update:

```json
{
  "operation": "edit",
  "path": "CONTRACTS.md",
  "oldText": "Old provider cache contract.",
  "newText": "Updated provider cache contract with the new request field and fallback behavior."
}
```
