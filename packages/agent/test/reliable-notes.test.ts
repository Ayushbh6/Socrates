import { describe, expect, it } from "vitest";
import { noteLength, type EventPayloads } from "@socrates/contracts";
import { LedgerStore } from "@socrates/store";
import { continueTask } from "../../router/test/helpers";
import { repairHistoricalNotes } from "../src/historical-notes";
import { validateFinalAnswer } from "../src/final";
import { call, final, world } from "./helpers";

describe("reliable continuation notes", () => {
  it("counts trimmed Unicode code points and accepts precisely 25 percent tolerance", () => {
    expect(noteLength("  😀 é\n ")).toBe(4);
    for (const [field, limit] of [["continuation_note", 1500], ["goal_note", 2500]] as const) {
      const accepted = validateFinalAnswer(final({ [field]: `  ${"😀".repeat(limit)}  ` }).text);
      expect(accepted.ok && accepted.noteIssues).toEqual([]);
      const long = validateFinalAnswer(final({ [field]: "😀".repeat(limit + 1) }).text);
      expect(long.ok && long.noteIssues).toMatchObject([{ field, length: limit + 1, limit }]);
    }
  });

  it("repairs only notes, preserves answer and valid goal/memory fields, never repeats tools", async () => {
    const w = await world({ files: { "one.txt": "original" } });
    const { socrates, model } = w.socrates([continueTask()], [
      { toolCalls: [call("edit", { path: "one.txt", old_text: "original", new_text: "changed" })] },
      final({ full_answer: "File changed successfully.", continuation_note: "x".repeat(1501), goal_note: "Valid durable progress." }),
      { text: JSON.stringify({ continuation_note: "Changed file; nothing remaining.", full_answer: "Do not replace original" }) },
    ]);
    const result = await socrates.handle("Edit once.");
    expect(result).toMatchObject({ kind: "answered", text: "File changed successfully." });
    expect(model.requests).toHaveLength(3);
    expect(model.requests[2]).toMatchObject({ tools: [], toolChoice: "none", trace: { role: "note_repair" } });
    expect(w.store.listEvents({ type: "tool_called" })).toHaveLength(1);
    expect(w.store.requireGoal(w.goalId).note).toBe("Valid durable progress.");
    expect(w.store.noteState(w.taskId)).toMatchObject({ freshness: "current", outcome: "repaired" });
    const replay = LedgerStore.open({ path: ":memory:" });
    replay.restoreEvents(w.store.listEvents());
    expect(replay.noteState(w.taskId)).toEqual(w.store.noteState(w.taskId));
    replay.close();
  });

  it("keeps the prior note explicitly stale after two failed repairs and preserves every proposed note", async () => {
    const w = await world();
    const previous = w.store.requireTask(w.taskId).continuationNote;
    const { socrates, model } = w.socrates([continueTask()], [final({ full_answer: "Succeeded.", continuation_note: "x".repeat(1501) }), { text: "bad" }, { text: '{"continuation_note":42}' }]);
    expect(await socrates.handle("Go")).toMatchObject({ text: "Succeeded." });
    expect(model.requests).toHaveLength(3);
    expect(w.store.requireTask(w.taskId).continuationNote).toBe(previous);
    expect(w.store.noteState(w.taskId).freshness).toBe("outdated");
    expect(w.store.listEvents({ type: "agent_message" })).toHaveLength(3);
    expect(w.store.listEvents({ type: "note_outcome" }).map(e => e.payload)).toContainEqual(expect.objectContaining({ field: "continuation_note", outcome: "failed", attempts: 2 }));
  });

  it.each(["cancel", "timeout"])("preserves a valid answer on note repair %s", async kind => {
    const w = await world(); const controller = new AbortController();
    const { socrates, model } = w.socrates([continueTask()], [final({ full_answer: "Verified result.", continuation_note: "" })], { limits: { finalizationMs: 20 } });
    const complete = model.complete.bind(model);
    model.complete = async request => {
      if (request.trace?.role !== "note_repair") return complete(request);
      if (kind === "cancel") controller.abort();
      await new Promise<void>(resolve => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      request.signal?.throwIfAborted();
      return complete(request);
    };
    expect(await socrates.handle("Go", { signal: controller.signal })).toMatchObject({ text: "Verified result." });
    expect(w.store.noteState(w.taskId).freshness).toBe("outdated");
  });

  it("missing notes trigger only note repair, while valid notes cost no extra call", async () => {
    const w = await world();
    const { socrates, model } = w.socrates([continueTask(), continueTask()], [
      { text: '{"full_answer":"Fine","task_complete":null,"anchors":[]}' },
      { text: '{"continuation_note":"Nothing pending.","goal_note":null}' }, final(),
    ]);
    await socrates.handle("First"); await socrates.handle("Second");
    expect(model.requests.map(r => r.trace?.role)).toEqual(["work", "note_repair", "work"]);
    expect(w.store.listEvents({ type: "note_outcome" }).filter(e => (e.payload as EventPayloads["note_outcome"]).outcome === "failed")).toEqual([]);
  });
  it("refuses tool calls during repair and freezes time through both repairs", async () => {
    const w = await world();
    const { socrates, model } = w.socrates([continueTask()], [
      final({ full_answer: "Successful answer.", continuation_note: "x".repeat(1501) }),
      request => { w.clock.advance(60000); return { text: '{"continuation_note":"ignore tools"}', toolCalls: [call("terminal", { command: "false" })] }; },
      { text: '{"continuation_note":"Verified; nothing pending."}' },
    ]);
    expect(await socrates.handle("Go")).toMatchObject({ text: "Successful answer." });
    expect(w.store.listEvents({ type: "tool_called" })).toHaveLength(0);
    const texts = model.requests.map(r => JSON.stringify(typeof r.messages[0]?.content === "string" ? r.messages[0].content : r.messages[0]?.content.map(p => p.text)));
    expect(texts).toEqual(Array(3).fill(texts[0]));
  });

  it("corrects only proven length-only historical rejections and appends an idempotent revision", async () => {
    const w = await world();
    const turn = w.store.bindTurn({ userEventId: w.store.recordUserMessage("Test").id, taskId: w.taskId, route: "test" });
    const refs = { goal_id: w.goalId, task_id: w.taskId, turn_id: turn.id, chat_id: turn.chatId };
    const text = final({ full_answer: "Test passed.", continuation_note: "Test verified complete. Nothing pending." }).text;
    w.store.appendEvent("agent_message", { phase: "work", response: { text, toolCalls: [], stopReason: "end", usage: { promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } }, refs);
    w.store.recordWarning(refs, { kind: "final_answer_invalid", detail: "continuation_note is 116 tokens; shorten it to at most 100." });
    w.store.completeTurn(turn.id, { responseEventId: w.store.recordResponse("Test passed.", refs).id, continuationNote: "Ended without a valid final answer after 13 tool calls." });
    const before = w.store.listEvents();
    expect(repairHistoricalNotes(w.store)).toBe(1);
    expect(repairHistoricalNotes(w.store)).toBe(0);
    expect(w.store.listEvents().slice(0, before.length)).toEqual(before);
    expect(w.store.requireTask(w.taskId).continuationNote).toBe("Test verified complete. Nothing pending.");
  });

});

it("keeps a failed goal-note update stale through later no-change answers", async () => {
  const w = await world();
  w.store.reviseGoalNote(w.goalId, "Previous accepted goal state.");
  const { socrates, model } = w.socrates([continueTask(), continueTask()], [
    final({ full_answer: "Valid result.", goal_note: "x".repeat(2501) }), { text: "bad" }, { text: "bad" }, final(),
  ]);
  await socrates.handle("Work");
  expect(w.store.requireGoal(w.goalId).note).toBe("Previous accepted goal state.");
  expect(w.store.goalNoteState(w.goalId).freshness).toBe("outdated");
  expect(w.store.noteState(w.taskId).freshness).toBe("current");
  await socrates.handle("Next");
  expect(JSON.stringify(model.requests.at(-1)!.messages[0])).toContain("outdated:");
  expect(w.store.goalNoteState(w.goalId).freshness).toBe("outdated");
});
