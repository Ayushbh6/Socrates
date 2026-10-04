import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGoal } from "../../../packages/router/test/helpers";
import { final } from "../../../packages/agent/test/helpers";
import { PORT, Responder, SCRIPTED, home, server, tempDir } from "./helpers";

/** A built web app: its page and one asset. */
function webRoot(): string {
  const root = tempDir();
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "index.html"), "<!doctype html><title>Socrates</title><div id=root></div><script type=module src=/assets/app.js></script>");
  writeFileSync(path.join(root, "assets/app.js"), "console.log('socrates');");
  return root;
}

describe("the web app", () => {
  it("is served behind the session, and a browser without it gets a readable page", async () => {
    const { request, app } = await server(home({ settings: SCRIPTED }), {}, { webRoot: webRoot() });
    const page = await request("GET", "/", undefined, { accept: "text/html" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain('<div id=root>');
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    const asset = await request("GET", "/assets/app.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.headers["cache-control"]).toBe("no-store");
    expect((await request("GET", "/api/nothing")).json()).toEqual({ error: { code: "not_found", message: "There is no such route." } });
    expect((await request("GET", "/assets/missing.js")).statusCode).toBe(404);

    const stranger = await app.inject({ method: "GET", url: "/", headers: { host: `127.0.0.1:${PORT}`, accept: "text/html,application/xhtml+xml" } });
    expect(stranger.statusCode).toBe(401);
    expect(stranger.headers["content-type"]).toContain("text/html");
    expect(stranger.body).toContain("pnpm socrates");
    expect(stranger.body).not.toContain("<div id=root>");
    const script = await app.inject({ method: "GET", url: "/assets/app.js", headers: { host: `127.0.0.1:${PORT}` } });
    expect(script.statusCode).toBe(401);
    expect(script.json().error.code).toBe("unauthorized");
  });

  it("says how to start it when it is not built", async () => {
    const { request } = await server(home({ settings: SCRIPTED }));
    expect((await request("GET", "/")).body).toContain("pnpm socrates");
  });

  it("gives each history item its message's sequence number, for resuming the live connection", async () => {
    const { rt, request } = await server(home({ settings: SCRIPTED }), { makeModel: (_p, model) => (model === "router" ? new Responder("r", () => createGoal("Work", "Do it")) : new Responder("a", () => final())) });
    await rt.socrates!.handle("Do the work.");
    const [item] = (await request("GET", "/api/history")).json().items;
    const message = rt.store.listEvents({ type: "user_message" })[0]!;
    expect(item).toMatchObject({ id: message.id, seq: message.seq, message: "Do the work." });
  });
});
