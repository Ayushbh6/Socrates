import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallRecord } from "@socrates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CallLog } from "../src";

let dir: string;
let log: CallLog;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "socrates-calls-")); log = CallLog.open(join(dir, "calls.db")); });
afterEach(() => { log.close(); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function call(over: Partial<CallRecord> & { trace?: CallRecord["trace"] } = {}, at = "2026-10-06T10:00:00.000Z"): CallRecord {
  return {
    id: `call_${++n}`, startedAt: at, model: "test:m", servedBy: "m-1", streamed: true,
    trace: { role: "work", userEventId: "evt_a", turnId: "turn_a", step: 1 },
    request: { system: "sys", messages: [{ role: "user", content: "hello" }], tools: [{ name: "read", description: "d", inputSchema: {} }], toolChoice: "auto", maxOutputTokens: 100, temperature: null, effort: null },
    response: { text: "hi", toolCalls: [], reasoning: "thinking", stopReason: "end", usage: { promptTokens: 1000, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0, reasoningTokens: 40 }, meta: { id: "r1" } },
    error: null, ms: 2000, firstTokenMs: 500, tokensPerSecond: 66.7, cost: { usd: 0.01, source: "price" },
    ...over,
  };
}

describe("the call log", () => {
  it("keeps a call whole: the request as sent and the reply", () => {
    const saved = call();
    log.record(saved);
    const got = log.get(saved.id)!;
    expect(got).toMatchObject({ id: saved.id, role: "work", model: "test:m", userEventId: "evt_a", turnId: "turn_a", step: 1, streamed: true, ok: true, promptTokens: 1000, cacheReadTokens: 800, reasoningTokens: 40, ms: 2000, firstTokenMs: 500, tokensPerSecond: 66.7, costUsd: 0.01, costSource: "price" });
    expect(got.request).toEqual({ ...saved.request, toolChoice: "auto" });
    expect(got.response).toEqual({ text: "hi", toolCalls: [], reasoning: "thinking", meta: { id: "r1" } });
    expect(log.get("nope")).toBeNull();
  });

  it("keeps a failed call with its error and no reply", () => {
    const failed = call({ response: null, error: { kind: "server", status: 500, message: "boom" }, cost: null, tokensPerSecond: null });
    log.record(failed);
    expect(log.get(failed.id)).toMatchObject({ ok: false, error: { kind: "server", status: 500, message: "boom" }, response: null, promptTokens: 0, costUsd: null });
  });

  it("stores each message once however many calls send it", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, content: `message ${i} `.repeat(200) }));
    for (let i = 1; i <= 10; i++) log.record(call({ request: { ...call().request, messages: history.slice(0, 30 + i) } }));
    const raw = history.slice(0, 40).reduce((sum, m) => sum + m.content.length, 0);
    // Ten calls would send about 350 messages; the log holds the 40 distinct ones, compressed.
    expect(log.storedBytes()).toBeLessThan(raw / 5);
    expect(log.list({ limit: 1 })[0]!.messageCount).toBe(40);
    expect(log.get(log.list({ limit: 1 })[0]!.id)!.request.messages).toHaveLength(40);
  });

  it("keeps the type and size of an image, not its bytes", () => {
    const picture = { mediaType: "image/png" as const, data: "A".repeat(4000) };
    const saved = call({ request: { ...call().request, messages: [{ role: "user", content: "look", images: [picture] }] } });
    log.record(saved);
    expect(log.get(saved.id)!.request.messages[0]).toEqual({ role: "user", content: "look", images: [{ mediaType: "image/png", bytes: 3000 }] });
  });

  it("lists calls newest first, by message, turn or role", () => {
    const a = call({}, "2026-10-06T10:00:00.000Z");
    const b = call({ trace: { role: "router", userEventId: "evt_a" } }, "2026-10-06T10:00:01.000Z");
    const c = call({ trace: { role: "work", userEventId: "evt_b", turnId: "turn_b" } }, "2026-10-06T10:00:02.000Z");
    for (const x of [a, b, c]) log.record(x);
    expect(log.list().map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(log.list({ userEventId: "evt_a" }).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(log.forQuestion("evt_a").map((r) => r.id)).toEqual([a.id, b.id]);
    expect(log.list({ turnId: "turn_b" }).map((r) => r.id)).toEqual([c.id]);
    expect(log.list({ role: "router" }).map((r) => r.id)).toEqual([b.id]);
    expect(log.list({ before: log.list({ limit: 1 })[0]!.id ? 3 : 0 }).map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("adds up tokens, cost, cache and speed, and says how much of the cost was priced", () => {
    log.record(call());
    log.record(call({ cost: null, tokensPerSecond: 33.3, firstTokenMs: 1500, response: { ...call().response!, usage: { promptTokens: 3000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 } } }));
    const t = log.totals();
    expect(t).toMatchObject({ calls: 2, failed: 0, promptTokens: 4000, outputTokens: 400, cacheReadTokens: 800, cacheHitRate: 0.2, costUsd: 0.01, priced: 1, ms: 4000, tokensPerSecond: 50, firstTokenMs: 1000 });
    expect(log.totals("2027-01-01")).toMatchObject({ calls: 0, cacheHitRate: null, tokensPerSecond: null });
  });

  it("breaks the numbers down by role and model", () => {
    log.record(call());
    log.record(call({ trace: { role: "router", userEventId: "evt_a" }, model: "test:small" }));
    const rows = log.breakdown();
    expect(rows.map((r) => [r.role, r.model, r.calls])).toEqual(expect.arrayContaining([["work", "test:m", 1], ["router", "test:small", 1]]));
  });

  it("groups calls by the message they were made for", () => {
    log.record(call({}, "2026-10-06T10:00:00.000Z"));
    log.record(call({ trace: { role: "work", userEventId: "evt_a", step: 2 } }, "2026-10-06T10:00:05.000Z"));
    log.record(call({ trace: { role: "work", userEventId: "evt_b" } }, "2026-10-06T11:00:00.000Z"));
    log.record(call({ trace: { role: "embedding" } }, "2026-10-06T11:30:00.000Z"));
    const questions = log.questions();
    expect(questions.map((q) => [q.userEventId, q.calls])).toEqual([["evt_b", 1], ["evt_a", 2]]);
    expect(log.questions({ before: "2026-10-06T11:00:00.000Z" }).map((q) => q.userEventId)).toEqual(["evt_a"]);
  });

  it("forgets old calls and the saved parts only they used", () => {
    log.record(call({ request: { ...call().request, messages: [{ role: "user", content: "old only" }] } }, "2026-08-01T00:00:00.000Z"));
    log.record(call({ request: { ...call().request, messages: [{ role: "user", content: "shared" }] } }, "2026-08-01T00:00:00.000Z"));
    const keep = call({ request: { ...call().request, messages: [{ role: "user", content: "shared" }] } }, "2026-10-06T00:00:00.000Z");
    log.record(keep);
    const before = log.storedBytes();
    expect(log.prune("2026-09-01T00:00:00.000Z")).toBe(2);
    expect(log.list().map((r) => r.id)).toEqual([keep.id]);
    expect(log.storedBytes()).toBeLessThan(before);
    // The message the remaining call shares is still whole.
    expect(log.get(keep.id)!.request.messages).toEqual([{ role: "user", content: "shared" }]);
  });
});
