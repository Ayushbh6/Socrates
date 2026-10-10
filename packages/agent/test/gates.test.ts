import type { DeciderClient, DecisionRequest, DecisionResponse } from "@socrates/contracts";
import type { SemanticHit, SemanticIndex, SemanticQuery } from "@socrates/retrieval";
import { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { continueTask } from "../../router/test/helpers";
import { GATE_ANSWER_CHARS, GATE_MESSAGE_CHARS, GATE_QUESTIONS, MemoryGate, gateState, memoryCandidates, memoryHint } from "../src";
import { contextText, final, world } from "./helpers";

/** A decider that answers from a script, remembers what it was asked, and can fail or stall. */
function fakeDecider(answer: () => { recall?: number; save?: number } | "fail" | "stall") {
  const asked: DecisionRequest[] = [];
  const decider: DeciderClient = {
    id: "fake:decider",
    async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
      asked.push(request);
      const out = answer();
      if (out === "fail") throw new Error("decider is down");
      if (out === "stall") await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
      const p = out as { recall?: number; save?: number };
      return { model: "fake", probabilities: Object.fromEntries(Object.keys(request.questions).map((q) => [q, p[q as "recall" | "save"] ?? 0])), usage: { inputTokens: 10, outputTokens: 1, costUsd: null }, id: null };
    },
  };
  return { decider, asked };
}

const input = (over: Partial<Parameters<MemoryGate["read"]>[0]> = {}) => ({
  message: "I always want short answers.", previousAnswer: null, attachments: [], ask: { recall: true, save: true }, trace: { role: "decision" as const }, ...over,
});

describe("what the gate sends", () => {
  it("is the message alone, or the answer it follows and the message, cut short, with the image names", () => {
    expect(gateState({ message: "  Thanks, that worked!  ", previousAnswer: null, attachments: [] })).toBe("Thanks, that worked!");
    expect(gateState({ message: "Use tabs.", previousAnswer: "Done: spaces everywhere.", attachments: [] })).toBe("The assistant's previous reply (cut short):\nDone: spaces everywhere.\n\nThe user's latest message:\nUse tabs.");
    expect(gateState({ message: "What is this?", previousAnswer: null, attachments: ["a.png", "b.png"] })).toBe("What is this?\n[Attached: a.png, b.png]");
    const long = gateState({ message: "m".repeat(GATE_MESSAGE_CHARS + 500), previousAnswer: "a".repeat(GATE_ANSWER_CHARS + 500), attachments: [] });
    expect(long.length).toBeLessThan(GATE_MESSAGE_CHARS + GATE_ANSWER_CHARS + 120);
    expect(long).toContain("…");
  });
});

describe("the memory gate", () => {
  it("asks only the questions that matter and returns the probabilities", async () => {
    const { decider, asked } = fakeDecider(() => ({ recall: 0.1, save: 0.97 }));
    const gate = new MemoryGate({ decider });
    expect(await gate.read(input())).toEqual({ recall: 0.1, save: 0.97 });
    expect(asked[0]!.questions).toEqual({ recall: GATE_QUESTIONS.recall, save: GATE_QUESTIONS.save });
    expect(await gate.read(input({ ask: { recall: false, save: true } }))).toEqual({ recall: null, save: 0.97 });
    expect(Object.keys(asked[1]!.questions)).toEqual(["save"]);
    // Nothing worth asking, or nothing said: no request at all.
    expect(await gate.read(input({ ask: { recall: false, save: false } }))).toBeNull();
    expect(await gate.read(input({ message: "  " }))).toBeNull();
    expect(asked).toHaveLength(2);
  });

  it("reads as nothing when the decider fails or is too slow, and is not asked again for 30 seconds", async () => {
    let now = 1_000_000;
    let mode: "fail" | "stall" | { save: number } = "fail";
    const { decider, asked } = fakeDecider(() => mode);
    const log: string[] = [];
    const gate = new MemoryGate({ decider, timeoutMs: 20, now: () => now, log: (m) => log.push(m) });
    expect(await gate.read(input())).toBeNull();
    expect(log[0]).toContain("decider is down");
    mode = { save: 0.9 };
    now += 29_000;
    expect(await gate.read(input())).toBeNull();
    expect(asked).toHaveLength(1);
    now += 2_000;
    expect(await gate.read(input())).toEqual({ recall: 0, save: 0.9 });
    mode = "stall";
    expect(await gate.read(input())).toBeNull();
    expect(asked).toHaveLength(3);
    expect(log).toHaveLength(2);
  });

  it("does not count the user stopping the turn as a failure", async () => {
    const { decider, asked } = fakeDecider(() => "stall");
    const gate = new MemoryGate({ decider, timeoutMs: 5_000 });
    const stop = new AbortController();
    const reading = gate.read(input(), stop.signal);
    stop.abort();
    expect(await reading).toBeNull();
    const again = fakeDecider(() => ({ save: 0.8 }));
    const healthy = new MemoryGate({ decider: again.decider });
    expect(await healthy.read(input())).toEqual({ recall: 0, save: 0.8 });
    expect(asked).toHaveLength(1);
  });
});

