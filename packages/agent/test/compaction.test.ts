import { type EventPayloads, type ModelRequest, userText } from "@socrates/contracts";
import type { SemanticIndex, SemanticQuery } from "@socrates/retrieval";
import { countTokens } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { ToolRunner } from "@socrates/tools";
import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM_PROMPT, type ContextBudgets, renderRecord, validateSummary } from "../src";
import { continueTask, exchange } from "../../router/test/helpers";
import { call, contextText, final, type World, world } from "./helpers";

/** System prompt plus the ten tool schemas: the part of every request compaction never touches. */
const BASE = (() => {
  const store = LedgerStore.open({ path: ":memory:" });
  const runner = new ToolRunner({ store, timeZone: "UTC", approve: async () => true });
  const tokens = countTokens(AGENT_SYSTEM_PROMPT) + countTokens(JSON.stringify(runner.definitions)) + 32;
  void runner.close();
  store.close();
  return tokens;
})();

/** Small budgets, relative to the fixed base, so a few turns cross the trigger. */
const budgets = (overrides: Partial<ContextBudgets> = {}): Partial<ContextBudgets> => ({
  trigger: BASE + 2_600,
  target: BASE + 1_800,
  ceiling: BASE + 60_000,
  verbatimWindow: 900,
  intactWindow: 1_200,
  previousTurn: 600,
  retrievedMax: 1_000,
  ...overrides,
});

const LONG = "The parser keeps every token with its source position and reports errors with the exact line. ".repeat(24);

/** Seed completed exchanges in the world's task; the first one carries two questions. */
async function seed(w: World, count: number) {
  for (let i = 0; i < count; i++) {
    const message = i === 0 ? "Here are two questions: (1) what does the parser keep? (2) how do I test the lexer?" : `Explain parser detail number ${i}.`;
    await exchange(w.store, message, continueTask(), `Answer ${i}. ${LONG}`, `Explained parser detail ${i}.`);
  }
}

const spanRange = (request: ModelRequest) => {
  const m = /<COMPACTED_SPAN turns (\d+)(?:–(\d+))?>/.exec(userText(request.messages[0]!.content))!;
  return { from: Number(m[1]), to: Number(m[2] ?? m[1]) };
};

/** A valid checkpoint for whatever span the compactor was given. */
const checkpoint = (extra: object = {}) => (request: ModelRequest) => ({
  text: JSON.stringify({
    summary: "Worked through the parser questions.",
    turns_covered: spanRange(request),
    progress: "Question 1 answered.",
    decisions: [{ decision: "Keep positions on tokens", rationale: "Errors need exact lines" }],
    constraints: ["Keep answers short."],
    files_touched: [],
    open_threads: [],
    outstanding_requests: [{ turn: 2, quote: "(2) how do I test the lexer?" }],
    next_steps: ["Answer the lexer question."],
    key_evidence: [],
    ...extra,
  }),
});

const capsule = (extra: object = {}) => ({
  text: JSON.stringify({
    task_objective: "Make the server start.",
    completion_criteria: "The server starts.",
    verified_progress: "Read big.txt several times.",
    outstanding_requests: [],
    decisions: [],
    constraints: [],
    files_and_tests: ["big.txt"],
    blockers: [],
    next_action: "Finish reading and answer.",
    key_evidence: [{ ref: "e1", note: "first read of big.txt" }],
    ...extra,
  }),
});

const bigFile = Array.from({ length: 60 }, (_, i) => `line ${i}: configuration value for the server module number ${i}`).join("\n");
const readBig = { toolCalls: [call("read", { path: "big.txt" })] };
const compactions = (w: World) => w.store.listEvents({ type: "compaction_recorded" }).map((e) => e.payload as EventPayloads["compaction_recorded"]);

