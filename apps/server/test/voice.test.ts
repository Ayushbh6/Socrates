import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { createGoal } from "../../../packages/router/test/helpers";
import { PORT, Responder, home, liveServer, server } from "./helpers";

/** A RIFF header and a little silence: what the page sends. */
const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40), Buffer.alloc(3200)]);

function fakeOpenRouter(reply: { status: number; body: unknown }) {
  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

describe("voice", () => {
  const post = (app: Awaited<ReturnType<typeof server>>["app"], token: string, body: Buffer, type = "audio/wav") =>
    app.inject({ method: "POST", url: "/api/transcribe", headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}`, "content-type": type }, payload: body });

  it("turns a recording into text with the chosen OpenRouter model, logs the call with its cost, and keeps no audio", async () => {
    const net = fakeOpenRouter({ status: 200, body: { text: " List the failing tests. ", usage: { seconds: 2.1, cost: 0.000105 } } });
    const { app, rt, token, request } = await server(home({ keys: { OPENROUTER_API_KEY: "or-key" } }), { fetch: net.fetch });
    expect((await request("GET", "/api/status")).json().voice).toEqual({ ready: true, model: "mistralai/voxtral-small-24b-2507-stt", language: null });

    const said = await post(app, token, wav);
    expect(said.statusCode).toBe(200);
    expect(said.json()).toEqual({ text: "List the failing tests.", seconds: 2.1 });
    expect(net.sent[0]).toMatchObject({ url: "https://openrouter.ai/api/v1/audio/transcriptions", auth: "Bearer or-key", body: { model: "mistralai/voxtral-small-24b-2507-stt", input_audio: { data: wav.toString("base64"), format: "wav" } } });
    expect(net.sent[0]!.body.language).toBeUndefined();

    await rt.flushCalls();
    const [call] = rt.calls!.list({ role: "transcription" });
    expect(call).toMatchObject({ role: "transcription", model: "openrouter:mistralai/voxtral-small-24b-2507-stt", ok: true, costUsd: 0.000105, costSource: "reported" });
    expect(JSON.stringify(rt.calls!.get(call!.id))).not.toContain(wav.toString("base64").slice(0, 40));

    // A model and language chosen in Settings apply to the next recording, without a restart.
    const saved = await request("PUT", "/api/settings", { voice: { model: "meta/muse-voice-transcribe-1.0", language: "de" } });
    expect(saved.statusCode).toBe(200);
    await post(app, token, Buffer.from("webm bytes"), "audio/webm;codecs=opus");
    expect(net.sent[1]!.body).toMatchObject({ model: "meta/muse-voice-transcribe-1.0", language: "de", input_audio: { format: "webm" } });
    expect((await request("PUT", "/api/settings", { voice: { language: "german" } })).statusCode).toBe(400);
  });

  it("says what went wrong: no key, a format it cannot send, an empty body, a provider error", async () => {
    const without = await server(home());
    expect((await without.request("GET", "/api/status")).json().voice.ready).toBe(false);
    const none = await post(without.app, without.token, wav);
    expect(none.statusCode).toBe(502);
    expect(none.json().error.message).toContain("needs an OpenRouter key");

    const net = fakeOpenRouter({ status: 402, body: { error: { message: "Insufficient credits" } } });
    const { app, rt, token } = await server(home({ keys: { OPENROUTER_API_KEY: "or-key" } }), { fetch: net.fetch });
    expect((await post(app, token, wav, "audio/x-unknown")).statusCode).toBe(415);
    expect((await post(app, token, Buffer.alloc(0))).statusCode).toBe(400);
    const failed = await post(app, token, wav);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.message).toBe("OpenRouter could not transcribe (402): Insufficient credits");
    await rt.flushCalls();
    expect(rt.calls!.list({ role: "transcription" })[0]).toMatchObject({ ok: false, error: { status: 402 } });
  });

  it("waits for the transcript over a real connection: the upload finishing is not the page leaving", async () => {
    // Node's request "close" fires once the body is read; the first version took that for a page that went away and stopped every transcription.
    const net = fakeOpenRouter({ status: 200, body: { text: "Over a socket.", usage: { seconds: 1 } } });
    // Like the real network, it gives up when the request is aborted.
    const slow = (async (url: string | URL | Request, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 300));
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return net.fetch(url, init);
    }) as typeof fetch;
    const { token, port } = await liveServer(new Responder("r", () => createGoal("x", "y")), new Responder("a", () => final({ full_answer: "ok" })), { deps: { env: { OPENROUTER_API_KEY: "or-key" }, fetch: slow } });
    // A few seconds of speech, as a page sends it.
    const recording = Buffer.concat([wav, Buffer.alloc(200_000)]);
    const response = await fetch(`http://127.0.0.1:${port}/api/transcribe`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "audio/wav" }, body: recording });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "Over a socket.", seconds: 1 });
  });
});
