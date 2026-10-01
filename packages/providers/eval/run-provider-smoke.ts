import {readFileSync} from "node:fs";
import {parseEnv} from "node:util";
import {makeModel, PROVIDER_DEFAULTS, type Provider} from "../src";
import {verifyProviderToolRoundTrip} from "./tool-round-trip";

if (process.env.SOCRATES_ENV_FILE) {
  const values = parseEnv(readFileSync(process.env.SOCRATES_ENV_FILE, "utf8"));
  for (const key of Object.values(PROVIDER_DEFAULTS).flatMap(d => [...d.keys])) if (!process.env[key] && values[key]) process.env[key] = values[key];
}
const provider = process.env.SOCRATES_PROVIDER ?? "gemini";
const defaults = PROVIDER_DEFAULTS[provider as Provider];
if (!defaults) throw new Error("Unknown provider.");
verifyProviderToolRoundTrip(makeModel(provider, process.env.SOCRATES_ROUTER_MODEL ?? defaults.router)).then(result => console.log(JSON.stringify({pass: true, ...result})), error => {console.error(error instanceof Error ? error.message : "Provider smoke failed."); process.exitCode = 1;});
