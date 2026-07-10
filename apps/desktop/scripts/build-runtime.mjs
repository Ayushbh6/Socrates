import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.SOCRATES_RUNTIME_OUTPUT_DIR ??= path.join(desktopRoot, "runtime");
process.env.SOCRATES_RUNTIME_KIND ??= "desktop";

await import("../../../scripts/runtime/build-runtime.mjs");
