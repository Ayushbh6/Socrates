/** Start Socrates: `pnpm server` (architecture/server.md). */
import { HOST, resolveConfig } from "./config";
import { buildServer } from "./app";
import { Runtime } from "./runtime";
import { sessionToken } from "./security";

const config = resolveConfig();
const runtime = await Runtime.open(config);
const token = sessionToken();
const app = await buildServer({ runtime, token });
try {
  await app.listen({ host: HOST, port: config.port });
} catch (error) {
  await runtime.close();
  const inUse = (error as { code?: string }).code === "EADDRINUSE";
  console.error(inUse ? `Port ${config.port} is in use. Is Socrates already running? Set SOCRATES_PORT to use another port.` : `Socrates could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log(`Socrates is running. Open http://${HOST}:${config.port}/auth?token=${token}`);
console.log(`Data: ${config.home}${runtime.setup.length ? `\nSetup needed: ${runtime.setup.join(" ")}` : ""}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // Running work is cancelled and recorded; terminals, MCP servers, and the index are closed.
  await app.close();
  await runtime.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
