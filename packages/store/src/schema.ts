/**
 * SQLite schema for the event log and the ledger (Goal-router.md, "The ledger").
 *
 * - `events` is the append-only source of truth. Triggers reject UPDATE and DELETE.
 * - `goals` and `tasks` are current projections. Every change to a goal note or a
 *   task's ledger fields appends a row to the matching *_revisions table in the
 *   same transaction, so no prior state is ever rewritten.
 * - `turns` binds each user message to a goal, task, and chat. A compound message
 *   produces one turn per part; all of them point at the same stored user event.
 * - `ledger_fts` is a derived full-text index over goal and task metadata used by
 *   router candidate retrieval and `ledger_query`.
 * - `evidence` numbers every working-agent tool call within its task; the
 *   number is the call's permanent `eN` handle (agent-harness.md, "inspect").
 * - `file_observations` holds the content hash each task last observed per
 *   path, for the stale-edit check.
 * - `exchange_fts` is a derived full-text index over completed Q&A pairs used
 *   by `context_retrieve search`.
 * - `active_capabilities` is the goal-scoped active Skill and MCP set.
 * - `history_records` holds each task's history checkpoints and handover
 *   capsules under their task-scoped handles `hc-N`.
 * - `lanes` are the parallel lanes; a turn's `lane_id` is the lane it ran in,
 *   null for the main conversation.
 * - `memories` holds what Socrates remembers about the user (agent-harness.md,
 *   "Memory"), numbered as permanent handles `mN`; a forgotten entry keeps its
 *   row with `forgotten_at` set.
 */
export const SCHEMA_VERSION = 7;

/**
 * In-place upgrades from older schema versions, keyed by the version they
 * upgrade from. Added columns are nullable, so existing rows stay valid and
 * restoration of older event logs projects them as null.
 */
export const MIGRATIONS: Record<number, string> = {
  1: `
ALTER TABLE goals ADD COLUMN objective TEXT;
ALTER TABLE tasks ADD COLUMN completion_criteria TEXT;
ALTER TABLE task_revisions ADD COLUMN completion_criteria TEXT;
`,
  // Version 3 adds only new tables, which SCHEMA_SQL creates with IF NOT EXISTS.
  2: "",
  // Version 4 adds history_records, also created by SCHEMA_SQL.
  3: "",
  // Version 5 adds lanes (created by SCHEMA_SQL) and each turn's lane.
  4: "ALTER TABLE turns ADD COLUMN lane_id TEXT;",
  // Version 6 adds archiving: a goal or task with a time here is hidden everywhere but the archive.
  5: "ALTER TABLE goals ADD COLUMN archived_at TEXT; ALTER TABLE tasks ADD COLUMN archived_at TEXT;",
  // Version 7 adds memories, created by SCHEMA_SQL.
  6: "",
};

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  id       TEXT NOT NULL UNIQUE,
  type     TEXT NOT NULL,
  at       TEXT NOT NULL,
  goal_id  TEXT,
  task_id  TEXT,
  chat_id  TEXT,
  turn_id  TEXT,
  payload  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_task ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS events_by_turn ON events(turn_id, seq);
CREATE INDEX IF NOT EXISTS events_by_type ON events(type, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  root_path  TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id            TEXT PRIMARY KEY,
  goal_number   INTEGER NOT NULL UNIQUE,
  workspace_id  TEXT REFERENCES workspaces(id),
  title         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('open', 'completed', 'superseded')),
  is_general    INTEGER NOT NULL DEFAULT 0 CHECK (is_general IN (0, 1)),
  objective     TEXT,
  note          TEXT,
  note_revision INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS goals_single_general ON goals(is_general) WHERE is_general = 1;

CREATE TABLE IF NOT EXISTS goal_note_revisions (
  goal_id    TEXT NOT NULL REFERENCES goals(id),
  revision   INTEGER NOT NULL,
  note       TEXT NOT NULL,
  event_id   TEXT NOT NULL REFERENCES events(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (goal_id, revision)
);
CREATE TRIGGER IF NOT EXISTS goal_note_revisions_no_update BEFORE UPDATE ON goal_note_revisions
  BEGIN SELECT RAISE(ABORT, 'revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS goal_note_revisions_no_delete BEFORE DELETE ON goal_note_revisions
  BEGIN SELECT RAISE(ABORT, 'revisions are append-only'); END;

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  goal_id           TEXT NOT NULL REFERENCES goals(id),
  task_number       INTEGER NOT NULL,
  title             TEXT NOT NULL,
  objective         TEXT NOT NULL,
  completion_criteria TEXT,
  status            TEXT NOT NULL CHECK (status IN ('open', 'completed', 'superseded')),
  is_general        INTEGER NOT NULL DEFAULT 0 CHECK (is_general IN (0, 1)),
  continuation_note TEXT,
  revision          INTEGER NOT NULL,
  started_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  archived_at       TEXT,
  UNIQUE (goal_id, task_number)
);
CREATE INDEX IF NOT EXISTS tasks_by_updated ON tasks(updated_at);

CREATE TABLE IF NOT EXISTS task_revisions (
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  revision          INTEGER NOT NULL,
  title             TEXT NOT NULL,
  objective         TEXT NOT NULL,
  completion_criteria TEXT,
  status            TEXT NOT NULL,
  continuation_note TEXT,
  event_id          TEXT NOT NULL REFERENCES events(id),
  created_at        TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
);
CREATE TRIGGER IF NOT EXISTS task_revisions_no_update BEFORE UPDATE ON task_revisions
  BEGIN SELECT RAISE(ABORT, 'revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_revisions_no_delete BEFORE DELETE ON task_revisions
  BEGIN SELECT RAISE(ABORT, 'revisions are append-only'); END;

CREATE TABLE IF NOT EXISTS chats (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  ordinal          INTEGER NOT NULL,
  continuation_of  TEXT REFERENCES chats(id),
  handover_ref     TEXT,
  compaction_count INTEGER NOT NULL DEFAULT 0,
  opened_at        TEXT NOT NULL,
  closed_at        TEXT,
  UNIQUE (task_id, ordinal)
);

CREATE TABLE IF NOT EXISTS history_records (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  number     INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('checkpoint', 'handover')),
  chat_id    TEXT NOT NULL REFERENCES chats(id),
  turn_id    TEXT,
  from_turn  INTEGER NOT NULL,
  to_turn    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  mechanical INTEGER NOT NULL,
  event_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, number)
);