describe("layer 1: history checkpoint", () => {
  it("summarizes turns older than the verbatim window and keeps owed requests visible", async () => {
    const w = await world();
    await seed(w, 8);
    const queries: SemanticQuery[] = [];
    const semantic: SemanticIndex = { async search(_q, filter) { queries.push(filter); return []; }, scheduleSync() {}, async close() {} };
    const { socrates, model, compactor } = w.socrates([continueTask()], [final({ full_answer: "Here is the lexer answer." })], { budgets: budgets(), compactor: [checkpoint()], semantic });
    await socrates.handle("Continue with the parser work.");
    expect(queries.filter((q) => q.throughTurn !== undefined).map((q) => q.throughTurn)).toEqual([0, w.store.latestHistoryRecord(w.taskId)!.to]);

    const input = userText(compactor.requests[0]!.messages[0]!.content);
    const range = spanRange(compactor.requests[0]!);
    expect(range.from).toBe(1);
    expect(input).toContain("[TURN 1]\nUSER:\nStart the project work.");
    const text = contextText(model.requests[0]!);
    expect(text).toContain(`<HISTORY_CHECKPOINT ref="hc-1" turns="1–${range.to}">`);
    expect(text).toContain('- turn 2: "(2) how do I test the lexer?"');
    expect(text).not.toContain("[TURN 2]\nUSER:");
    expect(text).toContain("[TURN 9 — full]");
    expect(w.store.latestHistoryRecord(w.taskId)).toMatchObject({ handle: "hc-1", kind: "checkpoint", from: 1, to: range.to });
    expect(compactions(w)).toMatchObject([{ count: 1, layers: ["checkpoint"], checkpoint: "hc-1" }]);
    expect(compactions(w)[0]!.after_tokens).toBeLessThanOrEqual(BASE + 1_800);

    // The next turn keeps the checkpoint and retrieves the exact older exchange it covers.
    const next = w.socrates([continueTask()], [final()], { budgets: budgets() });
    await next.socrates.handle("So how do I test the lexer?");
    const later = contextText(next.model.requests[0]!);
    expect(later).toContain('<HISTORY_CHECKPOINT ref="hc-1"');
    expect(later).toContain("<RETRIEVED_HISTORY>\n[TURN 2 — 2026-09-01] (retrieved)\nUSER:\nHere are two questions");
    expect(compactions(w)).toHaveLength(1);
  });

  it("retries an invalid checkpoint once with the exact errors", async () => {
    const w = await world();
    await seed(w, 8);
    const { socrates, compactor } = w.socrates([continueTask()], [final()], {
      budgets: budgets(),
      compactor: [checkpoint({ outstanding_requests: [{ turn: 2, quote: "how should I test my lexer" }], key_evidence: [{ ref: "e99", note: "x" }] }), checkpoint()],
    });
    await socrates.handle("Continue.");
    const retry = JSON.stringify(compactor.requests[1]!.messages.at(-1));
    expect(retry).toContain("the quote is not verbatim");
    expect(retry).toContain("key_evidence ref e99 does not exist");
    expect(w.store.latestHistoryRecord(w.taskId)?.mechanical).toBe(false);
  });

  it("omits the span with a visible marker when the compactor fails, and includes it again next time", async () => {
    const w = await world();
    await seed(w, 8);
    const broken = { text: "not json" };
    const { socrates, model } = w.socrates([continueTask()], [final()], { budgets: budgets(), compactor: [broken, broken] });
    await socrates.handle("Continue.");
    const text = contextText(model.requests[0]!);
    expect(text).toMatch(/\[TURNS 1–\d+ OMITTED — the summarizer was unavailable/);
    expect(w.store.listEvents({ type: "agent_warning" }).map((e) => (e.payload as EventPayloads["agent_warning"]).kind)).toContain("compactor_failed");
    expect(w.store.pendingOmission(w.taskId)?.from).toBe(1);

    await seed(w, 6);
    const again = w.socrates([continueTask()], [final()], { budgets: budgets(), compactor: [checkpoint()] });
    await again.socrates.handle("Continue again.");
    expect(spanRange(again.compactor.requests[0]!).from).toBe(1);
    expect(contextText(again.model.requests[0]!)).not.toContain("OMITTED");
  });

  it("chains checkpoints: the prior one is input to the next and stays inspectable", async () => {
    const w = await world();
    await seed(w, 8);
    const first = w.socrates([continueTask()], [final()], { budgets: budgets(), compactor: [checkpoint()] });
    await first.socrates.handle("Continue.");
    await seed(w, 8);
    const second = w.socrates([continueTask()], [{ toolCalls: [call("context_retrieve", { action: "inspect", ref: "hc-1" })] }, final()], { budgets: budgets(), compactor: [checkpoint()] });
    await second.socrates.handle("Continue more.");
    const input = userText(second.compactor.requests[0]!.messages[0]!.content);
    expect(input).toContain('[PRIOR CHECKPOINT ref="hc-1"');
    expect(spanRange(second.compactor.requests[0]!).from).toBe(1);
    expect(contextText(second.model.requests[0]!)).toContain('<HISTORY_CHECKPOINT ref="hc-2"');
    const inspected = JSON.parse(String(second.model.requests[1]!.messages.at(-1)!.content));
    expect(inspected.checkpoint).toMatchObject({ ref: "hc-1", kind: "checkpoint", active: false });
    expect(inspected.content.summary).toBe("Worked through the parser questions.");
  });
});

describe("layer 2: in-turn linearization", () => {
  it("rewrites the turn's older tool calls as one-line entries, never splitting a call from its result", async () => {
    const w = await world({ files: { "big.txt": bigFile } });
    const { socrates, model } = w.socrates([continueTask()], [readBig, readBig, readBig, readBig, final()], { budgets: budgets({ trigger: BASE + 2_300, target: BASE + 1_400 }) });
    await socrates.handle("Read big.txt a few times.");
    const after = model.requests.find((r) => contextText(r).includes("earlier tool activity of this turn"))!;
    const text = contextText(after);
    expect(text).toMatch(/\[TURN \d+ — earlier tool activity of this turn, linearized; context_retrieve inspect recovers each handle\]\n- TOOL CALL \[e1\] read big\.txt \(lines 1–60 of 60\)/);
    // Every remaining tool result directly follows the assistant step that called it.
    const rest = after.messages.slice(1);
    expect(rest[0]!.role).toBe("assistant");
    for (const [i, m] of rest.entries()) {
      if (m.role !== "tool") continue;
      const owner = rest.slice(0, i).reverse().find((x) => x.role === "assistant");
      expect(owner?.role === "assistant" && owner.toolCalls!.some((c) => c.id === m.toolCallId)).toBe(true);
    }
    expect(compactions(w)).toMatchObject([{ count: 1, layers: ["linearize"], checkpoint: null }]);
    expect(compactions(w)[0]!.after_tokens).toBeLessThanOrEqual(BASE + 1_400);
  });

  it("keeps the newest step intact even when it alone exceeds the intact window", async () => {
    const w = await world({ files: { "big.txt": bigFile } });
    const { socrates, model } = w.socrates([continueTask()], [readBig, readBig, readBig, final()], { budgets: budgets({ trigger: BASE + 2_300, target: BASE + 1_400, intactWindow: 100 }) });
    await socrates.handle("Read big.txt a few times.");
    const after = model.requests.find((r) => contextText(r).includes("earlier tool activity of this turn"))!;
    expect(after.messages.slice(1).map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(after.messages.at(-1)!.content).toContain("line 59: configuration value");
  });

  it("truncates the newest step's results in the failsafe instead of dropping them", async () => {
    const w = await world({ files: { "big.txt": `${bigFile}\n${bigFile}\n${bigFile}` } });
    const { socrates, model } = w.socrates([continueTask()], [readBig, final()], { budgets: budgets({ trigger: BASE + 1_500, target: BASE + 1_000, intactWindow: 100 }) });
    await socrates.handle("Read big.txt.");
    const last = model.requests[1]!.messages.at(-1)!;
    expect(last.role).toBe("tool");
    expect(last.content).toContain("line 0: configuration value");
    expect(last.content).toContain("context_retrieve inspect e1 returns the complete result");
    expect(compactions(w)[0]!.layers).toContain("failsafe");
  });
});

describe("hysteresis", () => {
  it("does not compact again until the request grows by the trigger–target gap, even above the trigger", async () => {
    const w = await world({ files: { "big.txt": bigFile, "small.txt": "tiny\n" } });
    const small = { toolCalls: [call("read", { path: "small.txt" })] };
    const { socrates } = w.socrates([continueTask()], [readBig, readBig, readBig, small, small, small, final()], {
      budgets: budgets({ trigger: BASE + 200, target: BASE, intactWindow: 100 }),
    });
    await socrates.handle("Read the files.");
    // Every request is at or above the trigger. The first request and each big read compact; the
    // small reads grow the request by less than the gap, so they never compact.
    expect(compactions(w)).toHaveLength(4);
  });
});

describe("rollover", () => {
  async function rolledOver(handover: object[]) {
    const w = await world({ files: { "big.txt": bigFile } });
    const chat = w.store.currentChat(w.taskId);
    // The chat has used its one allowed compaction.
    w.store.recordCompaction({ goal_id: w.goalId, task_id: w.taskId, chat_id: chat.id }, { layers: ["linearize"], checkpoint: null, before_tokens: 0, after_tokens: 0 });
    const statuses: string[] = [];
    const run = w.socrates([continueTask()], [readBig, readBig, readBig, readBig, final({ full_answer: "Finished reading." })], {
      budgets: budgets({ trigger: BASE + 2_500, target: BASE + 1_400, maxCompactionsPerChat: 1 }),
      compactor: handover as never,
    });
    const result = await run.socrates.handle("Fix the memory logging system.", { onStatus: (s) => statuses.push(s) });
    return { w, chat, statuses, run, result };
  }

  it("continues the same turn in a linked continuation chat after a handover capsule", async () => {
    const { w, chat, statuses, run, result } = await rolledOver([capsule()]);
    expect(result).toMatchObject({ kind: "answered", text: "Finished reading." });
    expect(statuses).toEqual(["Refreshing this long task's context…"]);
    const next = w.store.currentChat(w.taskId);
    expect(next).toMatchObject({ continuationOf: chat.id, handoverRef: "hc-1", compactionCount: 0 });
    expect(w.store.requireChat(chat.id).closedAt).not.toBeNull();
    // The turn that was in flight stays recorded under the closed chat.
    const turn = result.kind === "answered" ? result.parts[0]!.turn : null;
    expect(turn!.chatId).toBe(chat.id);
    const after = run.model.requests.find((r) => contextText(r).includes("<HANDOVER_CAPSULE"))!;
    expect(contextText(after)).toContain('<HANDOVER_CAPSULE ref="hc-1" turns="none">\nThis task continues from an earlier chat.');
    expect(contextText(after)).toContain("earlier tool activity of this turn");
    expect(compactions(w)).toHaveLength(1);
    expect(userText(run.compactor.requests[0]!.messages[0]!.content)).toContain('<CURRENT_REQUEST turn="2">\nFix the memory logging system.');

    // The next turn lands in the new chat, and its history still holds the turn recorded under the old one.
    const following = w.socrates([continueTask()], [final()], { budgets: budgets() });
    const second = await following.socrates.handle("Did that work?");
    expect(second.kind === "answered" && second.parts[0]!.turn.chatId).toBe(next.id);
    const text = contextText(following.model.requests[0]!);
    expect(text).toContain('<HANDOVER_CAPSULE ref="hc-1"');
    expect(text).toContain(`[TURN ${turn!.projectTurn} — full]\nUSER:\nFix the memory logging system.`);
  });

  it("never happens in a standard-mode chat: the user's chosen chat keeps compacting, unrouted", async () => {
    const w = await world({ files: { "big.txt": bigFile } });
    const chat = w.store.currentChat(w.taskId);
    w.store.recordCompaction({ goal_id: w.goalId, task_id: w.taskId, chat_id: chat.id }, { layers: ["linearize"], checkpoint: null, before_tokens: 0, after_tokens: 0 });
    const statuses: string[] = [];
    const run = w.socrates([], [readBig, readBig, readBig, readBig, final({ full_answer: "Finished reading." })], {
      budgets: budgets({ trigger: BASE + 2_500, target: BASE + 1_400, maxCompactionsPerChat: 1 }),
      compactor: [checkpoint(), checkpoint()] as never,
    });
    const result = await run.socrates.handle("Fix the memory logging system.", { target: { taskId: w.taskId }, rollover: false, onStatus: (s) => statuses.push(s) });
    expect(result).toMatchObject({ kind: "answered", text: "Finished reading." });
    expect(statuses).toEqual([]);
    expect(w.store.currentChat(w.taskId).id).toBe(chat.id);
    expect(w.store.listChats(w.taskId)).toHaveLength(1);
    expect(compactions(w).length).toBeGreaterThan(1);
    expect(w.store.listEvents({ type: "turn_bound" }).at(-1)!.payload).toMatchObject({ route: "standard" });
  });

  it("writes a mechanical capsule when the writer fails, so rollover never blocks the turn", async () => {
    const { w, result } = await rolledOver([{ text: "nope" }, { text: "nope" }]);
    expect(result).toMatchObject({ kind: "answered", text: "Finished reading." });
    const record = w.store.latestHistoryRecord(w.taskId)!;
    expect(record).toMatchObject({ kind: "handover", mechanical: true });
    expect(renderRecord(record)).toContain("note: written mechanically because the summarizer was unavailable");
    expect((record.content as { next_action: string }).next_action).toContain("Fix the memory logging system.");
  });

  it("replays checkpoints, counts, and the chat chain from the event log", async () => {
    const { w } = await rolledOver([capsule()]);
    const restored = LedgerStore.open({ path: ":memory:" });
    restored.restoreEvents(w.store.listEvents());
    for (const table of ["chats", "history_records", "turns"]) {
      expect(restored.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(w.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    }
    restored.close();
  });
});

describe("summary validation", () => {
  it("accepts whitespace and quote-style differences only, inside the covered turns of the task", async () => {
    const w = await world();
    await seed(w, 3);
    const check = (extra: object) =>
      validateSummary("checkpoint", checkpoint(extra)({ system: "", messages: [{ role: "user", content: "<COMPACTED_SPAN turns 1–4>" }] }).text, {
        store: w.store,
        taskId: w.taskId,
        range: { from: 1, to: 4 },
        latestTurn: 5,
        maxTokens: 8_000,
        render: () => "",
      });
    expect(check({ outstanding_requests: [{ turn: 2, quote: "(2)  how do I\ntest the lexer?" }] }).ok).toBe(true);
    expect(check({ outstanding_requests: [{ turn: 2, quote: "(2) How do I test the lexer?" }] }).ok).toBe(false);
    expect(check({ outstanding_requests: [{ turn: 7, quote: "x" }] })).toMatchObject({ ok: false, errors: [expect.stringContaining("is not a turn of this task between 1 and 4")] });
    expect(check({ turns_covered: { from: 2, to: 4 } })).toMatchObject({ ok: false, errors: [expect.stringContaining('exactly {"from": 1, "to": 4}')] });
    const many = Array.from({ length: 11 }, () => ({ turn: 2, quote: "(2) how do I test the lexer?" }));
    expect(check({ outstanding_requests: many })).toMatchObject({ ok: false, errors: [expect.stringContaining("more_outstanding_turns")] });
    expect(check({ more_outstanding_turns: [3] }).ok).toBe(true);
  });
});

