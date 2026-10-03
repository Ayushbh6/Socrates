/** Live S1 acceptance: real HTTP, providers, on-disk services, history and
 * restart. Message execution goes through Runtime's Socrates until S2 adds
 * the live transport. Only this disposable fixture reaches the model. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelClient } from "@socrates/contracts";
import { PROVIDER_DEFAULTS, makeModel, type Provider } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import { loadEvaluationEnvironment } from "../../../packages/router/eval/environment";
import { HOST, Runtime, buildServer, conversationHistory, goalsView, redact, resolveConfig, sessionToken, type HistoryItem } from "../src";

loadEvaluationEnvironment();
const provider = process.env.SOCRATES_PROVIDER ?? "gemini";
const defaults = PROVIDER_DEFAULTS[provider as Provider];
if (!defaults) throw new Error("Unknown evaluation provider.");
const keyName = defaults.keys.find((name) => process.env[name]);
if (!keyName) throw new Error(`Set ${defaults.keys.join(" or ")} or SOCRATES_ENV_FILE for the live core evaluation.`);
const key = process.env[keyName]!;
const chat = process.env.SOCRATES_MAIN_MODEL ?? defaults.main;
const router = process.env.SOCRATES_ROUTER_MODEL ?? defaults.router;
const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, `server-core-${provider}-`)));
const fixture = path.join(dir, "fixture");
mkdirSync(fixture);
writeFileSync(path.join(fixture, "README.md"), "# Server core fixture\n\nVerification code: ORBIT-6382\n");

const reservation = createServer();
reservation.listen(0, HOST);
await once(reservation, "listening");
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const config = resolveConfig({ SOCRATES_HOME: path.join(dir, "home"), SOCRATES_PORT: String(port) });
const logs: string[] = [];
let modelCalls = 0;
const deps = {
  env: {},
  makeModel: (p: string, model: string, env: Record<string, string | undefined>): ModelClient => {
    const client = makeModel(p, model, env);
    return { id: client.id, complete: async (request) => { modelCalls++; return client.complete(request); } };
  },
  log: (line: string) => logs.push(line),
};
let runtime = await Runtime.open(config, deps);
let token = sessionToken();
let app = await buildServer({ runtime, token });
const results: { name: string; pass: boolean; detail?: string }[] = [];
const pass = (name: string, detail?: string) => {
  results.push({ name, pass: true, ...(detail ? { detail } : {}) });
  console.log(`PASS ${name}${detail ? ` (${detail})` : ""}`);
};
const url = `http://${HOST}:${port}`;
const request = async <T = unknown>(route: string, method = "GET", body?: unknown): Promise<T> => {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  assert(!text.includes(key), "A provider key appeared in an API response.");
  assert(response.ok, `${method} ${route}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
};
const reopen = async () => {
  await Promise.all([app.close(), runtime.close()]);
  runtime = await Runtime.open(config, deps);
  token = sessionToken();
  app = await buildServer({ runtime, token });
  await app.listen({ host: HOST, port });
};

try {
  await app.listen({ host: HOST, port });
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  assert.equal((await fetch(`${url}/api/status`)).status, 401);
  const login = await fetch(`${url}/auth?token=${token}`, { redirect: "manual" });
  assert.equal(login.status, 302);
  assert.match(login.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await fetch(`${url}/api/status`, { headers: { cookie } })).status, 200);
  pass("real HTTP authentication and session exchange");

  const initial = await request<{ ready: boolean; setup: string[]; embeddings: { state: string; detail: string | null } }>("/api/status");
  assert.equal(initial.ready, false);
  assert(initial.setup.length > 0);
  assert.equal(modelCalls, 0);
  if (initial.embeddings.state === "unavailable") assert.match(initial.embeddings.detail!, /keywords only/);
  pass("setup-needed startup and truthful embedding status", initial.embeddings.state);

  await request("/api/settings", "PUT", { chat: { provider, model: chat }, router: { provider, model: router }, timeZone: "Europe/Vienna" });
  await request(`/api/keys/${keyName}`, "PUT", { value: key });
  assert.equal(statSync(config.keysPath).mode & 0o777, 0o600);
  const workspace = await request<{ id: string }>("/api/workspaces", "POST", { path: fixture });
  await request("/api/settings", "PUT", { workingFolder: workspace.id });
  const settings = await request<{ chat: { model: string }; router: { model: string } }>("/api/settings");
  assert.equal(settings.chat.model, chat);
  assert.equal(settings.router.model, router);
  assert.equal((await request<Record<string, boolean>>("/api/keys"))[keyName], true);
  assert.equal((await request<{ ready: boolean }>("/api/status")).ready, true);
  pass("write-only key, model setup and partial working-folder update");

  const message = "In the server core fixture project, use read to open README.md from disk and report its verification code. Do not change any files.";
  const first = await runtime.socrates!.handle(message, { signal: AbortSignal.timeout(90_000) });
  assert.equal(first.kind, "answered");
  if (first.kind !== "answered") throw new Error("Expected the fixture answer.");
  assert.match(first.text, /ORBIT-6382/);
  const mainTurn = first.parts[0]!.turn;
  assert.equal(runtime.store.requireGoal(mainTurn.goalId!).workspaceId, workspace.id);
  assert(runtime.store.evidenceForTurn(mainTurn.id).some((e) => e.tool === "read" && e.status === "ok"));
  const main = await request<{ items: HistoryItem[] }>("/api/history");
  assert.equal(main.items[0]!.message, message);
  assert.match(main.items[0]!.parts[0]!.answer!, /ORBIT-6382/);
  assert((await request<unknown[]>("/api/goals")).length > 0);
  pass("real router and agent, workspace binding, tool evidence and HTTP history");

  const lane = await runtime.socrates!.handle("In the server core fixture project, use read to open README.md from disk again and report its verification code. Do not change any files.", { lane: "new", signal: AbortSignal.timeout(90_000) });
  assert.equal(lane.kind, "answered");
  if (lane.kind !== "answered") throw new Error("Expected the lane answer.");
  assert(lane.laneId);
  assert.match(lane.text, /ORBIT-6382/);
  const laneHistory = await request<{ items: HistoryItem[] }>(`/api/history?conversation=${lane.laneId}`);
  assert.equal(laneHistory.items.length, 1);
  assert.equal((await request<{ items: HistoryItem[] }>("/api/history")).items.length, 1);
  pass("real lane execution and separate conversation history");

  await reopen();
  assert.equal(runtime.recovered, 0);
  assert(runtime.socrates);
  assert.equal(runtime.settings.chat?.model, chat);
  assert.equal(runtime.workingFolder()?.id, workspace.id);
  assert.deepEqual(await request("/api/history"), main);
  assert.deepEqual(await request(`/api/history?conversation=${lane.laneId}`), laneHistory);
  assert.equal(runtime.lanes()[0]!.running, false);
  pass("on-disk restart retains settings, models, main history and idle lanes");

  // A turn and pending evidence left by an abruptly stopped worker.
  const unfinished = runtime.store.bindTurn({ userEventId: runtime.store.recordUserMessage("Read the fixture once more; this turn will be interrupted before its answer.").id, taskId: mainTurn.taskId!, route: "eval-crash" });
  const evidence = runtime.store.recordToolCall({ goal_id: unfinished.goalId!, task_id: unfinished.taskId!, chat_id: unfinished.chatId, turn_id: unfinished.id }, { callId: "eval-unfinished", tool: "read", input: { path: "README.md" } });
  await reopen();
  assert.equal(runtime.recovered, 1);
  assert.equal(runtime.store.requireTurn(unfinished.id).status, "interrupted");
  const recovered = await request<{ items: HistoryItem[] }>("/api/history");
  assert.equal(recovered.items[0]!.parts[0]!.interrupted, "restarted");
  assert.equal(recovered.items[0]!.parts[0]!.toolCalls[0]!.handle, evidence.handle);
  pass("restart recovery retains exact pending tool evidence");

  const goal = runtime.store.requireGoal(mainTurn.goalId!);
  const task = runtime.store.requireTask(mainTurn.taskId!);
  const continued = await runtime.socrates!.handle(`Continue g${goal.number}/t${task.number}. Did the previous interrupted turn produce a final answer? Explain its recorded interruption without running any tools.`, { signal: AbortSignal.timeout(90_000) });
  assert.equal(continued.kind, "answered");
  if (continued.kind !== "answered") throw new Error("Expected continuation.");
  assert.equal(continued.parts[0]!.turn.taskId, task.id);
  assert.match(continued.text, /interrupt|stopped|restart|no (?:final )?answer/i);
  pass("real agent continues recovered work with truthful interruption context");

  const replay = LedgerStore.open({ path: ":memory:" });
  try {
    replay.restoreEvents(runtime.store.listEvents());
    assert.deepEqual(conversationHistory(replay, null), conversationHistory(runtime.store, null));
    assert.deepEqual(conversationHistory(replay, lane.laneId), conversationHistory(runtime.store, lane.laneId));
    assert.deepEqual(goalsView(replay), goalsView(runtime.store));
  } finally { replay.close(); }
  pass("event-only replay reproduces history, recovery, goals and lanes");
} catch (error) {
  const detail = redact(error instanceof Error ? error.message : String(error), process.env);
  results.push({ name: "live server core acceptance", pass: false, detail });
  console.error(`FAIL ${detail}`);
  process.exitCode = 1;
} finally {
  let operationalWarnings: number | null = null;
  try { operationalWarnings = runtime.store.listEvents({ type: "agent_warning" }).length; } catch {}
  await Promise.allSettled([app.close(), runtime.close()]);
  rmSync(config.keysPath, { force: true });
  writeFileSync(path.join(dir, "results.json"), `${JSON.stringify({ provider, chat, router, modelCalls, operationalWarnings, results, diagnostics: logs }, null, 2)}\n`);
  console.log(`${results.filter((r) => r.pass).length}/${results.length} passed; ${modelCalls} model calls. Results: ${path.join(dir, "results.json")}`);
}
