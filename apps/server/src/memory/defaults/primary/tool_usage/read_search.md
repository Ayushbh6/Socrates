# read and search

Use `search` to find candidate files or lines, then `read` the exact files needed for evidence.

## search

- `mode: "files"` finds paths.
- `mode: "text"` finds content.
- Set `regex: true` only when the query is intended as a regular expression.
- Keep searches scoped with `path` when the repo is large.

## read

Read bounded output with `charLimit` or `tokenLimit` when files may be large. Re-read with offsets or a larger limit when truncation hides the needed lines.

Use `list_project_resources` before reading uploaded resources when the exact resource path is unknown.
