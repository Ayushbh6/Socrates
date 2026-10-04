/** Live S2 acceptance: the real server process (`apps/server/src/main.ts`)
 * driven only through its HTTP API and live connection, as the web app will
 * drive it, with real models and the local embedder. It checks an approval
 * answered over the connection, a lane working beside main, a queued message
 * running when main is free, cancelling, catching up after a reconnect,
 * recovery after the process is killed mid-turn, and a clean Ctrl-C. Only
 * this disposable fixture reaches the provider. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_DEFAULTS, type Provider } from "@socrates/providers";
import WebSocket from "ws";
import { loadEvaluationEnvironment } from "../../../packages/router/eval/environment";
import { KEY_NAMES } from "../src";

loadEvaluationEnvironment();
const provider = (process.env.SOCRATES_PROVIDER ?? "gemini") as Provider;
const defaults = PROVIDER_DEFAULTS[provider];
if (!defaults) throw new Error("Unknown evaluation provider.");
const keyName = defaults.keys.find((name) => process.env[name]);
if (!keyName) throw new Error(`Set ${defaults.keys.join(" or ")} or SOCRATES_ENV_FILE for the live server evaluation.`);
const key = process.env[keyName]!;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const base = path.join(root, ".socrates/evals");
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, `server-${provider}-`)));
const project = path.join(dir, "project");
mkdirSync(path.join(project, "test"), { recursive: true });
writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "project", private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
writeFileSync(path.join(project, "test/slow.test.js"), 'import test from "node:test";\n\ntest("integration suite", async () => {\n  await new Promise((done) => setTimeout(done, 20000));\n});\n');
writeFileSync(path.join(project, "long.js"), "setTimeout(() => console.log('long task done: KESTREL-41'), 2000);\n");
writeFileSync(path.join(project, "wait.js"), "setTimeout(() => console.log('waited'), 60000);\n");
const home = path.join(dir, "home");

const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((done) => reservation.close(() => done()));
const http = `http://127.0.0.1:${port}`;

const results: { name: string; pass: boolean; detail?: string }[] = [];
const pass = (name: string, detail?: string) => {
  results.push({ name, pass: true, ...(detail ? { detail } : {}) });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
};
const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 140);

let server: ChildProcess | null = null;
let token = "";
let output = "";
/** Start the real server process; the provider key reaches it only through the API. */
async function start(): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env, SOCRATES_HOME: home, SOCRATES_PORT: String(port), NODE_OPTIONS: "--disable-warning=ExperimentalWarning" };
  for (const name of KEY_NAMES) delete env[name];
  output = "";
  server = spawn(process.execPath, ["--import", "tsx", path.join(root, "apps/server/src/main.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (chunk) => (output += chunk));
  server.stderr!.on("data", (chunk) => (output += chunk));
  const end = Date.now() + 60_000;
  while (!/token=([\w-]+)/.test(output)) {
    if (Date.now() > end || server.exitCode !== null) throw new Error(`The server did not start: ${output}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  token = /token=([\w-]+)/.exec(output)![1]!;
}

async function api<T = any>(route: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${http}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert(!text.includes(key), "A provider key appeared in an API response.");
  assert(response.ok, `${method} ${route}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** One live connection, as one browser page. */
async function page(after?: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers: { authorization: `Bearer ${token}`, origin: http } });
  const received: any[] = [];
  const waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    assert(!raw.toString().includes(key), "A provider key appeared on the live connection.");
    received.push(message);
    for (const w of [...waiters]) if (w.match(message)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(message); }
  });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", ...(after !== undefined ? { after } : {}) }));
  const next = (match: (m: any) => boolean, timeoutMs = 180_000) => {
    const seen = received.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; last messages: ${JSON.stringify(received.slice(-5)).slice(0, 800)}`)), timeoutMs);
      waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };
  return { socket, received, next, send: (command: object) => socket.send(JSON.stringify(command)) };
}
const resultOf = (id: string) => (m: any) => m.type === "result" && m.id === id;
const errorOf = (id: string) => (m: any) => m.type === "error" && m.id === id;
const either = (p: Awaited<ReturnType<typeof page>>, id: string) => p.next((m) => resultOf(id)(m) || errorOf(id)(m)).then((m) => {
  assert.equal(m.type, "result", `message ${id} failed: ${JSON.stringify(m)}`);
  return m.result;
});

async function run() {
  await start();
  console.log(`Live server acceptance: ${provider}; data in ${dir}`);

  // 0. Setup over the API: key, working folder.
  assert.equal((await api("/api/status")).ready, false);
  await api(`/api/keys/${keyName}`, "PUT", { value: key });
  const workspace = await api("/api/workspaces", "POST", { path: project });
  await api("/api/settings", "PUT", { workingFolder: workspace.id });
  const status = await api("/api/status");
  assert.equal(status.ready, true, JSON.stringify(status.setup));
  let p = await page(status.seq);
  await p.next((m) => m.type === "state" && m.ready);
  pass("setup over the API makes the real server ready", `${status.models.chat.provider}:${status.models.chat.model}; embeddings ${status.embeddings.state}`);

  // 1. An approval answered over the live connection.
  p.send({ type: "send", id: "approve", to: "main", text: "In my project, run `node long.js` with the terminal tool, setting timeout_ms to 0 so it runs without a deadline, and tell me exactly what it printed." });
  const asked = await p.next((m) => m.type === "approval");
  assert.equal(asked.conversation, "main");
  assert.equal(asked.kind, "no_deadline");
  p.send({ type: "approve", approval: asked.id, granted: true });
  const approved = await either(p, "approve");
  assert.match(approved.text, /KESTREL-41/);
  pass("an approval reaches the page, is answered there, and the work continues", `${asked.detail}; ${short(approved.text)}`);

  // 2–3. A lane beside main, and a queued message that runs once main is free.
  p.send({ type: "send", id: "tests", to: "main", text: "Run `npm test` in my project and tell me whether the suite passes." });
  await p.next((m) => m.type === "state" && m.busy);
  p.send({ type: "send", id: "notes", to: "new_lane", text: "In my project, create NOTES.md containing exactly one line: lanes work." });
  p.send({ type: "queue", id: "sum", text: "Quick one: what is 7 times 6?" });
  const lane = (await p.next((m) => m.type === "accepted" && m.id === "notes")).conversation;
  const notes = await either(p, "notes");
  const notesAt = Date.now();
  const tests = await either(p, "tests");
  const testsAt = Date.now();
  assert.equal(notes.laneId, lane);
  assert(existsSync(path.join(project, "NOTES.md")) && readFileSync(path.join(project, "NOTES.md"), "utf8").includes("lanes work"));
  assert(notesAt <= testsAt, "the lane must finish while main still runs the suite");
  assert.match(notes.notices[0] ?? "", /^Lane 1 finished: /);
  assert(p.received.some((m) => m.type === "activity" && m.conversation === lane && m.kind === "tool_finished"), "lane activity must be tagged with the lane");
  assert.match(tests.text, /pass/i);
  pass("a lane works beside main, tagged with its lane, and reports a notice", short(notes.notices[0]));
  const sum = await either(p, "sum");
  assert.match(sum.text, /42/);
  pass("a queued message runs as soon as main is free", short(sum.text));

  // 4–5. Cancel main mid-tool; a reconnecting page catches up on what it missed.
  const before = (await api("/api/status")).seq;
  p.send({ type: "send", id: "wait", to: "main", text: "In my project, run `node wait.js` in the foreground and tell me what it prints." });
  await p.next((m) => m.type === "activity" && m.kind === "tool_started" && m.seq > before && m.line.includes("wait.js"));
  p.send({ type: "cancel", conversation: "main" });
  const cancelled = await either(p, "wait");
  assert.equal(cancelled.parts[0].status, "interrupted");
  pass("cancel stops main mid-tool and records it", short(cancelled.text));
  p.socket.close();
  const again = await page(before);
  await again.next((m) => m.type === "activity" && m.kind === "finished" && m.status === "interrupted");
  assert(again.received.some((m) => m.type === "activity" && m.kind === "tool_started" && m.line.includes("wait.js")));
  assert(!again.received.some((m) => m.type === "activity" && m.seq <= before));
  pass("a reconnecting page catches up exactly on what it missed", `${again.received.filter((m) => m.type === "activity").length} activities replayed`);
  p = again;

  // 6. Killed mid-turn: the next start interrupts the turn and the work continues.
  const mark = (await api("/api/status")).seq;
  p.send({ type: "send", id: "crash", to: "main", text: "In my project, run `node wait.js` in the foreground once more and report what it prints." });
  // Only a tool start after this message counts: the page has already replayed the earlier one.
  await p.next((m) => m.type === "activity" && m.kind === "tool_started" && m.seq > mark && m.line.includes("wait.js"));
  server!.kill("SIGKILL");
  await once(server!, "exit");
  await start();
  const restarted = await api("/api/status");
  assert.equal(restarted.recovered, 1);
  p = await page(restarted.seq);
  p.send({ type: "send", id: "after", to: "main", text: "Socrates was restarted. Did that wait.js run finish? Answer briefly." });
  const after = await either(p, "after");
  const history = await api("/api/history");
  const crashed = history.items.find((i: any) => i.message.includes("once more"));
  assert.equal(crashed?.parts[0]?.interrupted, "restarted");
  assert.match(after.text, /not|interrupt|stopp|restart|didn/i);
  pass("a turn killed mid-tool is interrupted at the next start and the work continues", short(after.text));

  // 7. Ctrl-C stops the server cleanly.
  server!.kill("SIGINT");
  const [code] = await Promise.race([once(server!, "exit"), new Promise<[number]>((_, reject) => setTimeout(() => reject(new Error("SIGINT did not stop the server")), 15_000))]);
  assert.equal(code, 0);
  server = null;
  pass("Ctrl-C stops the server cleanly");

  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ provider, dir, assertions: results }, null, 2));
  console.log(`${results.length}/${results.length} server scenarios passed. Report: ${path.join(dir, "results.json")}`);
}

run().catch((error) => {
  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ provider, dir, assertions: results, failure: error instanceof Error ? error.message : String(error), output: output.slice(-4000) }, null, 2));
  console.error(error instanceof Error ? error.message : "Server acceptance failed.");
  console.error(output.slice(-2000));
  process.exitCode = 1;
}).finally(() => {
  server?.kill("SIGKILL");
  // The temporary key is removed with the evaluation's data folder contents.
  try { writeFileSync(path.join(home, ".env"), ""); } catch {}
});
