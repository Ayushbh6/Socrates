import { afterEach, describe, expect, it, vi } from "vitest";
import { type CallRecord, type DeciderClient, type DecisionRequest, type DecisionResponse, ModelError } from "@socrates/contracts";
import { DECIDER_MODEL, DECIDER_BACKUP_MODEL, FailoverDecider, makeDecider, withDecisionRecording } from "../src";

const request: DecisionRequest = {
  state: "The user's full request and history.",
  questions: { recall: { instructions: "Would recall help?", yes: "Yes", no: "No" } },
  trace: { role: "decision", userEventId: "evt_1" },
};
const response: DecisionResponse = { model: DECIDER_BACKUP_MODEL, probabilities: { recall: 0.8 }, usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.00000042 }, id: "backup-1" };
function client(id: string, decide: DeciderClient["decide"]): DeciderClient { return { id, decide: vi.fn(decide) }; }
const failed = () => { throw new ModelError("No endpoints found", "invalid_request", 404); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("decider failover", () => {
  it("uses one call when the primary succeeds, including a zero probability", async () => {
    const primary = client("primary", async () => ({ ...response, model: "primary", probabilities: { recall: 0 } }));
    const backup = client("backup", async () => response);
    const out = await new FailoverDecider({ primary, backup }).decide(request);
    expect(out.probabilities.recall).toBe(0);
    expect(primary.decide).toHaveBeenCalledTimes(1);
    expect(backup.decide).not.toHaveBeenCalled();
  });

  it.each([404, 429, 500])("recovers HTTP %s through the production factory and records both actual models", async status => {
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sent.push(body);
      return body.model === DECIDER_MODEL
        ? Response.json({ error: { message: "Unavailable" } }, { status })
        : Response.json({ model: "typesafe/jev-1.14-20261014", answers: { recall: { noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 1, cost: 0.00000042 } });
    }));
    const records: CallRecord[] = [];
    const decider = makeDecider({ OPENROUTER_API_KEY: "test" }, r => records.push(r))!;
    const images = [{ mediaType: "image/png" as const, data: "YWJj", width: 10, height: 20 }];
    await expect(decider.decide({ ...request, images, timeoutMs: 2_000 })).resolves.toMatchObject({ probabilities: { recall: 0.8 } });
    expect(sent.map(body => body.model)).toEqual([DECIDER_MODEL, DECIDER_BACKUP_MODEL]);
    expect(sent[1]).toEqual({ ...sent[0], model: DECIDER_BACKUP_MODEL });
    expect(sent[1].state).toEqual([request.state, { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } }]);
    expect(sent[1]).not.toHaveProperty("timeoutMs");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ model: `openrouter:${DECIDER_MODEL}`, error: { status }, trace: request.trace });
    expect(records[1]).toMatchObject({ model: `openrouter:${DECIDER_BACKUP_MODEL}`, servedBy: "typesafe/jev-1.14-20261014", error: null, trace: request.trace, response: { meta: { usage: { cost: 0.00000042 }, imageCount: 1 } } });
  });

  it.each(["network", "malformed"])("recovers a %s response", async failure => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (++calls === 1) {
        if (failure === "network") throw new Error("Connection reset");
        return Response.json({ answers: { recall: { noul: 2 } } });
      }
      return Response.json({ answers: { recall: { noul: 0.8 } } });
    }));
    await expect(makeDecider({ OPENROUTER_API_KEY: "test" })!.decide(request)).resolves.toMatchObject({ probabilities: { recall: 0.8 } });
    expect(calls).toBe(2);
  });

  it("uses the backup during the primary cooldown and tries the primary again after 30 seconds", async () => {
    let time = 100;
    const primary = client("primary", failed);
    const backup = client("backup", async () => response);
    const decider = new FailoverDecider({ primary, backup, now: () => time });
    await decider.decide(request);
    time = 29_000;
    await decider.decide(request);
    expect(primary.decide).toHaveBeenCalledTimes(1);
    vi.mocked(primary.decide).mockResolvedValue({ ...response, model: "primary" });
    time = 30_101;
    await expect(decider.decide(request)).resolves.toMatchObject({ model: "primary" });
    expect(primary.decide).toHaveBeenCalledTimes(2);
    expect(backup.decide).toHaveBeenCalledTimes(2);
  });

  it.each([2_000, 30_000])("reserves backup time inside the %s ms deadline, even if the primary ignores abort", async timeoutMs => {
    vi.useFakeTimers();
    let resolvePrimary!: (response: DecisionResponse) => void;
    const primary = client("primary", () => new Promise(resolve => { resolvePrimary = resolve; }));
    const backup = client("backup", async () => response);
    const records: CallRecord[] = [];
    const decider = new FailoverDecider({ primary: withDecisionRecording(primary, r => records.push(r)), backup: withDecisionRecording(backup, r => records.push(r)) });
    const pending = decider.decide({ ...request, timeoutMs });
    await vi.advanceTimersByTimeAsync(timeoutMs - Math.min(timeoutMs / 2, 5_000) + 10);
    await expect(pending).resolves.toEqual(response);
    expect(vi.mocked(primary.decide).mock.calls[0]![1]!.aborted).toBe(true);
    expect(backup.decide).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(2);
    expect(records[0]!.error).toMatchObject({ kind: "aborted" });
    resolvePrimary({ ...response, model: "late-primary" });
    await vi.advanceTimersByTimeAsync(10);
    expect(records).toHaveLength(2);
  });

  it("honours cancellation without starting the backup or cooling down the primary", async () => {
    vi.useFakeTimers();
    const primary = client("primary", () => new Promise(() => {}));
    const backup = client("backup", async () => response);
    const decider = new FailoverDecider({ primary, backup });
    const controller = new AbortController();
    const pending = decider.decide(request, controller.signal);
    const rejected = expect(pending).rejects.toThrow("Stopped");
    controller.abort(new Error("Stopped"));
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(backup.decide).not.toHaveBeenCalled();
    vi.mocked(primary.decide).mockResolvedValue(response);
    await decider.decide(request);
    expect(primary.decide).toHaveBeenCalledTimes(2);
  });

  it("bounds both attempts and discards a hanging backup", async () => {
    vi.useFakeTimers();
    const primary = client("primary", failed);
    const backup = client("backup", () => new Promise(() => {}));
    const pending = new FailoverDecider({ primary, backup }).decide(request);
    const rejected = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(2_010);
    await rejected;
    expect(vi.mocked(backup.decide).mock.calls[0]![1]!.aborted).toBe(true);
  });

  it.each([401, 403, 402])("does not retry shared credentials or billing failure %s", async status => {
    const primary = client("primary", async () => { throw new ModelError("Account error", status === 402 ? "invalid_request" : "authentication", status); });
    const backup = client("backup", async () => response);
    await expect(new FailoverDecider({ primary, backup }).decide(request)).rejects.toMatchObject({ status });
    expect(backup.decide).not.toHaveBeenCalled();
  });

  it("rejects oversized input without trying either model and exposes failure when both fail", async () => {
    const primary = client("primary", failed);
    const backup = client("backup", async () => { throw new ModelError("Backup down", "server", 503); });
    const decider = new FailoverDecider({ primary, backup });
    await expect(decider.decide({ ...request, state: "word ".repeat(160_000) })).rejects.toThrow("157286-token");
    expect(primary.decide).not.toHaveBeenCalled();
    expect(backup.decide).not.toHaveBeenCalled();
    await expect(decider.decide(request)).rejects.toThrow("Backup down");
  });
});
