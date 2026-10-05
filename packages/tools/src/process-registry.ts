import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * The process groups terminal sessions run in, kept in a small file in the
 * data folder (agent-harness.md, "terminal"). An orderly stop removes each
 * group as it ends; a server that crashed leaves its groups listed, and the
 * next start stops those still running. A group is stopped only when its
 * leader still has the start time recorded for it, so a reused process id
 * never names someone else's process.
 */

interface Entry {
  pid: number;
  /** The leader's start time as `ps` reports it. */
  started: string;
  command: string;
}

function read(file: string): Entry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((e): e is Entry => typeof e?.pid === "number" && typeof e?.started === "string") : [];
  } catch {
    return [];
  }
}

function write(file: string, entries: Entry[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** When a process started, or null when it is not running (or this platform cannot tell). */
export function processStart(pid: number): string | null {
  if (process.platform === "win32") return null;
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  const started = r.status === 0 ? r.stdout.trim() : "";
  return started || null;
}

export function recordProcess(file: string, pid: number, command: string): void {
  const started = processStart(pid);
  if (!started) return;
  try {
    write(file, [...read(file).filter((e) => e.pid !== pid), { pid, started, command: command.slice(0, 200) }]);
  } catch {
    // Cleanup after a crash is a convenience; launching never depends on it.
  }
}

export function forgetProcess(file: string, pid: number): void {
  try {
    const entries = read(file);
    if (entries.some((e) => e.pid === pid)) write(file, entries.filter((e) => e.pid !== pid));
  } catch {
    // As above.
  }
}

/** Stop the process groups a previous server left running, and empty the list. Returns how many were stopped. */
export function reapLeftovers(file: string): number {
  if (!existsSync(file)) return 0;
  let stopped = 0;
  for (const entry of read(file)) {
    if (processStart(entry.pid) !== entry.started) continue;
    try {
      process.kill(-entry.pid, "SIGKILL");
      stopped++;
    } catch {
      // Already gone.
    }
  }
  try {
    write(file, []);
  } catch {
    // As above.
  }
  return stopped;
}
