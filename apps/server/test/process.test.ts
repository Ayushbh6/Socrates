import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as httpServer, get } from "node:http";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LedgerStore } from "@socrates/store";
import { afterEach, describe, expect, it } from "vitest";
import { KEY_NAMES, type HistoryItem } from "../src";
import { home, tempDir } from "./helpers";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  const socket = createServer();
  const port = await listen(socket);
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, { headers }, (response) => { response.resume(); resolve(response.statusCode!); }).on("error", reject);
  });
}

function deadline<T>(promise: Promise<T>, ms = 8_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server process did not settle in time.")), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function start(dataHome: string, port: number) {
  // The executable gets no developer credentials or existing data-home config.
  const env = { ...process.env, SOCRATES_HOME: dataHome, SOCRATES_PORT: String(port), NODE_OPTIONS: "--disable-warning=ExperimentalWarning" };
  for (const name of KEY_NAMES) delete env[name as keyof typeof env];
  const child = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      const url = /http:\/\/127\.0\.0\.1:\d+\/auth\?token=[A-Za-z0-9_-]+/.exec(output)?.[0];
      if (url) resolve(url);
    });
    child.stderr!.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    void exited.then(() => reject(new Error(`Server exited before readiness: ${output}`)));
  });
  // Some tests intentionally exit during startup or fail to bind.
  void ready.catch(() => {});
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await deadline(exited);
  });
  const readyInTime = deadline(ready);
  void readyInTime.catch(() => {});
  return { child, ready: readyInTime, exited, output: () => output };
}

async function stop(child: ChildProcess, exited: ReturnType<typeof start>["exited"], signal: NodeJS.Signals = "SIGTERM") {
  child.kill(signal);
  return deadline(exited);
}

