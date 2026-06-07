# Read Tools Usage Guide

This guide covers Socrates' evidence-gathering tools for current workspace files and known project resources:

- `read`
- `search`
- `list_project_resources`

Use these tools before editing, answering questions about files, inspecting uploaded resources, and narrowing a repo investigation.

## Core Principle

Read current evidence before reasoning from memory. Bounded reads and targeted searches prevent stale assumptions and context bloat.

## Tool Roles

| Tool | Purpose | Best For |
| --- | --- | --- |
| `read` | Open a known file, directory, document, image, or structured artifact | Exact current content and metadata |
| `search` | Find files or text in the workspace | Discovery, grep-style lookup, code references |
| `list_project_resources` | List Socrates-known uploaded resources | Uploaded PDFs, docs, images, files under `.socrates/resources/` |

## `read`

Use `read` when you know the path or have a likely path from search/resource listing.

### Parameter Reference

| Parameter | Meaning | Required | Use When |
| --- | --- | --- | --- |
| `path` | Workspace-relative or allowed known path | yes | Open a file, directory, resource, or attachment path. |
| `offset` | Character offset into extracted output | no | Continue reading a truncated large file. |
| `charLimit` | Character output cap up to 80,000 chars | no | Bound or expand file output; still limited by `tokenLimit`. |
| `tokenLimit` | Estimated token output cap, default 4,000 and max 6,000 | no | Keep large file, PDF, document, presentation, spreadsheet, or SVG reads cost-safe. |

The effective returned text is bounded by both `charLimit` and `tokenLimit`. If neither is supplied, `read` uses the default estimated 4,000-token cap. If `tokenLimit` is supplied, it cannot exceed 6,000 estimated tokens.

### Read A File

```json
{
  "path": "src/index.ts",
  "charLimit": 20000
}
```

### Read With Offset

```json
{
  "path": "large.log",
  "offset": 20000,
  "charLimit": 20000,
  "tokenLimit": 6000
}
```

Use offsets for large files instead of asking for the whole file. Use `tokenLimit` when you need a predictable model-context budget; use `charLimit` when you are paging by character offset.

### Read A Directory

```json
{
  "path": "src"
}
```

Directory reads return bounded entries and metadata.

### Read Documents And Images

`read` can inspect supported PDFs, documents, presentations, spreadsheets, and images with bounded extraction or metadata. Extracted text from PDFs, documents, presentations, spreadsheets, SVGs, and normal files is subject to the same default 4,000-token and max 6,000-token estimated cap.

Use it for:

- uploaded files after `list_project_resources`
- known screenshot/attachment paths
- docs that need exact local extraction
- image files when the model did not receive native visual input

## `read` Output Fields

Important fields:

- `kind`: file type or directory.
- `content`: extracted text when available.
- `entries`: directory entries.
- `contentHash`: full-file hash used by the harness for later edit freshness.
- `mtimeMs`: modification time.
- `sizeBytes`: file size.
- `truncation`: whether output was cut.
- `warnings`: extraction or truncation caveats.

If `truncation.truncated` is true, re-read with offset and a focused `charLimit`/`tokenLimit` before relying on missing sections.

## `search`

Use `search` to discover paths or find text references.

### Parameter Reference

| Parameter | Meaning | Required | Use When |
| --- | --- | --- | --- |
| `mode` | `"files"` or `"text"` | yes | Choose path/name discovery or content search. |
| `query` | Filename/text/regex query | yes | Find files or text. |
| `path` | Directory or file scope | no | Narrow noisy searches. |
| `regex` | Treat query as regex | no | Query contains regex syntax. |
| `caseSensitive` | Case-sensitive matching | no | Case matters for the search. |
| `includeHidden` | Include hidden paths | no | Need `.socrates`, dotfiles, or hidden config. |
| `maxResults` | Result cap, max 50 | no | Keep output focused. |
| `charLimit` | Output cap, max 80,000 | no | Bound returned match text. |

### File Search

```json
{
  "mode": "files",
  "query": "memoryStore",
  "maxResults": 20
}
```

Use for:

- finding file names
- locating modules
- discovering docs
- narrowing likely paths before `read`

### Text Search

```json
{
  "mode": "text",
  "query": "runSocratesMemoryTool",
  "path": "apps/server/src",
  "maxResults": 20
}
```

Use path whenever possible. Whole-workspace text searches should be rare and targeted.

### Regex Search

Set `regex: true` when using regex syntax:

```json
{
  "mode": "text",
  "query": "memory\\.agent\\.(started|completed|failed)",
  "path": "apps/server/src",
  "regex": true,
  "maxResults": 20
}
```

If a literal search with regex-looking characters fails, retry with simpler terms or `regex: true`.

## `search` Output Fields

Important fields:

- `matches`: file or text matches.
- `line`: text-match line number.
- `text`: matched line or excerpt.
- `totalMatches`: count before truncation.
- `truncation`: output cap status.
- `warnings`: noise or narrowing advice.

