/** Start Socrates: `pnpm server`, or `pnpm socrates`, which also builds the web app and opens it (architecture/server.md). */
import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { HOST, resolveConfig } from "./config";
import { buildServer } from "./app";
import { Runtime, redact } from "./runtime";
import { sessionToken } from "./security";

async function main(): Promise<void> {
  const lifetime = new AbortController();
  let runtime: Runtime | undefined;
  let app: FastifyInstance | undefined;
  let stopping: Promise<void> | undefined;
  const close = () => stopping ??= (async () => {
    // The live hub drains cancellation persistence before the ledger closes.
    try { await app?.close(); } finally { await runtime?.close(); }
  })();
  const stop = () => {
    lifetime.abort();
    // During startup, the catch below owns cleanup after open() unwinds.
    if (app) void close().catch((error) => {
      runtime?.log(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const config = resolveConfig();
    runtime = await Runtime.open(config, { signal: lifetime.signal });
    lifetime.signal.throwIfAborted();
    const token = sessionToken();
    app = await buildServer({ runtime, token });
    lifetime.signal.throwIfAborted();
    await app.listen({ host: HOST, port: config.port });
    lifetime.signal.throwIfAborted();
    const link = `http://${HOST}:${config.port}/auth?token=${token}`;
    console.log(`Socrates is running. Open ${link}`);
    if (process.argv.includes("--open")) openBrowser(link);
    console.log(`Data: ${config.home}${runtime.setup.length ? `\nSetup needed: ${runtime.setup.join(" ")}` : ""}`);
  } catch (error) {
    await close();
    if (!lifetime.signal.aborted) {
      const inUse = (error as { code?: string }).code === "EADDRINUSE";
      console.error(inUse ? "The Socrates port is in use. Stop that server or choose another SOCRATES_PORT." : `Socrates could not start: ${redact(error instanceof Error ? error.message : String(error), process.env)}`);
      process.exitCode = 1;
    }
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

/** Open the link in the default browser; if that fails, the printed link still works. */
function openBrowser(link: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [link]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", link]] : ["xdg-open", [link]];
  try {
    spawn(command as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
}

await main();
