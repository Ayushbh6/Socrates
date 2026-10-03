import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelClient } from "@socrates/contracts";
import { HashEmbedder, ScriptedModel, type ScriptedStep } from "@socrates/providers";
import { fixedClock } from "@socrates/shared";
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
    log: (m) => logs.push(m),
    ...deps,
  });
  cleanups.push(() => rt.close());
  return { rt, logs };
}

/** A server over a runtime, with a request helper that carries the session and this server's Host. */
export async function server(config: ServerConfig, deps: RuntimeDeps = {}) {
  const { rt, logs } = await runtime(config, deps);
  const token = sessionToken();
  const app = await buildServer({ runtime: rt, token });
  cleanups.push(() => app.close());
  const request = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}`, ...headers }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { app, rt, token, request, logs };
}
