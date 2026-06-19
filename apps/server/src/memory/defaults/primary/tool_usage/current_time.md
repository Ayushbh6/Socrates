# current_time Usage Guide

`current_time` reads the backend-owned current date, ISO timestamp, and resolved time zone.

It takes no input and is read-only.

## When To Use

Use `current_time` when the current date or exact time affects the answer or artifact:

- Date-sensitive final answers.
- Dated filenames, logs, changelog entries, or release notes.
- Memory, project notes, or repo docs prose that truly needs today's date.
- Any situation where older docs or prior conversation state might contain a stale date.

## Correct Flow

Call with an empty object:

```json
{}
```

Expected output shape:

```json
{
  "currentDate": "2026-06-19",
  "currentDateTime": "2026-06-19T09:30:00.000Z",
  "timeZone": "Europe/Vienna",
  "source": "system"
}
```

## Rules

- Do not infer today's date from project docs, repo docs, state ledgers, filenames, or previous conversations.
- Do not ask the user for the current date/time when this tool is available.
- Do not use `current_time` when no date/time fact is needed.
- Prefer backend-owned docs frontmatter stamps over manually writing dates into docs prose when a human-readable date is not necessary.

## Failure Handling

If `current_time` fails, avoid making date-sensitive claims. Say the current date/time tool failed and proceed only with non-date-sensitive work.
