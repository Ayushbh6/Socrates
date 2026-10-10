import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelClient, ModelRequest, ModelResponse } from "@socrates/contracts";
import WebSocket from "ws";
import { HashEmbedder, NO_EFFORTS, ScriptedModel, type ScriptedStep, knownVision } from "@socrates/providers";
import { abortable, fixedClock } from "@socrates/shared";
import { afterEach } from "vitest";
import { Runtime, type RuntimeDeps, type ServerConfig, buildServer, resolveConfig, sessionToken } from "../src";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

export function tempDir(prefix = "socrates-server-"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const PORT = 4299;

/** A data folder with optional settings and keys, and its config. */
export function home(options: { settings?: object; keys?: Record<string, string> } = {}): ServerConfig {
  const dir = path.join(tempDir(), "home");
  mkdirSync(dir, { recursive: true });
  if (options.settings) writeFileSync(path.join(dir, "settings.json"), JSON.stringify(options.settings));
  if (options.keys) writeFileSync(path.join(dir, ".env"), Object.entries(options.keys).map(([k, v]) => `${k}="${v}"`).join("\n"));
  return resolveConfig({ SOCRATES_HOME: dir, SOCRATES_PORT: String(PORT) });
}

/** Scripted chat and router models chosen by model name: settings name them "chat" and "router". */
export function models(router: ScriptedStep[] = [], agent: ScriptedStep[] = []) {
  const routerModel = new ScriptedModel("test:router", router);
  const chatModel = new ScriptedModel("test:chat", agent);
  const makeModel = (_provider: string, model: string): ModelClient => (model === "router" ? routerModel : chatModel);
  return { routerModel, chatModel, makeModel };
}

export const SCRIPTED = { chat: { provider: "gemini", model: "chat" }, router: { provider: "gemini", model: "router" } };

export async function runtime(config: ServerConfig, deps: RuntimeDeps = {}) {
  const logs: string[] = [];
  const rt = await Runtime.open(config, {
    env: {},
    clock: fixedClock("2026-10-04T10:00:00Z"),
    makeEmbedder: () => new HashEmbedder(),
    // Never ask the real decider about a test's messages.
    makeDecider: () => null,
    // Never ask a real provider which models can see.
    detectVision: async (provider, model) => knownVision(provider, model),
    detectEfforts: async () => NO_EFFORTS,
    log: (m) => logs.push(m),
    ...deps,
  });
  cleanups.push(() => rt.close());
  return { rt, logs };
}

/** A server over a runtime, with a request helper that carries the session and this server's Host. */
export async function server(config: ServerConfig, deps: RuntimeDeps = {}, options: { webRoot?: string } = {}) {
  const { rt, logs } = await runtime(config, deps);
  const token = sessionToken();
  const app = await buildServer({ runtime: rt, token, webRoot: options.webRoot ?? null });
  cleanups.push(() => app.close());
  const request = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}`, ...headers }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { app, rt, token, request, logs };
}

/** A port nothing listens on right now. */
export async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

type Out = ({ text: string } | { toolCalls: { name: string; input: unknown }[] }) & { reasoning?: string };

/** The exact user message a router or agent request is about. */
export const messageOf = (request: ModelRequest) => {
  const first = request.messages[0]!.content;
  const text = typeof first === "string" ? first : first.map((p) => p.text).join("");
  return /<CURRENT_USER_MESSAGE>\n([\s\S]*?)\n<\/CURRENT_USER_MESSAGE>/.exec(text)?.[1]?.split("\n")[0] ?? "";
};

/** A model that answers by message, so overlapping runs each get their own answers, possibly after waiting. */
export class Responder implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private calls = 0;
  constructor(readonly id: string, private readonly respond: (message: string, request: ModelRequest) => Out | Promise<Out>) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const answer = Promise.resolve(this.respond(messageOf(request), request));
    const out = request.signal ? await abortable(answer, request.signal) : await answer;
    const toolCalls = "toolCalls" in out ? out.toolCalls.map((c) => ({ ...c, id: `call_${++this.calls}` })) : [];
    return { text: "text" in out ? out.text : "", toolCalls, stopReason: toolCalls.length ? "tool_use" : "end", usage: { promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, ...(out.reasoning ? { reasoning: out.reasoning } : {}) };
  }
}

/** One page's WebSocket: everything it received, and a way to wait for the next matching message. */
export interface Page {
  received: Record<string, unknown>[];
  send(command: object): void;
  next(match: (m: Record<string, any>) => boolean, timeoutMs?: number): Promise<Record<string, any>>;
  close(): Promise<void>;
}

/** A listening server on a free port with responder models; `page()` opens an authenticated live connection. */
export async function liveServer(router: Responder, agent: Responder, options: { settings?: object; deps?: RuntimeDeps; replayMax?: number } = {}) {
  const port = await freePort();
  const dir = path.join(tempDir(), "home");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(options.settings ?? SCRIPTED));
  const config = resolveConfig({ SOCRATES_HOME: dir, SOCRATES_PORT: String(port) });
  const { rt, logs } = await runtime(config, { makeModel: (_p, model) => (model === "router" ? router : agent), ...options.deps });
  const token = sessionToken();
  const app = await buildServer({ runtime: rt, token, webRoot: null, ...(options.replayMax ? { replayMax: options.replayMax } : {}) });
  await app.listen({ host: "127.0.0.1", port });
  cleanups.push(() => app.close());
  const url = `ws://127.0.0.1:${port}/api/live`;
  const page = async (headers: Record<string, string> = { authorization: `Bearer ${token}` }): Promise<Page> => {
    const socket = new WebSocket(url, { headers });
    const received: Record<string, any>[] = [];
    const waiters: { match: (m: Record<string, any>) => boolean; resolve: (m: Record<string, any>) => void; from: number }[] = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      for (const w of [...waiters]) if (w.match(message)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(message);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("unexpected-response", (_req, res) => {
        socket.terminate();
        reject(new Error(`refused ${res.statusCode}`));
      });
      socket.once("error", reject);
    });
    const close = () => new Promise<void>((resolve) => {
      if (socket.readyState === socket.CLOSED) return resolve();
      socket.once("close", () => resolve());
      socket.close();
    });
    cleanups.push(close);
    return {
      received,
      send: (command) => socket.send(JSON.stringify(command)),
      next: (match, timeoutMs = 5_000) => {
        const already = received.find(match);
        if (already) {
          received.splice(received.indexOf(already), 1);
          return Promise.resolve(already);
        }
        return new Promise((resolve, reject) => {
          const waiter = { match, from: received.length, resolve: (m: Record<string, any>) => {
            clearTimeout(timer);
            received.splice(received.indexOf(m), 1);
            resolve(m);
          } };
          const timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`no matching message; received ${JSON.stringify(received.map((m) => ({ type: m.type, kind: m.kind, id: m.id, conversation: m.conversation, approvals: m.approvals, busy: m.busy, task: m.task })))}`));
          }, timeoutMs);
          waiters.push(waiter);
        });
      },
      close,
    };
  };
  return { app, rt, token, port, url, page, logs };
}
