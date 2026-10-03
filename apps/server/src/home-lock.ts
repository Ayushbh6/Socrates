import { chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** An OS-backed SQLite lock: released even after SIGKILL, with no stale PID race.
 * Acquire before opening/recovering the ledger or connecting any services. */
export function lockHome(home: string): () => void {
  const file = path.join(home, ".server-lock.db");
  const lock = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5) throw new Error(`Socrates is already using ${home}. Stop that server before starting another.`);
    throw error;
  }
  return () => lock.close();
}
