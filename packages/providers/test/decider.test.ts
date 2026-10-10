import { type IncomingMessage, createServer } from "node:http";
import { type CallRecord, ModelError } from "@socrates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DECIDER_MODEL, OpenRouterDecider, makeDecider, withDecisionRecording } from "../src";

const servers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!();
});

/** A local HTTP server that records request bodies and answers with the handler's status and JSON. */
async function serve(handler: (body: any) => { status?: number; json: unknown }) {
  const seen: { path: string; body: any; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ path: req.url!, body, headers: req.headers });
      const out = handler(body);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(() => new Promise<void>((done) => server.close(() => done())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/alpha/decisions`, seen };
}

const QUESTIONS = {
  recall: { instructions: "Would looking up what is known about the user help?", yes: "Depends on the past.", no: "Self-contained." },
  save: { instructions: "Does the user state a lasting fact?", yes: "A lasting fact.", no: "One-off." },
};
const REPLY = { model: "perplexity/pplx-decider-v1.1-27b-20261006", answers: { recall: { type: "noul", noul: 0.12 }, save: { type: "noul", noul: 0.98 } }, usage: { input_tokens: 97, output_tokens: 1, cost: 0.00000194 }, id: "gen-dec-1" };

describe("the decider", () => {
  it("sends yes/no questions to OpenRouter's decisions endpoint and reads back P(yes) with the price", async () => {
    const { url, seen } = await serve(() => ({ json: REPLY }));
    const decider = new OpenRouterDecider({ apiKey: "sk-test", url });
    expect(decider.id).toBe(`openrouter:${DECIDER_MODEL}`);
    const out = await decider.decide({ state: "I always want short answers.", questions: QUESTIONS });
    expect(seen[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(seen[0]!.body).toEqual({
      model: DECIDER_MODEL,
      state: "I always want short answers.",
      questions: {
        recall: { type: "noul", instructions: QUESTIONS.recall.instructions, criteria: { true: "Depends on the past.", false: "Self-contained." } },
        save: { type: "noul", instructions: QUESTIONS.save.instructions, criteria: { true: "A lasting fact.", false: "One-off." } },
      },
    });
    expect(out).toEqual({ model: REPLY.model, probabilities: { recall: 0.12, save: 0.98 }, usage: { inputTokens: 97, outputTokens: 1, costUsd: 0.00000194 }, id: "gen-dec-1" });
  });

  it("fails with a ModelError when the answer is missing or not a probability, or the key is refused", async () => {
    const missing = await serve(() => ({ json: { ...REPLY, answers: { recall: { type: "noul", noul: 0.5 } } } }));
    await expect(new OpenRouterDecider({ apiKey: "k", url: missing.url }).decide({ state: "x", questions: QUESTIONS })).rejects.toMatchObject({ kind: "server" });
    const odd = await serve(() => ({ json: { ...REPLY, answers: { recall: { noul: 1.5 }, save: { noul: 0.5 } } } }));
    await expect(new OpenRouterDecider({ apiKey: "k", url: odd.url }).decide({ state: "x", questions: QUESTIONS })).rejects.toBeInstanceOf(ModelError);
    const refused = await serve(() => ({ status: 401, json: { error: "no" } }));
    await expect(new OpenRouterDecider({ apiKey: "bad", url: refused.url }).decide({ state: "x", questions: QUESTIONS })).rejects.toMatchObject({ kind: "authentication", status: 401 });
  });

  it("is made only when there is an OpenRouter key", () => {
    expect(makeDecider({})).toBeNull();
    expect(makeDecider({ OPENROUTER_API_KEY: "sk-test" })?.id).toBe(`openrouter:${DECIDER_MODEL}`);
  });

  it("records each call as a decision with its probabilities and price, and failures too", async () => {
    const { url } = await serve((body) => (body.state === "boom" ? { status: 500, json: { error: "down" } } : { json: REPLY }));
    const records: CallRecord[] = [];
    const decider = withDecisionRecording(new OpenRouterDecider({ apiKey: "k", url }), (r) => records.push(r));
    await decider.decide({ state: "I use tabs.", questions: QUESTIONS, trace: { role: "decision", userEventId: "evt_1", turnId: "turn_1" } });
    await expect(decider.decide({ state: "boom", questions: QUESTIONS })).rejects.toBeInstanceOf(ModelError);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      model: `openrouter:${DECIDER_MODEL}`,
      servedBy: REPLY.model,
      trace: { role: "decision", userEventId: "evt_1", turnId: "turn_1" },
      request: { messages: [{ role: "user", content: "I use tabs." }] },
      response: { text: '{"recall":0.12,"save":0.98}', usage: { promptTokens: 97, outputTokens: 1 }, meta: { usage: { cost: 0.00000194 } } },
      error: null,
    });
    expect(records[0]!.request.system).toContain("recall: Would looking up");
    expect(records[1]).toMatchObject({ trace: { role: "decision" }, response: null, error: { kind: "server", status: 500 } });
  });
});
