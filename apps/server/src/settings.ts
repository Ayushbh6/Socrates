import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { PROVIDER_DEFAULTS } from "@socrates/providers";
import { z } from "zod";

const PROVIDERS = Object.keys(PROVIDER_DEFAULTS) as [keyof typeof PROVIDER_DEFAULTS, ...(keyof typeof PROVIDER_DEFAULTS)[]];

const ModelChoice = z.object({ provider: z.enum(PROVIDERS), model: z.string().trim().min(1).max(200) }).strict();

const TimeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "Use an IANA time zone such as Europe/Berlin.");

/**
 * The user's choices (architecture/server.md, "Settings"). API keys are not
 * settings: they live in the data folder's `.env` and are never returned.
 * - chat / router: null picks the first provider with a key, and its defaults;
 * - embeddings: local Ollama with embeddinggemma unless changed;
 * - timeZone: null follows the Mac;
 * - workingFolder: the workspace new work is bound to, or null.
 */
export const Settings = z.object({
  chat: ModelChoice.nullable().default(null),
  router: ModelChoice.nullable().default(null),
  embeddings: z.object({
    provider: z.enum(["ollama", "openrouter", "openai", "custom"]),
    model: z.string().trim().min(1).max(200).nullable(),
    url: z.url().nullable(),
  }).strict().default({ provider: "ollama", model: null, url: null }),
  timeZone: TimeZone.nullable().default(null),
  workingFolder: z.string().nullable().default(null),
}).strict();
export type Settings = z.infer<typeof Settings>;

/** What PUT /api/settings accepts: any subset of the settings. */
export const SettingsPatch = Settings.partial().strict();

export function loadSettings(file: string): Settings {
  if (!existsSync(file)) return Settings.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it or delete it to start from the defaults.`);
  }
  const parsed = Settings.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** Written whole and swapped in, so a crash never leaves half a file. */
export function saveSettings(file: string, settings: Settings): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
