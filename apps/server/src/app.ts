import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { KEY_NAMES, KeyError } from "./keys";
import { type Runtime, RuntimeBusyError, SettingsError } from "./runtime";
import { guard, problem, sameSecret, sessionCookie } from "./security";
import { FolderError, conversationHistory, goalsView, listFolders, workspaceFolder, workspaceFor } from "./views";

export interface ServerOptions {
  runtime: Runtime;
  /** This launch's session secret. */
  token: string;
}

const History = z.object({
  conversation: z.string().default("main"),
  before: z.coerce.number().int().positive().optional(),
}).strict();

/**
 * The HTTP API (architecture/server.md, "HTTP API"). Every response is JSON;
 * failures are `{ error: { code, message } }` with a message meant for the
 * user. The live connection (sending, approvals, activity) is separate.
 */
export async function buildServer({ runtime, token }: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  });
  app.addHook("onRequest", guard(runtime.config.port, token));
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(problem("not_found", "There is no such route.")));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send(problem("invalid_request", error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ")));
    if (error instanceof RuntimeBusyError) return reply.code(409).send(problem("busy", error.message));
    if (error instanceof KeyError || error instanceof FolderError || error instanceof SettingsError) return reply.code(400).send(problem("invalid_request", error.message));
    const status = (error as { statusCode?: number }).statusCode;
    if ((error as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY") return reply.code(400).send(problem("invalid_request", "The request body must be valid JSON."));
    if (status && status >= 400 && status < 500) return reply.code(status).send(problem("invalid_request", (error as Error).message));
    runtime.log(`request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return reply.code(500).send(problem("internal", "Something went wrong on the server. Details are in the server log."));
  });

  app.get("/api/health", async () => ({ ok: true }));

  // The printed link: exchange the secret for a session cookie, then drop it from the address bar.
  app.get("/auth", async (request, reply) => {
    const { token: given } = z.object({ token: z.string().optional() }).strict().parse(request.query);
    if (!sameSecret(given, token)) return reply.code(401).send(problem("unauthorized", "This link is from an earlier launch. Use the one Socrates printed when it started."));
    return reply.header("set-cookie", sessionCookie(token)).redirect("/");
  });

  app.get("/", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send("<!doctype html><title>Socrates</title><p>Socrates is running. The app arrives with the next update.</p>"));

  app.get("/api/status", async () => {
    const index = await runtime.embeddingStatus();
    const folder = runtime.workingFolder();
    return {
      home: runtime.config.home,
      ready: runtime.socrates !== null,
      setup: runtime.setup,
      models: runtime.models,
      embeddings: { ...runtime.settings.embeddings, ...runtime.embeddings, index },
      timeZone: runtime.timeZone,
      busy: runtime.socrates?.busy ?? false,
      lanes: runtime.lanes(),
      workingFolder: folder ? { id: folder.id, name: folder.name, path: folder.rootPath } : null,
      recovered: runtime.recovered,
    };
  });

  app.get("/api/settings", async () => runtime.settings);
  app.put("/api/settings", async (request) => runtime.updateSettings(request.body ?? {}));

  // Keys are write-only: the API says which are set, never what they are.
  app.get("/api/keys", async () => {
    const set = runtime.keyNames();
    return Object.fromEntries(KEY_NAMES.map((name) => [name, set.has(name)]));
  });
  app.put("/api/keys/:name", async (request, reply) => {
    const { value } = z.object({ value: z.string() }).strict().parse(request.body);
    await runtime.setKey((request.params as { name: string }).name, value.trim());
    return reply.code(204).send();
  });
  app.delete("/api/keys/:name", async (request, reply) => {
    await runtime.setKey((request.params as { name: string }).name, null);
    return reply.code(204).send();
  });

  app.get("/api/goals", async () => goalsView(runtime.store));

  app.get("/api/history", async (request, reply) => {
    const query = History.parse(request.query);
    const laneId = query.conversation === "main" ? null : query.conversation;
    if (laneId && !runtime.store.getLane(laneId)) return reply.code(404).send(problem("not_found", "There is no such lane."));
    return conversationHistory(runtime.store, laneId, query.before);
  });

  app.get("/api/lanes", async () => runtime.lanes());

  app.get("/api/workspaces", async () => runtime.store.listWorkspaces().map((w) => ({ id: w.id, name: w.name, path: w.rootPath })));
  app.post("/api/workspaces", async (request) => {
    const { path } = z.object({ path: z.string().min(1) }).strict().parse(request.body);
    const workspace = workspaceFor(runtime.store, workspaceFolder(path, runtime.config.home));
    return { id: workspace.id, name: workspace.name, path: workspace.rootPath };
  });

  app.get("/api/folders", async (request) => listFolders(z.object({ path: z.string().optional() }).strict().parse(request.query).path));

  return app;
}
