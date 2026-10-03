import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { PROVIDER_DEFAULTS } from "@socrates/providers";

/** The API keys the data folder's `.env` may hold; nothing else is read from or written to it. */
export const KEY_NAMES: readonly string[] = [...new Set([...Object.values(PROVIDER_DEFAULTS).flatMap((d) => [...d.keys]), "SOCRATES_EMBEDDINGS_API_KEY"])];

/** Printable, without spaces or quotes, so it round-trips through `.env`. */
const KEY_VALUE = /^[\x21\x23-\x26\x28-\x7e]{1,500}$/;

export function readKeys(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values = parseEnv(readFileSync(file, "utf8"));
  return Object.fromEntries(KEY_NAMES.flatMap((name) => (values[name] ? [[name, values[name]!]] : [])));
}

/** Set (or with null, remove) one key. The file is readable only by the user. */
export function writeKey(file: string, name: string, value: string | null): void {
  if (!KEY_NAMES.includes(name)) throw new KeyError(`Unknown key ${name}. Known keys: ${KEY_NAMES.join(", ")}.`);
  if (value !== null && !KEY_VALUE.test(value)) throw new KeyError("A key is one line of printable characters without spaces or quotes.");
  const keys = readKeys(file);
  if (value === null) delete keys[name];
  else keys[name] = value;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, Object.entries(keys).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export class KeyError extends Error {
  override name = "KeyError";
}
