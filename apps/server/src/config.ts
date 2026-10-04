import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
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
  /** Images the user attached to messages, by content hash. */
  attachmentsDir: string;
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
    attachmentsDir: path.join(home, "attachments"),
  };
}

/**
 * Create the data folder, readable only by the user. A folder that holds
 * Socrates 0.1's database is refused: on macOS `~/.Socrates` and `~/.socrates`
 * are one folder, and this Socrates must never read or write that one.
 */
export function prepareHome(config: ServerConfig): void {
  // Resolve existing ancestors too, so aliases and a new subfolder of the old
  // home cannot bypass the 0.1 guard. Check before creating or changing anything.
  const home = canonicalPath(config.home);
  const userHome = realpathSync(homedir());
  if (userHome === home || userHome.startsWith(`${home}${path.sep}`) || home === path.parse(home).root) {
    throw new Error("Choose a dedicated data folder with SOCRATES_HOME, not your home folder or its ancestors.");
  }
  assertSeparateFromClassic(home);
  for (const relative of ["logs", "logs/server.log", "logs/server.log.1", "ledger.db", "ledger.db-wal", "ledger.db-shm", "ledger.db.lance", "settings.json", ".env", "mcp.json", "skills", ".server-lock.db", ".server-lock.db-journal"]) {
    const file = path.join(home, relative);
    try {
      if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} must not be a symbolic link. Choose a separate data folder.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  chmodSync(config.home, 0o700);
  mkdirSync(path.dirname(config.logPath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(config.logPath), 0o700);
  for (const file of [config.keysPath, config.settingsPath, config.logPath]) if (existsSync(file)) chmodSync(file, 0o600);
}

/** The real path even when its last components have not been created yet. */
function canonicalPath(input: string): string {
  if (existsSync(input)) return realpathSync(input);
  const parent = path.dirname(input);
  return parent === input ? input : path.join(canonicalPath(parent), path.basename(input));
}

export function assertSeparateFromClassic(folder: string): void {
  const classic = path.join(realpathSync(homedir()), ".socrates");
  const name = process.platform === "darwin" ? folder.toLowerCase() : folder;
  const old = process.platform === "darwin" ? classic.toLowerCase() : classic;
  if (name === old || name.startsWith(`${old}${path.sep}`)) throw new Error(`${folder} belongs to Socrates 0.1. Choose another folder.`);
  for (let dir = folder; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "socrates.sqlite"))) throw new Error(`${folder} belongs to Socrates 0.1 (it holds socrates.sqlite). Choose another folder.`);
    if (path.dirname(dir) === dir) break;
  }
}
