/** Start Socrates: `pnpm server` (architecture/server.md). */
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
    // Cancel work while the listener drains, closing both even on failure.
    const results = await Promise.allSettled([runtime?.close(), app?.close()]);
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
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
    console.log(`Socrates is running. Open http://${HOST}:${config.port}/auth?token=${token}`);
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

await main();
