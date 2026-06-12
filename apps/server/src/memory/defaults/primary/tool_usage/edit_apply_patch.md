# edit and apply_patch

Use `edit` for one-file changes and `apply_patch` for multi-hunk or multi-file changes.

## edit

Use targeted `oldString` and `newString` replacements for existing files. Use whole-file `content` only for new files or deliberate rewrites with `overwrite: true`.

Read an existing file in the active turn before mutating it. File freshness is tracked by the runtime, not by model-supplied hashes.

## apply_patch

Prefer the structured patch envelope:

```text
*** Begin Patch
*** Update File: path/to/file
@@
 old context
-old line
+new line
*** End Patch
```

Use `*** Add File`, `*** Delete File`, and `*** Move to` for create/delete/rename operations.

## Socrates-owned docs

Do not edit `.socrates/MEMORY.md`, `.socrates/PROJECT_NOTES.md`, or `.socrates/repo_docs/*.md` with generic file tools. Use `project_docs` for memory/notes and `repo_docs` for repo doctrine.

Do not edit `.socrates/skills/**` with generic file tools. Project skills are created through the dashboard `Skills +` builder, and global skills are maintained by the backend memory worker.
