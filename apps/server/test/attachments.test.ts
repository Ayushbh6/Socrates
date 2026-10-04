import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { createGoal } from "../../../packages/router/test/helpers";
import { PORT, Responder, home, liveServer, server } from "./helpers";

const png = readFileSync(path.join(import.meta.dirname, "../../../packages/tools/test/fixture-label.png"));
const id = "[0-9a-f]{32}";

describe("attachments", () => {
  async function upload(app: Awaited<ReturnType<typeof server>>["app"], token: string, body: Buffer | string, type = "image/png", name = "label.png") {
    return app.inject({ method: "POST", url: `/api/attachments?name=${encodeURIComponent(name)}`, headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}`, "content-type": type }, payload: body });
  }

  it("stores an image once by its content, serves it back, and refuses what is not an image", async () => {
    const config = home();
    const { app, token } = await server(config);
    const first = await upload(app, token, png, "image/png", "/Users/me/Desktop/label.png");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ id: expect.stringMatching(new RegExp(`^${id}$`)), name: "label.png", media_type: "image/png", width: 400, height: 400, bytes: png.length });
    // The same bytes under another name are the same stored image; a page never learns where it is stored.
    const again = await upload(app, token, png, "image/png", "copy.png");
    expect(again.json()).toMatchObject({ id: first.json().id, name: "copy.png" });
    expect(readdirSync(config.attachmentsDir)).toEqual([`${first.json().id}.png`]);
    expect(JSON.stringify(first.json())).not.toContain(config.home);

    const served = await app.inject({ method: "GET", url: `/api/attachments/${first.json().id}`, headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}` } });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.rawPayload.equals(png)).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/attachments/../ledger.db", headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}` } })).statusCode).toBe(404);

    expect((await upload(app, token, Buffer.from("plain text pretending"), "image/png")).json().error.message).toContain("PNG, JPEG, GIF or WebP");
    expect((await app.inject({ method: "POST", url: "/api/attachments", headers: { host: `127.0.0.1:${PORT}`, "content-type": "image/png" }, payload: png })).statusCode).toBe(401);
  });

  it("sends attachments with a message: saved on it, shown to pages without their path, and refused when missing", async () => {
    const { page, rt, app, token, port } = await liveServer(new Responder("r", () => createGoal("Labels", "Read labels")), new Responder("a", () => final({ full_answer: "It says ORCHID." })));
    const stored = (await app.inject({ method: "POST", url: "/api/attachments?name=label.png", headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, "content-type": "image/png" }, payload: png })).json();
    const p = await page();
    p.send({ type: "hello" });
    p.send({ type: "send", id: "m1", text: "What does it say?", to: "main", attachments: [{ id: stored.id, name: "label.png" }] });
    await p.next((m) => m.type === "result" && m.id === "m1");
    const event = rt.store.listEvents({ type: "user_message" }).at(-1)!;
    expect(event.payload).toMatchObject({ text: "What does it say?", attachments: [{ id: stored.id, name: "label.png", path: path.join(rt.config.attachmentsDir, `${stored.id}.png`), width: 400, height: 400 }] });
    const message = p.received.find((m) => m.type === "activity" && m.kind === "message")!;
    expect(message.attachments).toEqual([{ id: stored.id, name: "label.png", media_type: "image/png", width: 400, height: 400, bytes: png.length }]);
    const history = await app.inject({ method: "GET", url: "/api/history", headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } });
    expect(history.json().items[0].attachments).toEqual(message.attachments);

    p.send({ type: "send", id: "m2", text: "And this?", to: "main", attachments: [{ id: "f".repeat(32), name: "gone.png" }] });
    expect(await p.next((m) => m.type === "error" && m.id === "m2")).toMatchObject({ code: "attachment_missing" });
    p.send({ type: "send", id: "m3", text: "Too many", to: "main", attachments: Array.from({ length: 11 }, () => ({ id: stored.id, name: "x.png" })) });
    expect((await p.next((m) => m.type === "error" && m.code === "invalid_command")).message).toContain("attachments");
  });
});
