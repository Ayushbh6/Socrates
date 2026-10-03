import { type HistoryCheckpoint, type ModelRequest, type ModelResponse, type TaskHandover, userText } from "@socrates/contracts";
import { ScriptedModel, TokenCalibration } from "@socrates/providers";
import { countTokens } from "@socrates/shared";
import { LedgerStore, type Turn } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { assembleContext, createCompactor, DEFAULT_BUDGETS, type ContextBudgets, renderRecord, requestTokens, retrievedHistory, validateSummary } from "../src";
import { continueTask } from "../../router/test/helpers";
import { final, type World, world } from "./helpers";

const zeroUsage = { promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const reply = (text: string, extra: Partial<ModelResponse> = {}): ModelResponse => ({ text, toolCalls: [], stopReason: "end", usage: zeroUsage, ...extra });
const checkpoint = (from: number, to: number, extra: Partial<HistoryCheckpoint> = {}): HistoryCheckpoint => ({ summary: "Work so far", turns_covered: { from, to }, progress: "", decisions: [], constraints: [], files_touched: [], open_threads: [], outstanding_requests: [], next_steps: [], key_evidence: [], ...extra });
const capsule = (extra: Partial<TaskHandover> = {}): TaskHandover => ({ task_objective: "Review", completion_criteria: "", verified_progress: "", outstanding_requests: [], decisions: [], constraints: [], files_and_tests: [], blockers: [], next_action: "Continue", key_evidence: [], ...extra });
const writing = (extra: Partial<HistoryCheckpoint> = {}) => (r: ModelRequest) => {
  const match = /<COMPACTED_SPAN turns (\d+)(?:–(\d+))?>/.exec(userText(r.messages[0]!.content))!;
  return { text: JSON.stringify(checkpoint(Number(match[1]), Number(match[2] ?? match[1]), extra)) };
};
function begin(w: Pick<World, "store" | "taskId">, text = "Continue") {
  return w.store.bindTurn({ userEventId: w.store.recordUserMessage(text).id, taskId: w.taskId, route: "continue" });
}
function end(w: Pick<World, "store" | "taskId">, text: string, answer: string) {
  const t = begin(w, text);
  w.store.completeTurn(t.id, { responseEventId: w.store.recordResponse(answer, { turn_id: t.id }).id, continuationNote: "Continue" });
  return w.store.requireTurn(t.id);
}
function compact(w: Pick<World, "store" | "taskId">, turn: Turn, model: ScriptedModel, overrides: Partial<ContextBudgets> = {}) {
  const budgets = { ...DEFAULT_BUDGETS, ...overrides };
  const assemble = (previousTurn = budgets.previousTurn) => assembleContext({ store: w.store, turn, capabilities: { skills: [], mcpTools: [] }, dependsOn: [], part: null, now: new Date(), timeZone: "UTC", budgets: { ...budgets, previousTurn } });
  const run = createCompactor({ store: w.store, turn, model, budgets, assemble, retryDelaysMs: [0] });
  return { run, messages: [{ role: "user" as const, content: assemble() }], measure: (ms: Parameters<typeof requestTokens>[1]) => requestTokens("", ms) };
}
function exhaustChat(w: Pick<World, "store" | "taskId" | "goalId">) {
  const chat = w.store.currentChat(w.taskId);
  w.store.recordCompaction({ goal_id: w.goalId, task_id: w.taskId, chat_id: chat.id }, { layers: [], checkpoint: null, before_tokens: 0, after_tokens: 0 });
  return chat;
}

describe("compactor request and turn budgets", () => {
  it("refuses a production-sized retry that would cross 180k", async () => {
    const w = await world();
    for (let i = 0; i < 24; i++) end(w, `Explain section ${i}`, "word ".repeat(8250));
    end(w, "Short follow-up", "OK");
    const model = new ScriptedModel("summary", [{ text: "invalid ".repeat(15900) }, writing()]);
    const c = compact(w, begin(w), model);
    await c.run(c.messages, c.measure, new AbortController().signal);
    expect(model.requests).toHaveLength(1);
    const first = model.requests[0]!;
    expect(requestTokens(first.system, first.messages)).toBeLessThan(180000);
    expect(requestTokens(first.system, [...first.messages, { role: "assistant", content: "invalid ".repeat(15900) }])).toBeGreaterThan(180000);
    expect(w.store.pendingOmission(w.taskId)).not.toBeNull();
    expect(w.store.latestHistoryRecord(w.taskId)).toBeNull();
  });

  it("counts native replay data before a retry", async () => {
    const w = await world(); end(w, "Old work", "word ".repeat(4000)); end(w, "Recent", "OK");
    const model = new ScriptedModel("summary", [() => reply("bad", { raw: { provider: "test", content: { reasoning: "word ".repeat(9000) } } }), writing()]);
    const c = compact(w, begin(w), model, { ceiling: 10000, verbatimWindow: 100 });
    await c.run(c.messages, c.measure, new AbortController().signal);
    expect(model.requests).toHaveLength(1);
    expect(w.store.pendingOmission(w.taskId)).not.toBeNull();
  });

  it("shares known calibration with the compactor, without mixing model identities", async () => {
    const w = await world(); end(w, "Old work", "word ".repeat(6000)); end(w, "Recent", "OK");
    const model = new ScriptedModel("summary", [writing()]);
    const c = compact(w, begin(w), model, { ceiling: 12000, verbatimWindow: 100 });
    const calibration = new TokenCalibration();
    calibration.observe(model.id, 100, { ...zeroUsage, promptTokens: 200 });
    await c.run(c.messages, c.measure, new AbortController().signal, { calibration, recordUsage: () => {}, tokensExhausted: () => false });
    expect(model.requests).toHaveLength(0);
    expect(calibration.ratio("worker")).toBe(1);
    expect(w.store.pendingOmission(w.taskId)).not.toBeNull();
  });

  it("calibrates from an invalid response before considering its retry", async () => {
    const w = await world(); end(w, "Old work", "word ".repeat(4000)); end(w, "Recent", "OK");
    const model = new ScriptedModel("summary", [r => reply("bad", { usage: { ...zeroUsage, promptTokens: requestTokens(r.system, r.messages) * 3 } }), writing()]);
    const c = compact(w, begin(w), model, { ceiling: 10000, verbatimWindow: 100 });
    const calibration = new TokenCalibration(); let spent = 0;
    await c.run(c.messages, c.measure, new AbortController().signal, { calibration, recordUsage: u => { spent += u.promptTokens; }, tokensExhausted: () => false });
    expect(model.requests).toHaveLength(1);
    expect(calibration.ratio(model.id)).toBe(3);
    expect(spent).toBeGreaterThan(10000);
  });

  it.each(["checkpoint", "invalid", "handover"])("counts %s usage before more work or another summary attempt", async kind => {
    const w = await world(); end(w, "Old work", "word ".repeat(4000)); end(w, "Recent", "OK");
    if (kind === "handover") exhaustChat(w);
    const h = w.socrates([continueTask()], [final()], {
      limits: { maxTokens: 1000 }, budgets: { trigger: 5000, target: 4000, verbatimWindow: 100, maxCompactionsPerChat: 1 },
      compactor: [r => reply(kind === "invalid" ? "bad" : kind === "handover" ? JSON.stringify(capsule()) : writing()(r).text, { usage: { ...zeroUsage, promptTokens: 5000, outputTokens: 1000 } }), writing()],
    });
    const result = await h.socrates.handle("Continue");
    expect(h.compactor.requests).toHaveLength(1);
    expect(h.model.requests).toHaveLength(1);
    expect(h.model.requests[0]!.toolChoice).toBe("none");
    expect(result.kind === "answered" && result.parts[0]!.stop).toBe("tokens");
  });

  it("charges both attempts of an invalid-then-valid summary before continuing the worker", async () => {
    const w = await world(); end(w, "Old work", "word ".repeat(4000)); end(w, "Recent", "OK");
    const h = w.socrates([continueTask()], [final()], {
      limits: { maxTokens: 1000 }, budgets: { trigger: 5000, target: 4000, verbatimWindow: 100 },
      compactor: [() => reply("bad", { usage: { ...zeroUsage, outputTokens: 600 } }), r => reply(writing()(r).text, { usage: { ...zeroUsage, outputTokens: 600 } })],
    });
    const result = await h.socrates.handle("Continue");
    expect(h.compactor.requests).toHaveLength(2);
    expect(w.store.latestHistoryRecord(w.taskId)?.kind).toBe("checkpoint");
    expect(h.model.requests[0]!.toolChoice).toBe("none");
    expect(result.kind === "answered" && result.parts[0]!.stop).toBe("tokens");
  });

  it("does not persist a summary when cancellation races with its response", async () => {
    const w = await world(); end(w, "Old work", "word ".repeat(4000)); end(w, "Recent", "OK");
    const controller = new AbortController();
    const h = w.socrates([continueTask()], [], { budgets: { trigger: 5000, target: 4000, verbatimWindow: 100 }, compactor: [r => { controller.abort(); return writing()(r); }] });
    const result = await h.socrates.handle("Continue", { signal: controller.signal });
    expect(result.kind === "answered" && result.parts[0]!.status).toBe("interrupted");
    expect(w.store.latestHistoryRecord(w.taskId)).toBeNull();
    expect(w.store.listEvents({ type: "compaction_recorded" })).toHaveLength(0);
    expect(h.model.requests).toHaveLength(0);
  });
});

describe("mechanical rollover recovery", () => {
  it.each([false, true])("retains unsummarized turns through replay and absorbs them later (prior=%s)", async withPrior => {
    const w = await world();
    const owed = end(w, "Explain UNIQUE_OWED_DEPLOYMENT later.", "Later. " + "word ".repeat(1500));
    end(w, "Recent", "OK");
    const turn = begin(w); const chat = exhaustChat(w);
    if (withPrior) w.store.recordHistoryRecord({ goal_id: w.goalId, task_id: w.taskId, chat_id: chat.id }, { kind: "checkpoint", from: 1, to: 1, content: checkpoint(1, 1, { outstanding_requests: [{ turn: 1, quote: "Start the project work." }] }) });
    const c = compact(w, turn, new ScriptedModel("broken", [{ text: "bad" }, { text: "bad" }]), { maxCompactionsPerChat: 1, verbatimWindow: 100 });
    const messages = await c.run(c.messages, c.measure, new AbortController().signal);
    const record = w.store.latestHistoryRecord(w.taskId)!;
    expect(record.to).toBe(withPrior ? 1 : 0);
    expect(w.store.pendingOmission(w.taskId)).toEqual({ from: withPrior ? 2 : 1, to: 2 });
    expect(JSON.stringify(messages)).toContain("OMITTED");
    if (withPrior) expect(JSON.stringify(messages)).toContain("Start the project work.");
    expect(w.store.currentChat(w.taskId).continuationOf).toBe(chat.id);

    const restored = LedgerStore.open({ path: ":memory:" });
    try {
      restored.restoreEvents(w.store.listEvents());
      expect(restored.pendingOmission(w.taskId)).toEqual(w.store.pendingOmission(w.taskId));
      restored.completeTurn(turn.id, { responseEventId: restored.recordResponse("Continued").id, continuationNote: "Continue" });
      const resumed = { store: restored, taskId: w.taskId };
      end(resumed, "More work", "word ".repeat(1500)); end(resumed, "Latest", "OK");
      const model = new ScriptedModel("recovered", [writing({ outstanding_requests: [{ turn: owed.projectTurn, quote: "Explain UNIQUE_OWED_DEPLOYMENT later." }] })]);
      const next = compact(resumed, begin(resumed), model, { verbatimWindow: 100 });
      const after = await next.run(next.messages, next.measure, new AbortController().signal);
      expect(userText(model.requests[0]!.messages[0]!.content)).toContain("[TURN 2]\nUSER:\nExplain UNIQUE_OWED_DEPLOYMENT later.");
      expect(restored.pendingOmission(w.taskId)).toBeNull();
      expect(JSON.stringify(after)).toContain("Explain UNIQUE_OWED_DEPLOYMENT later.");
      expect(JSON.stringify(after)).not.toContain("OMITTED");
    } finally { restored.close(); }
  });

  it("fits the full fallback capsule, preserves quotes, and points to omitted metadata", async () => {
    const w = await world(); const chat = exhaustChat(w);
    const prior = w.store.recordHistoryRecord({ goal_id: w.goalId, task_id: w.taskId, chat_id: chat.id }, { kind: "checkpoint", from: 1, to: 1, content: checkpoint(1, 1, { constraints: ["constraint ".repeat(7700)], outstanding_requests: [{ turn: 1, quote: "Start the project work." }] }) });
    expect(countTokens(renderRecord(prior))).toBeLessThan(8000);
    w.store.recordTerminalExited({ goal_id: w.goalId, task_id: w.taskId, chat_id: chat.id }, { session_id: "synthetic", exit_code: 0, signal: null, reason: "exited", facts: Array.from({ length: 20 }, (_, i) => ({ kind: "test", value: `test-${i} ` + "checks ".repeat(50) })) });
    const c = compact(w, begin(w), new ScriptedModel("broken", [{ text: "bad" }, { text: "bad" }]), { maxCompactionsPerChat: 1 });
    await c.run(c.messages, c.measure, new AbortController().signal);
    const record = w.store.latestHistoryRecord(w.taskId)!;
    expect(countTokens(renderRecord(record))).toBeLessThanOrEqual(8000);
    expect(record.content).toMatchObject({ outstanding_requests: [{ turn: 1, quote: "Start the project work." }], omitted_details: expect.stringContaining(prior.handle) });
    expect(w.store.historyRecord(w.taskId, prior.number)).toEqual(prior);
    const restored = LedgerStore.open({ path: ":memory:" });
    try { restored.restoreEvents(w.store.listEvents()); expect(restored.latestHistoryRecord(w.taskId)).toEqual(record); }
    finally { restored.close(); }
  });

  it("defers rollover instead of losing obligations when the configured capsule budget cannot fit them", async () => {
    const w = await world(); const chat = exhaustChat(w);
    const prior = w.store.recordHistoryRecord({ goal_id: w.goalId, task_id: w.taskId, chat_id: chat.id }, { kind: "checkpoint", from: 1, to: 1, content: checkpoint(1, 1, { outstanding_requests: [{ turn: 1, quote: "Start the project work." }] }) });
    const c = compact(w, begin(w), new ScriptedModel("broken", [{ text: "bad" }, { text: "bad" }]), { maxCompactionsPerChat: 1, summaryMax: 10 });
    const after = await c.run(c.messages, c.measure, new AbortController().signal);
    expect(w.store.currentChat(w.taskId).id).toBe(chat.id);
    expect(w.store.requireChat(chat.id).closedAt).toBeNull();
    expect(w.store.latestHistoryRecord(w.taskId)).toEqual(prior);
    expect(JSON.stringify(after)).toContain("Start the project work.");
  });
});

describe("handover obligations and retrieved history", () => {
  it("carries newer obligations through checkpoint generations without widening historical coverage", async () => {
    const w = await world(); end(w, "Old", "OK"); end(w, "Middle A", "word ".repeat(1000)); end(w, "Middle B", "word ".repeat(1000));
    const owed = end(w, "Explain UNIQUE_KEPT_REQUEST later.", "word ".repeat(400)); end(w, "Latest", "word ".repeat(400));
    const outstanding_requests = [{ turn: owed.projectTurn, quote: "Explain UNIQUE_KEPT_REQUEST later." }];
    const chat = w.store.currentChat(w.taskId);
    w.store.recordHistoryRecord({ goal_id: w.goalId, task_id: w.taskId, chat_id: chat.id }, { kind: "handover", from: 1, to: 2, content: capsule({ outstanding_requests }) });
    const turn = begin(w);
    for (const verbatimWindow of [1000, 100]) {
      const model = new ScriptedModel("summary", [writing({ outstanding_requests })]);
      const c = compact(w, turn, model, { verbatimWindow });
      await c.run(c.messages, c.measure, new AbortController().signal);
      expect(model.requests).toHaveLength(1);
      expect(w.store.latestHistoryRecord(w.taskId)).toMatchObject({ kind: "checkpoint", to: verbatimWindow === 1000 ? 4 : 6, content: { outstanding_requests } });
      expect(w.store.pendingOmission(w.taskId)).toBeNull();
    }
  });

  it("accepts only genuinely carried out-of-range citations and refuses silent removal", async () => {
    const w = await world(); const owed = end(w, "Keep this request. And a different request.", "Later");
    const carried = { outstanding_requests: [{ turn: owed.projectTurn, quote: "Keep this request." }], more_outstanding_turns: [] };
    const check = (extra: Partial<HistoryCheckpoint>, trusted = carried) => validateSummary("checkpoint", JSON.stringify(checkpoint(1, 1, extra)), { store: w.store, taskId: w.taskId, range: { from: 1, to: 1 }, latestTurn: w.store.latestProjectTurn(), carried: trusted, maxTokens: 8000, render: c => JSON.stringify(c) });
    expect(check({ outstanding_requests: carried.outstanding_requests }).ok).toBe(true);
    expect(check({ outstanding_requests: [{ turn: owed.projectTurn, quote: "And a different request." }] }).ok).toBe(false);
    expect(check({}).ok).toBe(false);
    expect(check({ more_outstanding_turns: [owed.projectTurn] }).ok).toBe(true);
    const otherTask = w.store.createTask(w.goalId, { title: "Other" });
    const foreign = end({ store: w.store, taskId: otherTask.id }, "Foreign request.", "Later");
    const forged = { outstanding_requests: [{ turn: foreign.projectTurn, quote: "Foreign request." }], more_outstanding_turns: [] };
    expect(check({ outstanding_requests: forged.outstanding_requests }, forged).ok).toBe(false);
  });

  it("searches only omitted history before limiting, even when newer exchanges rank higher", async () => {
    const w = await world(); const old = end(w, "quasar original special detail", "old answer");
    for (let i = 0; i < 25; i++) end(w, "quasar", "quasar quasar quasar");
    const otherTask = w.store.createTask(w.goalId, { title: "Other" });
    end({ store: w.store, taskId: otherTask.id }, "quasar", "FOREIGN quasar");
    const text = retrievedHistory(w.store, { taskId: w.taskId, message: "quasar", boundary: old.projectTurn, maxTokens: 8000 });
    expect(text).toContain(`[TURN ${old.projectTurn}] (retrieved)`);
    expect(text).toContain("old answer");
    expect(text).not.toContain("FOREIGN");
    expect(text).not.toContain("quasar quasar quasar");
    expect(countTokens(text!)).toBeLessThanOrEqual(8000);
  });
});
