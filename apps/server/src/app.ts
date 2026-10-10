import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { type EventPayloads, type EventRefs, MEMORY_KINDS } from "@socrates/contracts";
import { PROVIDER_DEFAULTS } from "@socrates/providers";
import { callLine } from "@socrates/retrieval";
import { IMAGE_MAX_BYTES } from "@socrates/tools";
import { z } from "zod";
import { AttachmentError, findAttachment, storeAttachment, viewOf } from "./attachments";
import { describeCall } from "./calls";
import { KEY_NAMES, KeyError } from "./keys";
import { LiveHub } from "./live";
import { CALL_RETENTION_DAYS, type Runtime, RuntimeBusyError, SettingsError } from "./runtime";
import * as observe from "./observe";
import { DbError, browse, isDb, overview, row as dbRow } from "./dbview";
import { guard, problem, sameSecret, sessionCookie } from "./security";
import { StoreError } from "@socrates/store";
import { FolderError, archivedView, conversationHistory, goalsView, listFolders, memoriesView, workspaceFolder, workspaceFor } from "./views";

export interface ServerOptions {
  runtime: Runtime;
  /** This launch's session secret. */
  token: string;
  /** Tests shrink how far behind a reconnecting page may catch up. */
  replayMax?: number;
  /** The built web app; `pnpm socrates` builds it. Tests pass their own or null. */
  webRoot?: string | null;
}

/** Where `pnpm build:web` puts the web app. */
export const WEB_ROOT = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** The evidence route returns at most this much of one call's output. */
export const EVIDENCE_MAX_CHARS = 200_000;

const History = z.object({
  conversation: z.string().default("main"),
  before: z.coerce.number().int().positive().optional(),
}).strict();

/**
 * The HTTP API (architecture/server.md, "HTTP API"). Every response is JSON;
 * failures are `{ error: { code, message } }` with a message meant for the
 * user. The live connection (sending, approvals, activity) is separate.
 */
