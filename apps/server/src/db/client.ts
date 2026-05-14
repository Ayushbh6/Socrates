import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import * as schema from "./schema"

export type SqliteDatabase = ReturnType<typeof drizzle<typeof schema>>

export type DatabaseHandle = {
  sqlite: Database.Database
  db: SqliteDatabase
  close: () => void
}

const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname

export const ensureDatabaseDirectory = (dbPath: string): void => {
  if (dbPath === ":memory:") {
    return
  }

  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
}

export const openDatabase = (dbPath: string): DatabaseHandle => {
  ensureDatabaseDirectory(dbPath)

  const sqlite = new Database(dbPath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")

  const db = drizzle(sqlite, { schema })

  return {
    sqlite,
    db,
    close: () => sqlite.close(),
  }
}

export const runMigrations = (handle: DatabaseHandle): void => {
  migrate(handle.db, { migrationsFolder })
  handle.sqlite
    .prepare(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
       VALUES (?, ?, ?)`,
    )
    .run(1, "0000_initial_backend_foundation", new Date().toISOString())
}
