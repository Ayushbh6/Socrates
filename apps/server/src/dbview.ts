import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import type { ServerConfig } from "./config";

/**
 * A read-only look into Socrates' own databases (architecture/observability.md,
 * "The database view"): which tables exist, how many records they hold, and
 * the rows themselves. Only the two databases below can be opened, only for
 * reading, and a table or column is used only if the database itself lists
 * it, so no name from a request ever reaches a query unchecked.
 */
export const DATABASES = {
  ledger: { label: "Ledger", about: "The append-only event log and the goals, tasks, turns and evidence built from it.", file: (c: ServerConfig) => c.dbPath },
  calls: { label: "Model calls", about: "Every model call: its request, reply, timing, cache and cost.", file: (c: ServerConfig) => c.callsPath },
} as const;
export type DbId = keyof typeof DATABASES;
export const isDb = (id: string): id is DbId => Object.hasOwn(DATABASES, id);

export interface TableInfo {
  name: string;
  /** "internal" for the shadow tables of a full-text index and SQLite's own. */
  kind: "table" | "virtual" | "internal";
  rows: number;
  columns: number;
}

export interface DbOverview {
  id: DbId;
  label: string;
  about: string;
  bytes: number;
  tables: TableInfo[];
  records: number;
}

export interface FileInfo {
  name: string;
  about: string;
  bytes: number;
  /** How many files, for a folder. */
  files: number | null;
}

export interface DataOverview {
  databases: DbOverview[];
  totals: { databases: number; tables: number; records: number; bytes: number };
  files: FileInfo[];
  /** Documents in the embedding index, or null when memory search is off. */
  index: { documents: number } | null;
}

export class DbError extends Error {
  override name = "DbError";
}

const INTERNAL = /^(sqlite_|(ledger_fts|exchange_fts)_(data|idx|content|docsize|config)$)/;

function open(file: string): DatabaseSync {
  if (!existsSync(file)) throw new DbError("That database does not exist yet.");
  return new DatabaseSync(file, { readOnly: true });
}

function tables(db: DatabaseSync): { name: string; sql: string }[] {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string; sql: string }[];
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function sizeOf(file: string): number {
  let total = 0;
  for (const suffix of ["", "-wal"]) {
    try { total += statSync(file + suffix).size; } catch {}
  }
  return total;
}

/** Bytes and file count of a folder, to a bounded depth. */
function folder(dir: string): { bytes: number; files: number } {
  let bytes = 0, files = 0;
  const walk = (at: string, depth: number) => {
    let entries: string[];
    try { entries = readdirSync(at); } catch { return; }
    for (const name of entries) {
      const full = path.join(at, name);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) { if (depth < 6) walk(full, depth + 1); }
        else { bytes += stat.size; files++; }
      } catch {}
    }
  };
  walk(dir, 0);
  return { bytes, files };
}