CREATE TABLE IF NOT EXISTS turns (
  id                   TEXT PRIMARY KEY,
  project_turn         INTEGER NOT NULL UNIQUE,
  kind                 TEXT NOT NULL CHECK (kind IN ('task', 'clarification')),
  goal_id              TEXT REFERENCES goals(id),
  task_id              TEXT REFERENCES tasks(id),
  chat_id              TEXT REFERENCES chats(id),
  part_order           INTEGER,
  user_event_id        TEXT NOT NULL REFERENCES events(id),
  response_event_id    TEXT REFERENCES events(id),
  workspace_confidence TEXT CHECK (workspace_confidence IN ('high', 'low')),
  gate_armed           INTEGER NOT NULL DEFAULT 0 CHECK (gate_armed IN (0, 1)),
  status               TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'interrupted')),
  created_at           TEXT NOT NULL,
  completed_at         TEXT,
  lane_id              TEXT,
  CHECK (kind = 'clarification' OR (goal_id IS NOT NULL AND task_id IS NOT NULL AND chat_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS turns_by_task ON turns(task_id, project_turn);
CREATE INDEX IF NOT EXISTS turns_by_user_event ON turns(user_event_id, project_turn);

CREATE TABLE IF NOT EXISTS lanes (
  id          TEXT PRIMARY KEY,
  lane_number INTEGER NOT NULL UNIQUE,
  opened_at   TEXT NOT NULL,
  closed_at   TEXT
);

CREATE TABLE IF NOT EXISTS anchors (
  id         TEXT PRIMARY KEY,
  goal_id    TEXT NOT NULL REFERENCES goals(id),
  path       TEXT NOT NULL,
  role       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('provisional', 'active', 'superseded')),
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (goal_id, path, role)
);

CREATE TABLE IF NOT EXISTS task_facts (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  kind       TEXT NOT NULL CHECK (kind IN ('file_changed', 'command', 'test', 'capability')),
  value      TEXT NOT NULL,
  event_id   TEXT NOT NULL REFERENCES events(id),
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS ledger_fts USING fts5(
  entity UNINDEXED,
  entity_id UNINDEXED,
  goal_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS evidence (
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  number           INTEGER NOT NULL,
  call_id          TEXT NOT NULL,
  tool             TEXT NOT NULL,
  turn_id          TEXT REFERENCES turns(id),
  call_event_id    TEXT NOT NULL REFERENCES events(id),
  result_event_id  TEXT REFERENCES events(id),
  status           TEXT CHECK (status IN ('ok', 'error')),
  created_at       TEXT NOT NULL,
  PRIMARY KEY (task_id, number)
);
CREATE INDEX IF NOT EXISTS evidence_by_turn ON evidence(turn_id, number);

CREATE TABLE IF NOT EXISTS file_observations (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  path       TEXT NOT NULL,
  hash       TEXT,
  event_id   TEXT NOT NULL REFERENCES events(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, path)
);

CREATE TABLE IF NOT EXISTS active_capabilities (
  goal_id      TEXT NOT NULL REFERENCES goals(id),
  kind         TEXT NOT NULL CHECK (kind IN ('skill', 'mcp')),
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  digest       TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  PRIMARY KEY (goal_id, name)
);

CREATE TABLE IF NOT EXISTS memories (
  id             TEXT PRIMARY KEY,
  number         INTEGER NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('about', 'preference', 'knowledge')),
  goal_id        TEXT REFERENCES goals(id),
  text           TEXT NOT NULL,
  author         TEXT NOT NULL,
  source_turn_id TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  forgotten_at   TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS exchange_fts USING fts5(
  turn_id UNINDEXED,
  task_id UNINDEXED,
  goal_id UNINDEXED,
  user_text,
  response_text,
  tokenize = 'porter unicode61'
);
`;