export async function buildServer({ runtime, token, replayMax, webRoot = WEB_ROOT }: ServerOptions): Promise<FastifyInstance> {
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
    if (error instanceof KeyError || error instanceof FolderError || error instanceof SettingsError || error instanceof AttachmentError || error instanceof DbError) return reply.code(400).send(problem("invalid_request", error.message));
    const status = (error as { statusCode?: number }).statusCode;
    if ((error as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY") return reply.code(400).send(problem("invalid_request", "The request body must be valid JSON."));
    if (status && status >= 400 && status < 500) return reply.code(status).send(problem("invalid_request", (error as Error).message));
    runtime.log(`request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return reply.code(500).send(problem("internal", "Something went wrong on the server. Details are in the server log."));
  });

  // The live connection: one hub per server, closed (cancelling its runs) before the server stops.
  const hub = new LiveHub(runtime, replayMax ? { replayMax } : {});
  app.addHook("preClose", () => hub.close());
  app.addHook("onClose", () => hub.close());
  const socketOptions = { maxPayload: 1024 * 1024, closeTimeout: 1_000 };
  await app.register(websocket, { options: socketOptions });
  app.get("/api/live", { websocket: true }, (socket) => hub.attach(socket));

  app.get("/api/health", async () => ({ ok: true }));

  // The printed link: exchange the secret for a session cookie, then drop it from the address bar.
  app.get("/auth", async (request, reply) => {
    const { token: given } = z.object({ token: z.string().optional() }).strict().parse(request.query);
    if (!sameSecret(given, token)) return reply.code(401).send(problem("unauthorized", "This link is from an earlier launch. Use the one Socrates printed when it started."));
    return reply.header("set-cookie", sessionCookie(token)).redirect("/");
  });

  // The web app (architecture/web.md), behind the same session as the API.
  if (webRoot && existsSync(path.join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: webRoot, index: "index.html", cacheControl: false });
  } else {
    app.get("/", async (_request, reply) =>
      reply.type("text/html; charset=utf-8").send("<!doctype html><title>Socrates</title><p>Socrates is running, but its web app is not built. Start it with <code>pnpm socrates</code>.</p>"));
  }

  app.get("/api/status", async () => {
    const index = await runtime.embeddingStatus();
    const folder = runtime.workingFolder();
    return {
      home: runtime.config.home,
      ready: runtime.socrates !== null && runtime.acceptingMessages,
      setup: runtime.setup,
      access: runtime.settings.access,
      profile: runtime.settings.profile,
      models: runtime.models,
      embeddings: { ...runtime.settings.embeddings, ...runtime.embeddings, index },
      timeZone: runtime.timeZone,
      busy: runtime.socrates?.busy ?? false,
      lanes: runtime.lanes(),
      workingFolder: folder ? { id: folder.id, name: folder.name, path: folder.rootPath } : null,
      recovered: runtime.recovered,
      // The event this status reflects: a page passes it to the live connection's `hello`.
      seq: runtime.store.latestEventSeq(),
    };
  });

  app.get("/api/settings", async () => runtime.settings);
  // What the settings screen offers: each provider's default models and the keys it reads.
  app.get("/api/providers", async () => Object.entries(PROVIDER_DEFAULTS).map(([name, d]) => ({ name, main: d.main, router: d.router, keys: [...d.keys] })));
  app.put("/api/settings", async (request) => runtime.updateSettings(request.body ?? {}));
  // What the model pickers offer: a provider's chat models, from its own list.
  app.get("/api/models", async (request) => ({ models: await runtime.providerModels(z.object({ provider: z.string() }).parse(request.query).provider) }));

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

  // Images for a message: stored by content, then named in the message that carries them.
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: IMAGE_MAX_BYTES }, (_request, body, done) => done(null, body));
  app.post("/api/attachments", async (request) => {
    const { name } = z.object({ name: z.string().max(1000).optional() }).strict().parse(request.query);
    if (!Buffer.isBuffer(request.body)) throw new AttachmentError("Send the image's bytes with its image content type.");
    return viewOf(storeAttachment(runtime.config.attachmentsDir, request.body, name ?? "image"));
  });
  app.get("/api/attachments/:id", async (request, reply) => {
    const found = findAttachment(runtime.config.attachmentsDir, (request.params as { id: string }).id);
    if (!found) return reply.code(404).send(problem("not_found", "There is no such attachment."));
    // Content-addressed: the same id is always the same image.
    return reply.header("cache-control", "private, max-age=31536000, immutable").type(found.media_type).send(readFileSync(found.path));
  });

  app.get("/api/goals", async () => goalsView(runtime.store, runtime.chatsGoalNumber()));
  // Standard mode's "New goal": a goal the user names, with no task until its first chat.
  app.post("/api/goals", async (request) => {
    const { title } = z.object({ title: z.string().trim().min(1).max(120) }).strict().parse(request.body);
    const goal = runtime.store.createGoal({ title });
    return goalsView(runtime.store, runtime.chatsGoalNumber()).find((g) => g.number === goal.number);
  });

  // Renaming and archiving, for standard mode's chats (tasks) and goals; flow mode renames from its notes.
  const Title = z.object({ title: z.string().trim().min(1).max(120) }).strict();
  const GoalParams = z.object({ goal: z.coerce.number().int().positive() });
  const TaskParams = GoalParams.extend({ task: z.coerce.number().int().positive() });
  const lookup = (params: unknown) => {
    const { goal: number, task: taskNumber } = TaskParams.partial({ task: true }).parse(params);
    const goal = runtime.store.getGoalByNumber(number);
    if (!goal || goal.general) return null;
    if (taskNumber === undefined) return { goal, task: null };
    const task = runtime.store.getTaskByNumber(goal.id, taskNumber);
    return task && !task.general ? { goal, task } : null;
  };
  const busyWith = (found: NonNullable<ReturnType<typeof lookup>>) => {
    const tasks = found.task ? [found.task] : runtime.store.listTasks(found.goal.id, { includeArchived: true });
    return tasks.some((t) => runtime.socrates?.taskBusy(t.id));
  };
  const missing = (reply: { code(n: number): { send(b: unknown): unknown } }) => reply.code(404).send(problem("not_found", "That goal or chat no longer exists."));
  app.patch("/api/goals/:goal", async (request, reply) => {
    const found = lookup(request.params);
    if (!found) return missing(reply);
    runtime.store.renameGoal(found.goal.id, Title.parse(request.body).title);
    return goalsView(runtime.store, runtime.chatsGoalNumber()).find((g) => g.number === found.goal.number);
  });
  app.patch("/api/goals/:goal/tasks/:task", async (request, reply) => {
    const found = lookup(request.params);
    if (!found?.task) return missing(reply);
    runtime.store.renameTask(found.task.id, Title.parse(request.body).title);
    return { ok: true };
  });
  for (const [verb, what] of [["archive", "archived"], ["restore", "restored"]] as const) {
    app.post(`/api/goals/:goal/${verb}`, async (request, reply) => {
      const found = lookup(request.params);
      if (!found) return missing(reply);
      if (verb === "archive") {
        if (found.goal.number === runtime.chatsGoalNumber()) return reply.code(400).send(problem("invalid_request", "The Chats list cannot be archived; archive its chats one by one."));
        if (busyWith(found)) return reply.code(409).send(problem("busy", "Socrates is working in this goal; stop it first."));
        runtime.store.archiveGoal(found.goal.id);
      } else runtime.store.restoreGoal(found.goal.id);
      return { ok: true, [what]: true };
    });
    app.post(`/api/goals/:goal/tasks/:task/${verb}`, async (request, reply) => {
      const found = lookup(request.params);
      if (!found?.task) return missing(reply);
      if (verb === "archive") {
        if (busyWith(found)) return reply.code(409).send(problem("busy", "Socrates is working in this chat; stop it first."));
        runtime.store.archiveTask(found.task.id);
      } else runtime.store.restoreTask(found.task.id);
      return { ok: true, [what]: true };
    });
  }
  // Status: open, completed or superseded, as the user sets it (flow's notes, standard's sidebar for goals).
  const Status = z.object({ status: z.enum(["open", "completed", "superseded"]) }).strict();
  app.post("/api/goals/:goal/status", async (request, reply) => {
    const found = lookup(request.params);
    if (!found) return missing(reply);
    runtime.store.setGoalStatus(found.goal.id, Status.parse(request.body).status);
    return { ok: true };
  });
  app.post("/api/goals/:goal/tasks/:task/status", async (request, reply) => {
    const found = lookup(request.params);
    if (!found?.task) return missing(reply);
    runtime.store.setTaskStatus(found.task.id, Status.parse(request.body).status);
    return { ok: true };
  });
  app.get("/api/archived", async () => archivedView(runtime.store));

  // Memory (agent-harness.md, "Memory"): the Memory page lists, adds, edits and forgets what Socrates remembers.
  const MemoryParams = z.object({ number: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
  const remembered = (params: unknown) => {
    const memory = runtime.store.getMemoryByNumber(MemoryParams.parse(params).number);
    return memory && !memory.forgottenAt ? memory : null;
  };
  // A change from the page is recorded on the turn the entry was said in, so that exchange shows it.
  const sourceRefs = (turnId: string | null): EventRefs => {
    const turn = turnId ? runtime.store.getTurn(turnId) : null;
    return turn ? { goal_id: turn.goalId, task_id: turn.taskId, chat_id: turn.chatId, turn_id: turn.id } : {};
  };
  const refused = (reply: { code(n: number): { send(b: unknown): unknown } }, error: unknown) => {
    if (error instanceof StoreError) return reply.code(400).send(problem("invalid_request", error.message));
    throw error;
  };
  const noMemory = (reply: { code(n: number): { send(b: unknown): unknown } }) => reply.code(404).send(problem("not_found", "That memory no longer exists."));
  app.get("/api/memories", async () => memoriesView(runtime.store));
  app.post("/api/memories", async (request, reply) => {
    const body = z.object({ text: z.string().max(2000), kind: z.enum(MEMORY_KINDS), goal: z.number().int().positive().nullable().default(null) }).strict().parse(request.body);
    const goal = body.goal === null ? null : runtime.store.getGoalByNumber(body.goal);
    if (body.goal !== null && (!goal || goal.general)) return reply.code(404).send(problem("not_found", "That goal no longer exists."));
    try {
      const { memory } = runtime.store.saveMemory({ kind: body.kind, goalId: goal?.id ?? null, text: body.text, by: "user" });
      return memoriesView(runtime.store).find((m) => m.number === memory.number);
    } catch (error) { return refused(reply, error); }
  });
  app.patch("/api/memories/:number", async (request, reply) => {
    const memory = remembered(request.params);
    if (!memory) return noMemory(reply);
    const change = z.object({ text: z.string().max(2000).optional(), kind: z.enum(MEMORY_KINDS).optional() }).strict().parse(request.body);
    try {
      runtime.store.editMemory(memory.id, change, "user", sourceRefs(memory.sourceTurnId));
      return memoriesView(runtime.store).find((m) => m.number === memory.number);
    } catch (error) { return refused(reply, error); }
  });
  app.delete("/api/memories/:number", async (request, reply) => {
    const memory = remembered(request.params);
    if (!memory) return noMemory(reply);
    runtime.store.forgetMemory(memory.id, "user", sourceRefs(memory.sourceTurnId));
    return reply.code(204).send();
  });

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

  // A tool call's complete recorded output, beyond the live preview.
  // A step's complete thinking; live activity and history show its first THINKING_CHARS.
  app.get("/api/thinking", async (request, reply) => {
    const { seq } = z.object({ seq: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(request.query);
    const event = runtime.store.getEventBySeq(seq);
    const reasoning = event?.type === "agent_message" ? (event.payload as EventPayloads["agent_message"]).response.reasoning?.trim() : undefined;
    if (!reasoning) return reply.code(404).send(problem("not_found", "That step has no thinking."));
    return { seq, text: reasoning };
  });

  app.get("/api/evidence", async (request, reply) => {
    const ordinal = (n: string) => Number.isSafeInteger(Number(n)) && Number(n) > 0;
    const query = z.object({
      task: z.string().regex(/^g\d+\/t\d+$/).refine((s) => s.slice(1).split("/t").every(ordinal), "Use positive, safe goal and task numbers."),
      handle: z.string().regex(/^e\d+$/).refine((s) => ordinal(s.slice(1)), "Use a positive, safe evidence number."),
    }).strict().parse(request.query);
    const [goalNumber, taskNumber] = query.task.slice(1).split("/t").map(Number) as [number, number];
    const goal = runtime.store.getGoalByNumber(goalNumber);
    const task = goal ? runtime.store.getTaskByNumber(goal.id, taskNumber) : null;
    const evidence = task ? runtime.store.getEvidence(task.id, Number(query.handle.slice(1))) : null;
    if (!evidence) return reply.code(404).send(problem("not_found", "There is no such tool call."));
    const recorded = evidence.result;
    const output = recorded?.result as { output_full?: unknown; content?: unknown; output_lost?: unknown } | null;
    // `content` is shortened for the model; the structured result keeps the
    // complete retained terminal/MCP recording and complete failure details.
    const content = !recorded ? null
      : recorded.status === "error" ? JSON.stringify({ error: recorded.error, failure_detail: recorded.failure_detail ?? null })
      : typeof output?.output_full === "string" ? output.output_full
      : typeof output?.content === "string" ? output.content
      : recorded.result == null ? recorded.content : JSON.stringify(recorded.result);
    return {
      task: query.task,
      handle: evidence.handle,
      tool: evidence.tool,
      line: callLine(evidence.tool, evidence.input),
      call: describeCall(evidence.tool, evidence.input),
      status: evidence.status,
      content: content === null ? null : content.slice(0, EVIDENCE_MAX_CHARS),
      truncated: content !== null && content.length > EVIDENCE_MAX_CHARS,
      outputLost: output?.output_lost === true,
    };
  });

  // Every model call and what it cost (architecture/observability.md).
  const calls = () => runtime.calls;
  const unavailable = (reply: { code(n: number): { send(body: unknown): unknown } }) => reply.code(503).send(problem("unavailable", "The model-call log could not be opened; Socrates works without it. Details are in the server log."));
  const Range = z.enum(Object.keys(observe.RANGES) as [observe.Range, ...observe.Range[]]).default("24h");
  app.get("/api/observe/summary", async (request, reply) => {
    const { range } = z.object({ range: Range }).strict().parse(request.query);
    const log = calls();
    return log ? observe.summary(log, range, new Date(), CALL_RETENTION_DAYS) : unavailable(reply);
  });
  app.get("/api/observe/prices", async () => runtime.priceTable());
  app.get("/api/observe/series", async (request, reply) => {
    const { range } = z.object({ range: Range }).strict().parse(request.query);
    const log = calls();
    return log ? observe.series(log, range, new Date()) : unavailable(reply);
  });
  app.get("/api/observe/recent", async (request, reply) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(12) }).strict().parse(request.query);
    const log = calls();
    return log ? log.list({ limit }) : unavailable(reply);
  });
  app.get("/api/observe/costly", async (request, reply) => {
    const { range } = z.object({ range: Range }).strict().parse(request.query);
    const log = calls();
    return log ? observe.costly(log, runtime.store, range, new Date()) : unavailable(reply);
  });
  app.get("/api/observe/questions/:id/trace", async (request, reply) => {
    const log = calls();
    if (!log) return unavailable(reply);
    return observe.trace(log, runtime.store, (request.params as { id: string }).id) ?? reply.code(404).send(problem("not_found", "There is no such message."));
  });
  // A read-only look into the databases.
  app.get("/api/observe/db", async () => overview(runtime.config, await runtime.embeddingStatus()));
  app.get("/api/observe/db/:db/:table", async (request, reply) => {
    const { db, table } = request.params as { db: string; table: string };
    if (!isDb(db)) return reply.code(404).send(problem("not_found", "There is no such database."));
    const q = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50), q: z.string().max(200).optional(), order: z.string().max(100).optional(), dir: z.enum(["asc", "desc"]).default("desc") }).strict().parse(request.query);
    return browse(runtime.config, db, table, { offset: q.offset, limit: q.limit, dir: q.dir, ...(q.q ? { q: q.q } : {}), ...(q.order ? { order: q.order } : {}) });
  });
  app.get("/api/observe/db/:db/:table/:rowid", async (request, reply) => {
    const { db, table, rowid } = request.params as { db: string; table: string; rowid: string };
    if (!isDb(db) || !/^\d{1,15}$/.test(rowid)) return reply.code(404).send(problem("not_found", "There is no such row."));
    return dbRow(runtime.config, db, table, Number(rowid)) ?? reply.code(404).send(problem("not_found", "There is no such row."));
  });
  app.get("/api/observe/questions", async (request, reply) => {
    const query = z.object({ range: Range, before: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(30) }).strict().parse(request.query);
    const log = calls();
    return log ? observe.questions(log, runtime.store, { range: query.range, limit: query.limit, now: new Date(), ...(query.before ? { before: query.before } : {}) }) : unavailable(reply);
  });
  app.get("/api/observe/questions/:id", async (request, reply) => {
    const log = calls();
    if (!log) return unavailable(reply);
    return observe.question(log, runtime.store, (request.params as { id: string }).id) ?? reply.code(404).send(problem("not_found", "There is no such message."));
  });
  app.get("/api/observe/calls/:id", async (request, reply) => {
    const log = calls();
    if (!log) return unavailable(reply);
    return observe.callView(log, (request.params as { id: string }).id) ?? reply.code(404).send(problem("not_found", "There is no such call."));
  });

  app.get("/api/folders", async (request) => listFolders(z.object({ path: z.string().optional() }).strict().parse(request.query).path));

  return app;
}
