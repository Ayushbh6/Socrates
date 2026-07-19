import fs from "node:fs"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

describe("worker model settings compactor split migration", () => {
  it("copies the legacy compactor selection into both independent roles", () => {
    const sqlite = new Database(":memory:")
    try {
      sqlite.exec(`
        CREATE TABLE worker_model_settings (
          id text PRIMARY KEY NOT NULL,
          worker_id text NOT NULL,
          provider_id text NOT NULL,
          auth_mode text DEFAULT 'api_key' NOT NULL,
          model_id text NOT NULL,
          thinking_enabled integer NOT NULL,
          thinking_effort text,
          created_at text NOT NULL,
          updated_at text NOT NULL,
          metadata_json text
        );
        CREATE UNIQUE INDEX worker_model_settings_worker_idx ON worker_model_settings (worker_id);
      `)
      sqlite.prepare(`
        INSERT INTO worker_model_settings
          (id, worker_id, provider_id, auth_mode, model_id, thinking_enabled, thinking_effort, created_at, updated_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "wms_legacy",
        "context_compactor",
        "google",
        "api_key",
        "gemini-3.5-flash",
        1,
        "low",
        "2026-07-18T00:00:00.000Z",
        "2026-07-19T00:00:00.000Z",
        JSON.stringify({ source: "user_selection" }),
      )

      const migration = fs.readFileSync(new URL("../../drizzle/0028_split_context_compactors.sql", import.meta.url), "utf8")
      sqlite.exec(migration)

      const rows = sqlite.prepare(`
        SELECT worker_id AS workerId, provider_id AS providerId, model_id AS modelId,
               thinking_enabled AS thinkingEnabled, thinking_effort AS thinkingEffort
        FROM worker_model_settings
        ORDER BY worker_id
      `).all()
      expect(rows).toEqual([
        {
          workerId: "memory_context_compactor",
          providerId: "google",
          modelId: "gemini-3.5-flash",
          thinkingEnabled: 1,
          thinkingEffort: "low",
        },
        {
          workerId: "socrates_context_compactor",
          providerId: "google",
          modelId: "gemini-3.5-flash",
          thinkingEnabled: 1,
          thinkingEffort: "low",
        },
      ])
    } finally {
      sqlite.close()
    }
  })
})