After search, read the relevant files. Do not make code changes from a search line alone unless the change is trivial and context is already known.

## `list_project_resources`

Use `list_project_resources` when the user asks about uploaded project resources or files in the Socrates Resources panel.

### Parameter Reference

| Parameter | Meaning | Required | Use When |
| --- | --- | --- | --- |
| `kind` | Optional project resource kind | no | Narrow to documents, images, text, links, or other resource classes when known. |
| `limit` | Max resources to return, max 100 | no | Bound resource listing. |

```json
{
  "kind": "document",
  "limit": 25
}
```

Fields:

- `kind`: optional resource kind filter.
- `limit`: maximum resources to list.

Then use `read` on the resource path or URI returned by the tool when content inspection is needed.

## Resources Vs Attachments

Project resources and chat attachments are different.

### Project resources

- Stored under `.socrates/resources/`.
- Tracked as reusable project resources.
- Listed with `list_project_resources`.
- Good for PDFs, docs, images, text notes, user-uploaded resource files.

### Chat attachments

- Stored under `.socrates/attachments/`.
- Attached to specific chat messages.
- Not listed with `list_project_resources`.
- Use `trace_retrieve` first for conversation provenance.
- Use `search`/`read` only after provenance is unavailable or a path is known.

Never use `list_project_resources` for chat screenshots.

## Investigation Workflow

### When asked to explain code

1. `search` for likely files/symbols.
2. `read` the relevant files.
3. Answer with current code references.

### When asked to change code

1. `search` to find files.
2. `read` files before mutation.
3. Use `edit` or `apply_patch`.
4. Verify with Terminal.

### When asked about an uploaded PDF or doc

1. `list_project_resources`.
2. `read` the specific resource.
3. If truncated, page with offset or increase `charLimit`.
4. Answer with extraction caveats if any.

### When asked about an older screenshot

1. Use `trace_retrieve` to find original message provenance.
2. If the attachment path is returned, `read` that path.
3. If no provenance is found, search `.socrates/attachments/` only as retained-file evidence.
4. Do not invent the deleted source conversation.

## Common Patterns

### Find a function

```json
{
  "mode": "text",
  "query": "function buildMemoryAgentInput",
  "path": "apps/server/src",
  "maxResults": 20
}
```

Then:

```json
{
  "path": "apps/server/src/services/store/memoryStore.ts",
  "charLimit": 30000
}
```

### Find docs

```json
{
  "mode": "files",
  "query": "repo_docs",
  "maxResults": 20
}
```

### Inspect package scripts

```json
{
  "path": "package.json"
}
```

### Read around a large file

If the first read is truncated:

```json
{
  "path": "large-file.ts",
  "offset": 30000,
  "charLimit": 20000
}
```

## Anti-Patterns

Avoid:

- broad whole-repo text searches without path when a folder is known
- reading huge generated files
- reading lockfiles unless dependency resolution is the task
- using Terminal `cat` when `read` works
- using Terminal `grep` when `search` works
- assuming old memory is current when `read` is cheap
- relying on snippets when exact source context matters

## Handling Missing Or Truncated Data

If `read` says missing:

- Search for the file name.
- Check path casing.
- Check generated/build output versus source path.
- Ask only if the target cannot be discovered.

If output is truncated:

- Re-read with offset.
- Increase `charLimit` within safe bounds.
- Search within the file for anchors.
- Read a narrower related file if possible.

If document extraction is weak:

- Say extraction may be incomplete.
- Use additional local tools only if appropriate and approved.
- Do not fabricate content absent from extraction.

## FAQ

### Should I use `read` or `search` first?

Use `read` when you already know the path. Use `search` when discovering paths, symbols, or text locations.

### Should I use `list_project_resources` or `search`?

Use `list_project_resources` for uploaded project resources. Use `search` for workspace source files and chat attachment paths only when needed.

### Can I rely on memory instead of reading?

Not when current file state matters. Read current files before explaining or editing them.

### What if search returns too many results?

Narrow by `path`, simplify the query, reduce `maxResults`, or search for a more specific symbol/string.

### What if a file is too large?

Use `offset`, a smaller `charLimit`, or a text search for anchors before reading focused sections.

## Good Final Answer Pattern

```text
I checked <files/resources>.

The relevant code is in <path>. It does <summary>.
```

For resource answers:

```text
I found the uploaded resource <name> and read it. The relevant section says <summary>. Extraction was <complete/truncated>.
```

For missing evidence:

```text
I searched <scope/path> and did not find <target>. The closest current evidence is <path>, but it does not prove <claim>.
```

## Checklist Before Editing

- Did I read the file I am about to mutate?
- Did I inspect enough surrounding context?
- Did I avoid generated/vendor outputs?
- Did I use `list_project_resources` for uploaded resources?
- Did I use `trace_retrieve` for older conversation provenance?
- Did I page or narrow instead of dumping excessive content?
