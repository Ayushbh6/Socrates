import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** The server listens here only; nothing outside this machine can reach it. */
export const HOST = "127.0.0.1";
/** Beside Socrates 0.1 (4100 and 3100), never on the same port. */
export const DEFAULT_PORT = 4200;

/** Where this Socrates keeps everything (architecture/server.md, "Data folder"). */
export interface ServerConfig {
  home: string;
  port: number;
  dbPath: string;
  indexPath: string;
  settingsPath: string;
  keysPath: string;
  logPath: string;
}

/** `$SOCRATES_HOME` or `~/.socrates-v2`, and `$SOCRATES_PORT` or 4200. */
export function resolveConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const raw = env.SOCRATES_HOME?.trim() || path.join(homedir(), ".socrates-v2");
  const home = path.resolve(raw === "~" || raw.startsWith("~/") ? path.join(homedir(), raw.slice(1)) : raw);
  const port = env.SOCRATES_PORT ? Number(env.SOCRATES_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`SOCRATES_PORT must be a port number, not "${env.SOCRATES_PORT}".`);
  return {
    home,
    port,
    dbPath: path.join(home, "ledger.db"),
    indexPath: path.join(home, "ledger.db.lance"),
    settingsPath: path.join(home, "settings.json"),
    keysPath: path.join(home, ".env"),
    logPath: path.join(home, "logs", "server.log"),
  };
}

/**
 * Create the data folder, readable only by the user. A folder that holds
 * Socrates 0.1's database is refused: on macOS `~/.Socrates` and `~/.socrates`
 * are one folder, and this Socrates must never read or write that one.
 */
export function prepareHome(config: ServerConfig): void {
  if (existsSync(path.join(config.home, "socrates.sqlite"))) {
    throw new Error(`${config.home} belongs to Socrates 0.1 (it holds socrates.sqlite). Choose another folder with SOCRATES_HOME.`);
  }
  mkdirSync(path.dirname(config.logPath), { recursive: true, mode: 0o700 });
}