describe("what the readings change", () => {
  const settings = { save: true, use: true };
  function setup() {
    const store = LedgerStore.open({ path: ":memory:" });
    const goal = store.createGoal({ title: "Holiday" });
    const trip = store.saveMemory({ kind: "knowledge", goalId: null, text: "The Berlin trip is from 14 to 18 March.", by: "user" }).memory;
    const hit = (similarity: number): SemanticHit => ({ kind: "memory", sourceId: trip.id, goalId: null, taskId: null, turnId: null, projectTurn: null, at: "2026-09-01T10:00:00Z", similarity });
    const ask = (reading: Parameters<typeof memoryCandidates>[1]["reading"], similarity = 0.25) =>
      memoryCandidates(store, { goal, message: "Which airline am I flying with?", semantic: [hit(similarity)], settings, now: new Date("2026-10-10T10:00:00Z"), timeZone: "UTC", reading });
    return { ask, trip };
  }

  it("widen the candidates when a recall is likely: a weaker meaning match is offered, and more of them", () => {
    const { ask, trip } = setup();
    expect(ask(null).ids).toEqual([]);
    expect(ask({ recall: 0.3, save: null }).ids).toEqual([]);
    const widened = ask({ recall: 0.6, save: null });
    expect(widened.ids).toEqual([trip.id]);
    expect(widened.block).toMatch(/^<MEMORY_CANDIDATES>\n- \[m1 · knowledge · \d{4}-\d{2}-\d{2}\] The Berlin trip is from 14 to 18 March\.\n<\/MEMORY_CANDIDATES>$/);
  });

  it("send the agent to look first when a recall is nearly certain and nothing matched", () => {
    const { ask } = setup();
    expect(ask({ recall: 0.8, save: null }, 0.05).block).toBeNull();
    const look = ask({ recall: 0.9, save: null }, 0.05);
    expect(look.ids).toEqual([]);
    expect(look.block).toContain('action "memory"');
    expect(look.block).toContain("ledger_search");
    // Never when memories are not used.
    const store = LedgerStore.open({ path: ":memory:" });
    expect(memoryCandidates(store, { goal: store.createGoal({ title: "x" }), message: "Which airline?", semantic: [], settings: { save: true, use: false }, now: new Date(), timeZone: "UTC", reading: { recall: 0.95, save: null } })).toEqual({ block: null, ids: [] });
  });

  it("add a one-line hint to save when the message may state something lasting, only if saving is on", () => {
    expect(memoryHint(settings, null)).toBeNull();
    expect(memoryHint(settings, { recall: 0.9, save: 0.39 })).toBeNull();
    expect(memoryHint(settings, { recall: null, save: 0.4 })).toMatch(/^<MEMORY_HINT>\n.*memory\.save.*\n<\/MEMORY_HINT>$/);
    expect(memoryHint({ save: false, use: true }, { recall: null, save: 0.99 })).toBeNull();
  });
});

