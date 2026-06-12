---
name: socrates-skill-writer
description: Use when creating or revising Socrates Agent Skills for reusable workflows, learned patterns, project procedures, or tool-specific guidance.
---

# Socrates Skill Writer

## Workflow

1. Make the skill narrow: one repeatable workflow, domain, tool pattern, or project procedure.
2. Write frontmatter with a lowercase hyphenated `name` matching the folder and a trigger-focused `description`.
3. Keep `SKILL.md` short and procedural. Put only what Socrates must know after the skill triggers.
4. Move detailed examples, schemas, or long references into one-level `references/` files and link them from `SKILL.md`.
5. Use `scripts/` only for deterministic commands that are safer to run than rewrite.
6. Use `assets/` only for files consumed by outputs, not extra documentation.

## Rules

- Treat the current user request as primary when generating a project skill.
- Use project docs only as side guidance; ignore them when they do not help the requested skill.
- Do not include secrets, credentials, private keys, or long copied project text.
- Do not add README, installation guides, changelogs, or auxiliary docs.
- Prefer concise examples over broad explanations.

## Template

```markdown
---
name: example-skill
description: Use when Socrates needs to perform this exact reusable workflow or apply this specialized pattern.
---

# Example Skill

## Workflow

1. Inspect the relevant inputs.
2. Apply the project-specific or tool-specific rule.
3. Verify the result with the smallest meaningful check.

## Notes

- Keep this section short.
- Link to `references/details.md` only when extra detail is genuinely useful.
```
