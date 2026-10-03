import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Atomic private writes with exclusive, unpredictable temp files, so a
 * pre-existing temp file cannot change permissions or redirect the write. */
export function writePrivateFile(file: string, content: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } finally {
    try { unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
