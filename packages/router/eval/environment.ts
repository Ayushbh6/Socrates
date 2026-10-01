import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { PROVIDER_DEFAULTS } from "@socrates/providers";

/** Load only known provider keys and configuration. Values are never logged. */
export function loadEvaluationEnvironment(): void {
  if (!process.env.SOCRATES_ENV_FILE) return;
  const values = parseEnv(readFileSync(process.env.SOCRATES_ENV_FILE, "utf8"));
  for (const key of [...Object.values(PROVIDER_DEFAULTS).flatMap(d => [...d.keys]), "SOCRATES_PROVIDER", "SOCRATES_ROUTER_MODEL", "SOCRATES_MAIN_MODEL"]) {
    if (!process.env[key] && values[key]) process.env[key] = values[key];
  }
}