/** A meaning index that answers memory searches from fixed similarities. */
function memoryIndex(similar: () => { id: string; similarity: number }[]): SemanticIndex {
  return {
    async search(_query: string, filter: SemanticQuery): Promise<SemanticHit[]> {
      if (!filter.kinds.includes("memory")) return [];
      return similar().map((m) => ({ kind: "memory" as const, sourceId: m.id, goalId: null, taskId: null, turnId: null, projectTurn: null, at: "2026-09-01T10:00:00Z", similarity: m.similarity }));
    },
    scheduleSync() {},
    async close() {},
  };
}

describe("a turn with the gate", () => {
  it("shows the agent what the readings ask for, tells the decider where the message came from, and carries on when it fails", async () => {
    const w = await world();
    const trip = w.store.saveMemory({ kind: "knowledge", goalId: null, text: "The Berlin trip is from 14 to 18 March.", by: "user" }).memory;
    let answer: { recall?: number; save?: number } | "fail" | "stall" = { recall: 0.7, save: 0.9 };
    const { decider, asked } = fakeDecider(() => answer);
    const gate = new MemoryGate({ decider });
    const { socrates, model } = w.socrates([continueTask(), continueTask(), continueTask(), continueTask()], [final({ full_answer: "Austrian Airlines." }), final(), final(), final()], {
      semantic: memoryIndex(() => [{ id: trip.id, similarity: 0.25 }]),
      memory: () => ({ save: true, use: true }),
      gate: () => gate,
    });

    await socrates.handle("Which airline am I flying with?");
    const first = contextText(model.requests[0]!);
    expect(first).toContain("<MEMORY_CANDIDATES>\n- [m1 · knowledge · 2026-09-01] The Berlin trip");
    expect(first).toMatch(/<MEMORY_HINT>[\s\S]*memory\.save[\s\S]*<\/MEMORY_HINT>/);
    const turn = w.store.turnsForTask(w.taskId).at(-1)!;
    expect(asked[0]!.trace).toMatchObject({ role: "decision", userEventId: turn.userEventId, turnId: turn.id, goalId: w.goalId, taskId: w.taskId });
    // The fixture's chat already has an answer, which this message follows.
    expect(asked[0]!.state).toBe("The assistant's previous reply (cut short):\nStarted.\n\nThe user's latest message:\nWhich airline am I flying with?");
    expect(w.store.getMemory(trip.id)!.uses).toBe(1);

    // The next message in the chat is judged with the answer it follows.
    answer = { recall: 0.1, save: 0.05 };
    await socrates.handle("Thanks!");
    expect(asked[1]!.state).toContain("The assistant's previous reply (cut short):\nAustrian Airlines.");
    const second = contextText(model.requests.at(-1)!);
    expect(second).not.toContain("<MEMORY_CANDIDATES>");
    expect(second).not.toContain("<MEMORY_HINT>");

    // A decider that fails costs nothing but its help; the turn is answered, and it is not asked again at once.
    answer = "fail";
    await socrates.handle("Anything else?");
    expect(w.store.turnsForTask(w.taskId).at(-1)).toMatchObject({ status: "completed" });
    await socrates.handle("And now?");
    expect(asked).toHaveLength(3);
  });

  it("asks nothing when both memory switches are off", async () => {
    const w = await world();
    const { decider, asked } = fakeDecider(() => ({ recall: 0.9, save: 0.9 }));
    const { socrates, model } = w.socrates([continueTask()], [final()], { memory: () => ({ save: false, use: false }), gate: () => new MemoryGate({ decider }) });
    await socrates.handle("I live in Berlin and always want short answers.");
    expect(asked).toHaveLength(0);
    expect(contextText(model.requests[0]!)).not.toContain("<MEMORY_HINT>");
  });
});
