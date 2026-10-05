import { existsSync, readFileSync } from "node:fs";
import { EFFORTS } from "@socrates/contracts";
import { PROVIDER_DEFAULTS } from "@socrates/providers";
import { z } from "zod";
import { writePrivateFile } from "./private-file";

const PROVIDERS = Object.keys(PROVIDER_DEFAULTS) as [keyof typeof PROVIDER_DEFAULTS, ...(keyof typeof PROVIDER_DEFAULTS)[]];

const ModelChoice = z.object({ provider: z.enum(PROVIDERS), model: z.string().trim().min(1).max(200) }).strict();
/** The chat model, with the thinking level the user chose for it (null or absent: Socrates' default for the model). */
const ChatChoice = ModelChoice.extend({ effort: z.enum(EFFORTS).nullable().optional() }).strict();

const TimeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "Use an IANA time zone such as Europe/Berlin.");

/** At most this many folders in "My folders". */
export const MAX_ACCESS_FOLDERS = 50;

/**
 * Where Socrates may work and when it asks (architecture/server.md, "Access"):
 * - scope: "folders" limits file tools to `folders` (any other path asks);
 *   "full" allows any path except Socrates' own data;
 * - approvals: "ask" approves every edit, patch, command and changing MCP
 *   call first; "auto" runs them without asking.
 */
export const Access = z.object({
  scope: z.enum(["folders", "full"]),
  folders: z.array(z.string().min(1)).max(MAX_ACCESS_FOLDERS),
  approvals: z.enum(["ask", "auto"]),
}).strict();
export type Access = z.infer<typeof Access>;

/**
 * The user's choices (architecture/server.md, "Settings"). API keys are not
 * settings: they live in the data folder's `.env` and are never returned.
 * - chat / router: null picks the first provider with a key, and its defaults;
 *   chat.effort: the thinking level, which applies to the next model request without a restart;
 * - embeddings: local Ollama with embeddinggemma unless changed;
 * - timeZone: null follows the Mac;
 * - workingFolder: the workspace new work is bound to, or null; choosing it adds its folder to `access`;
 * - access: where Socrates may work and when it asks; by default only the user's folders, asking first.
 */
export const Settings = z.object({
  chat: ChatChoice.nullable().default(null),
  router: ModelChoice.nullable().default(null),
  embeddings: z.object({
    provider: z.enum(["ollama", "openrouter", "openai", "custom"]),
    model: z.string().trim().min(1).max(200).nullable(),
    url: z.url().refine((value) => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }, "Use an HTTP or HTTPS base URL without credentials, query parameters or a fragment.").nullable(),
  }).strict().default({ provider: "ollama", model: null, url: null }),
  timeZone: TimeZone.nullable().default(null),
  workingFolder: z.string().min(1).nullable().default(null),
  access: Access.default({ scope: "folders", folders: [], approvals: "ask" }),
}).strict();
export type Settings = z.infer<typeof Settings>;

/** What PUT /api/settings accepts: any subset of the settings, and of `access`. */
export const SettingsPatch = Settings.partial().extend({ access: Access.partial().strict().optional() }).strict();

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
  writePrivateFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}