describe("S1 executable over real sockets", () => {
  it("serves the authenticated API, refuses a second owner, recovers after SIGKILL, and shuts down cleanly", async () => {
    const config = home({ settings: { embeddings: { provider: "ollama", model: null, url: `http://127.0.0.1:${await freePort()}` } } });
    const port = await freePort();
    const store = LedgerStore.open({ path: config.dbPath });
    const goal = store.createGoal({ title: "Process recovery" });
    const task = store.createTask(goal.id, { title: "Keep evidence" });
    const turn = store.bindTurn({ userEventId: store.recordUserMessage("Synthetic unfinished work.").id, taskId: task.id, route: "test" });
    store.recordToolCall({ goal_id: goal.id, task_id: task.id, chat_id: turn.chatId, turn_id: turn.id }, { callId: "unfinished-call", tool: "read", input: { path: "README.md" } });
    store.recordUserMessage("Saved before routing completed.");
    store.close();

    const first = start(config.home, port);
    const loginUrl = await first.ready;
    const token = new URL(loginUrl).searchParams.get("token")!;
    const url = `http://127.0.0.1:${port}`;
    const request = (route: string, init: RequestInit = {}) => fetch(`${url}${route}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
    expect((await fetch(`${url}/api/status`)).status).toBe(401);
    expect(await rawStatus(`${url}/api/status`, { host: `evil.example:${port}`, authorization: `Bearer ${token}` })).toBe(403);
    expect(await rawStatus(`${url}/api/status`, { origin: "http://evil.example", authorization: `Bearer ${token}` })).toBe(403);
    expect(await rawStatus(`${url}/api/status`, { "sec-fetch-site": "cross-site", authorization: `Bearer ${token}` })).toBe(403);
    const login = await fetch(loginUrl, { redirect: "manual" });
    expect(login.status).toBe(302);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(login.headers.get("referrer-policy")).toBe("no-referrer");
    const status = await (await request("/api/status")).json();
    expect(status).toMatchObject({ ready: false, recovered: 1, embeddings: { state: "unavailable", index: null } });
    const history = await (await request("/api/history")).json() as { items: HistoryItem[] };
    expect(history.items[0]).toMatchObject({ message: "Saved before routing completed.", unrouted: true, parts: [] });
    expect(history.items[1]!.parts[0]).toMatchObject({ status: "interrupted", interrupted: "restarted", toolCalls: [{ handle: "e1", status: null }] });
    const project = path.join(tempDir(), "project");
    mkdirSync(project);
    const workspace = await (await request("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: project }) })).json() as { id: string };
    expect((await request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ workingFolder: workspace.id, timeZone: "Europe/Vienna" }) })).status).toBe(200);
    const fakeKey = "synthetic-process-key";
    expect((await request("/api/keys/GEMINI_API_KEY", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: fakeKey }) })).status).toBe(204);
    expect(statSync(config.keysPath).mode & 0o777).toBe(0o600);
    expect((await request("/api/status")).status).toBe(200);
    await expect((await request("/api/status")).text()).resolves.not.toContain(fakeKey);

    const duplicate = start(config.home, await freePort());
    expect((await deadline(duplicate.exited)).code).toBe(1);
    expect(duplicate.output()).toContain("already using");
    expect((await request("/api/health")).status).toBe(200);
    expect((await stop(first.child, first.exited, "SIGKILL")).signal).toBe("SIGKILL");

    const second = start(config.home, port);
    const freshUrl = await second.ready;
    const freshToken = new URL(freshUrl).searchParams.get("token")!;
    expect(freshToken).not.toBe(token);
    expect((await request("/api/status")).status).toBe(401);
    const restart = await (await fetch(`${url}/api/status`, { headers: { authorization: `Bearer ${freshToken}` } })).json();
    expect(restart).toMatchObject({ recovered: 0, ready: true, timeZone: "Europe/Vienna", workingFolder: { id: workspace.id } });
    expect(readFileSync(config.settingsPath, "utf8")).toContain("Europe/Vienna");
    expect((await stop(second.child, second.exited, "SIGINT")).code).toBe(0);
    await expect(fetch(`${url}/api/health`)).rejects.toThrow();
  }, 20_000);

  it("reports an occupied port and releases the data home after a failed listen", async () => {
    const blocker = createServer();
    const port = await listen(blocker);
    cleanup.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const config = home({ settings: { embeddings: { provider: "ollama", model: null, url: `http://127.0.0.1:${await freePort()}` } } });
    const failed = start(config.home, port);
    expect((await deadline(failed.exited)).code).toBe(1);
    expect(failed.output()).toContain("port is in use");
    const next = start(config.home, await freePort());
    await next.ready;
    expect((await stop(next.child, next.exited)).code).toBe(0);
  });

  it("handles SIGTERM during a stalled embedding startup before printing a link", async () => {
    let arrived!: () => void;
    const request = new Promise<void>((resolve) => { arrived = resolve; });
    const stalled = httpServer(() => arrived());
    const embedPort = await listen(stalled);
    cleanup.push(async () => {
      stalled.closeAllConnections();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    });
    const config = home({ settings: { embeddings: { provider: "custom", model: "stalled", url: `http://127.0.0.1:${embedPort}` } } });
    const process = start(config.home, await freePort());
    await deadline(request);
    expect((await stop(process.child, process.exited)).code).toBe(0);
    expect(process.output()).not.toContain("Socrates is running");
    writeFileSync(config.settingsPath, JSON.stringify({ embeddings: { provider: "ollama", model: null, url: `http://127.0.0.1:${await freePort()}` } }));
    const restarted = start(config.home, await freePort());
    await restarted.ready;
    expect((await stop(restarted.child, restarted.exited)).code).toBe(0);
  });

  it("cancels MCP startup and reaps its stdio child on SIGTERM", async () => {
    const config = home();
    const fixture = path.join(tempDir(), "stalled-mcp.mjs");
    const pidFile = path.join(config.home, "fixture.pid");
    writeFileSync(fixture, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], String(process.pid)); process.stdin.resume();\n');
    writeFileSync(path.join(config.home, "mcp.json"), JSON.stringify({ mcpServers: { stalled: { command: process.execPath, args: [fixture, pidFile] } } }));
    const child = start(config.home, await freePort());
    const end = Date.now() + 8_000;
    while (!existsSync(pidFile) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(existsSync(pidFile)).toBe(true);
    const fixturePid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(fixturePid, 0)).not.toThrow();
    expect((await stop(child.child, child.exited)).code).toBe(0);
    expect(() => process.kill(fixturePid, 0)).toThrow();
    expect(child.output()).not.toContain("Socrates is running");
  });
});