export function overview(config: ServerConfig, index: { documents: number } | null): DataOverview {
  const databases: DbOverview[] = [];
  for (const id of Object.keys(DATABASES) as DbId[]) {
    const file = DATABASES[id].file(config);
    if (!existsSync(file)) continue;
    const db = open(file);
    try {
      const list: TableInfo[] = tables(db).map((t) => ({
        name: t.name,
        kind: INTERNAL.test(t.name) ? "internal" : /^CREATE VIRTUAL/i.test(t.sql ?? "") ? "virtual" : "table",
        rows: Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t.name)}`).get() as { n: number }).n),
        columns: (db.prepare(`PRAGMA table_info(${quote(t.name)})`).all() as unknown[]).length,
      }));
      const shown = list.filter((t) => t.kind !== "internal");
      databases.push({ id, label: DATABASES[id].label, about: DATABASES[id].about, bytes: sizeOf(file), tables: list, records: shown.reduce((n, t) => n + t.rows, 0) });
    } finally {
      db.close();
    }
  }
  const plain = (file: string, name: string, about: string): FileInfo | null => existsSync(file) ? { name, about, bytes: sizeOf(file), files: null } : null;
  const dir = (at: string, name: string, about: string): FileInfo | null => {
    if (!existsSync(at)) return null;
    const { bytes, files } = folder(at);
    return { name, about, bytes, files };
  };
  const files = [
    plain(config.settingsPath, "settings.json", "Your choices"),
    dir(config.indexPath, "ledger.db.lance", "The embedding index"),
    dir(config.attachmentsDir, "attachments", "Images you attached"),
    dir(path.dirname(config.logPath), "logs", "Diagnostics"),
  ].filter((f): f is FileInfo => f !== null);
  const bytes = databases.reduce((n, d) => n + d.bytes, 0) + files.reduce((n, f) => n + f.bytes, 0);
  return {
    databases,
    totals: { databases: databases.length, tables: databases.reduce((n, d) => n + d.tables.filter((t) => t.kind !== "internal").length, 0), records: databases.reduce((n, d) => n + d.records, 0) + (index?.documents ?? 0), bytes },
    files,
    index,
  };
}

export interface Column {
  name: string;
  type: string;
  primaryKey: boolean;
}

/** A cell as the page shows it: text, a number, null, or a note about bytes. */
export type Cell = string | number | null;

const GRID_CELL_CHARS = 240;
const ROW_CELL_CHARS = 200_000;

/** A stored value as a cell. Bytes that are compressed text show as that text. */
function cellOf(value: unknown, max: number): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) {
    if (value[0] === 0x1f && value[1] === 0x8b) {
      try {
        const text = gunzipSync(value).toString("utf8");
        return max === GRID_CELL_CHARS ? `‹compressed, ${text.length.toLocaleString("en-US")} characters› ${text.slice(0, max - 40).replace(/\s+/g, " ")}…` : text.length > max ? `${text.slice(0, max)}…` : text;
      } catch {}
    }
    return `‹${value.length.toLocaleString("en-US")} bytes›`;
  }
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeTable(db: DatabaseSync, table: string): Column[] {
  if (!tables(db).some((t) => t.name === table)) throw new DbError("There is no such table.");
  return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string; type: string; pk: number }[]).map((c) => ({ name: c.name, type: c.type || "", primaryKey: c.pk > 0 }));
}

export interface Page {
  columns: Column[];
  /** Each row's rowid, to open it. */
  ids: (number | null)[];
  rows: Cell[][];
  /** Rows in the table, and how many match the search. */
  total: number;
  matched: number;
}

export function browse(config: ServerConfig, id: DbId, table: string, options: { offset: number; limit: number; q?: string; order?: string; dir?: "asc" | "desc" }): Page {
  const db = open(DATABASES[id].file(config));
  try {
    const columns = describeTable(db, table);
    const order = options.order && columns.some((c) => c.name === options.order) ? quote(options.order) : "rowid";
    const dir = options.dir === "asc" ? "ASC" : "DESC";
    const searchable = columns.filter((c) => !/blob/i.test(c.type));
    const q = options.q?.trim();
    const where = q && searchable.length ? `WHERE ${searchable.map((c) => `CAST(${quote(c.name)} AS TEXT) LIKE ? ESCAPE '\\'`).join(" OR ")}` : "";
    const args = q && searchable.length ? searchable.map(() => `%${q.replace(/[\\%_]/g, "\\$&")}%`) : [];
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n);
    const matched = where ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} ${where}`).get(...args) as { n: number }).n) : total;
    const list = columns.map((c) => quote(c.name)).join(", ");
    let rows: Record<string, unknown>[];
    try {
      rows = db.prepare(`SELECT rowid AS __rowid__, ${list} FROM ${quote(table)} ${where} ORDER BY ${order} ${dir} LIMIT ? OFFSET ?`).all(...args, options.limit, options.offset) as Record<string, unknown>[];
    } catch {
      rows = db.prepare(`SELECT ${list} FROM ${quote(table)} ${where} ORDER BY ${order === "rowid" ? quote(columns[0]!.name) : order} ${dir} LIMIT ? OFFSET ?`).all(...args, options.limit, options.offset) as Record<string, unknown>[];
    }
    return {
      columns,
      ids: rows.map((r) => (typeof r.__rowid__ === "number" ? r.__rowid__ : null)),
      rows: rows.map((r) => columns.map((c) => cellOf(r[c.name], GRID_CELL_CHARS))),
      total,
      matched,
    };
  } finally {
    db.close();
  }
}

/** One row whole: every value in full (up to 200,000 characters each), compressed text opened. */
export function row(config: ServerConfig, id: DbId, table: string, rowid: number): { columns: Column[]; values: Cell[] } | null {
  const db = open(DATABASES[id].file(config));
  try {
    const columns = describeTable(db, table);
    const found = db.prepare(`SELECT ${columns.map((c) => quote(c.name)).join(", ")} FROM ${quote(table)} WHERE rowid = ?`).get(rowid) as Record<string, unknown> | undefined;
    return found ? { columns, values: columns.map((c) => cellOf(found[c.name], ROW_CELL_CHARS)) } : null;
  } finally {
    db.close();
  }
}
