import { ModelError } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { type Draft, draftOf } from "../src";
import { continueTask } from "../../router/test/helpers";
import { call, contextText, final, world } from "./helpers";

describe("draftOf", () => {
  const object = (full_answer: string) => JSON.stringify({ full_answer, continuation_note: "Note.", goal_note: null, task_complete: null, anchors: [] });

  it("shows only narration as narration, and never the start of a JSON object", () => {
    expect(draftOf("")).toBeNull();
    expect(draftOf("Reading the config first.")).toEqual({ kind: "narration", text: "Reading the config first." });
    expect(draftOf("{")).toBeNull();
    expect(draftOf('{"full_ans')).toBeNull();
    expect(draftOf("```json\n{")).toBeNull();
    // Words before the object are narration only until the object starts.
    expect(draftOf("Here is the result.\n\n```json\n{")).toEqual({ kind: "narration", text: "Here is the result." });
  });

  it("decodes full_answer as far as it has arrived and ignores the rest of the object", () => {
    expect(draftOf('{"full_answer": ')).toBeNull();
    expect(draftOf('{"full_answer": "')).toBeNull();
    expect(draftOf('{"full_answer": "The port')).toEqual({ kind: "answer", text: "The port" });
    expect(draftOf('{"full_answer":"Done.","continuation_note":"secret')).toEqual({ kind: "answer", text: "Done." });
    expect(draftOf('```json\n{ "full_answer" : "Fenced.')).toEqual({ kind: "answer", text: "Fenced." });
    expect(draftOf('Sure.\n{"full_answer":"After words.')).toEqual({ kind: "answer", text: "After words." });
  });

  it("waits for an escape to finish before showing it", () => {
    const start = '{"full_answer":"a';
    expect(draftOf(`${start}\\`)!.text).toBe("a");
    expect(draftOf(`${start}\\n`)!.text).toBe("a\n");
    expect(draftOf(`${start}\\"b`)!.text).toBe('a"b');
    expect(draftOf(`${start}\\u00`)!.text).toBe("a");
    expect(draftOf(`${start}\\u00e9`)!.text).toBe("aé");
    // A surrogate pair is one character: nothing shows until both halves are here.
    expect(draftOf(`${start}\\ud83d`)!.text).toBe("a");
    expect(draftOf(`${start}\\ud83d\\ude`)!.text).toBe("a");
    expect(draftOf(`${start}\\ud83d\\ude00`)!.text).toBe("a😀");
  });

  it("only ever grows toward the saved answer, whatever the final message holds", () => {
    const answer = 'Line one.\nShe said "hi" — café 😀 and a \\ backslash.\n```ts\nconst a = { "full_answer": "x" };\n```';
    const text = object(answer);
    let previous = "";
    for (let end = 1; end <= text.length; end++) {
      const draft = draftOf(text.slice(0, end));
      if (!draft) continue;
      expect(draft.kind).toBe("answer");
      expect(answer.startsWith(draft.text)).toBe(true);
      expect(draft.text.startsWith(previous)).toBe(true);
      previous = draft.text;
    }
    expect(previous).toBe(answer);
  });
});

describe("drafts from the agent loop", () => {
  const drafts = (w: Awaited<ReturnType<typeof world>>, agent: Parameters<Awaited<ReturnType<typeof world>>["socrates"]>[1], onDraft?: (turnId: string, draft: Draft) => void) => {
    const seen: (Draft & { turnId: string })[] = [];
    const { socrates } = w.socrates([continueTask()], agent);
    const result = socrates.handle("Go.", { onDraft: (turnId, draft) => { seen.push({ turnId, ...draft }); onDraft?.(turnId, draft); } });
    return { seen, result };
  };

  it("sends narration while the agent works and the answer as it is written, then saves only the answer", async () => {
    const w = await world({ files: { "a.txt": "x\n" } });
    const { seen, result } = drafts(w, [{ text: "Reading the file first.", toolCalls: [call("read", { path: "a.txt" })] }, final({ full_answer: "The file holds one line, x." })]);
    const done = await result;
    expect(done).toMatchObject({ kind: "answered", text: "The file holds one line, x." });
    const turnId = done.kind === "answered" ? done.parts[0]!.turn.id : "";
    expect(seen.every((d) => d.turnId === turnId)).toBe(true);
    const narration = seen.filter((d) => d.call === 1);
    expect(narration.at(-1)).toMatchObject({ kind: "narration", text: "Reading the file first." });
    const answer = seen.filter((d) => d.call === 2);
    expect(answer.length).toBeGreaterThan(1);
    expect(answer.every((d) => d.kind === "answer")).toBe(true);
    expect(answer.at(-1)!.text).toBe("The file holds one line, x.");
    expect(JSON.stringify(seen)).not.toContain("continuation_note");
    // Drafts are not part of the record.
    expect(w.store.listEvents({ turnId }).map((e) => e.type)).not.toContain("draft");
  });

  it("starts a new draft for a retried request and for the repair", async () => {
    const w = await world();
    const { seen, result } = drafts(w, [
      (request) => {
        request.onText?.("Half a thought");
        throw new ModelError("busy", "server", 503);
      },
      { text: "All done, the server works." },
      final({ full_answer: "All done." }),
    ]);
    await result;
    // One draft per request: the failed attempt, the first reply (rejected as a final answer), then the repair.
    const last = (call: number) => seen.filter((d) => d.call === call).at(-1);
    expect([...new Set(seen.map((d) => d.call))]).toEqual([1, 2, 3]);
    expect(last(1)).toMatchObject({ kind: "narration", text: "Half a thought" });
    expect(last(2)).toMatchObject({ kind: "narration", text: "All done, the server works." });
    expect(last(3)).toMatchObject({ kind: "answer", text: "All done." });
  });

  it("keeps the turn going when something watching the drafts fails", async () => {
    const w = await world();
    const { result } = drafts(w, [final({ full_answer: "Still answered." })], () => { throw new Error("watcher failed"); });
    expect(await result).toMatchObject({ kind: "answered", text: "Still answered." });
  });

  it("ignores callbacks from a failed request during retry and after the answer is saved", async () => {
    const w = await world();
    let late: ((text: string) => void) | undefined;
    const { seen, result } = drafts(w, [
      (request) => { late = request.onText; request.onText?.("Initial"); throw new ModelError("Retry", "server", 503); },
      () => { late?.(" stale"); return final({ full_answer: "Fresh answer." }); },
    ]);
    await result;
    const count = seen.length;
    late?.(" after completion");
    expect(seen).toHaveLength(count);
    expect(seen.filter(d => d.call === 1).map(d => d.text)).toEqual(["Initial"]);
    expect(seen.at(-1)).toMatchObject({ call: 2, text: "Fresh answer." });
  });

  it("ignores a producer that invokes its callback after Stop", async () => {
    const w = await world();
    const controller = new AbortController();
    let late: ((text: string) => void) | undefined;
    const { socrates } = w.socrates([continueTask()], [(request) => {
      late = request.onText;
      request.onText?.(' {"full_answer":"Partial');
      controller.abort();
      request.onText?.(" after cancellation");
      return final({ full_answer: "Should not be saved." });
    }]);
    const seen: Draft[] = [];
    const result = await socrates.handle("Go.", { signal: controller.signal, onDraft: (_id, d) => seen.push(d) });
    const count = seen.length;
    late?.(" after the interrupted turn");
    expect(seen).toHaveLength(count);
    expect(seen.map(d => d.text)).toEqual(["Partial"]);
    expect(result.kind === "answered" && result.parts[0]!.status).toBe("interrupted");
    expect(w.store.listEvents({ type: "assistant_response" }).some(e => (e.payload as { text: string }).text.includes("Should not"))).toBe(false);
  });

  it("keeps the answer written before a stop on the interrupted turn, and shows it to the next turn as incomplete", async () => {
    const w = await world();
    w.store.reviseGoalNote(w.goalId, "Original goal note.");
    const controller = new AbortController();
    const { socrates, model } = w.socrates([continueTask(), continueTask()], [
      (request) => {
        request.onText?.('{"full_answer":"The first half of the plan');
        controller.abort();
        return final({ full_answer: "Never saved.", goal_note: "Never saved.", task_complete: { reason: "Never." } });
      },
      final({ full_answer: "Continued." }),
    ]);
    const stopped = await socrates.handle("Plan it.", { signal: controller.signal, onDraft: () => {} });
    const turn = stopped.kind === "answered" ? stopped.parts[0]!.turn : null;
    expect(turn).toMatchObject({ status: "interrupted", responseEventId: null });
    expect(w.store.interruption(turn!.id)).toMatchObject({ reason: "cancelled", partial_answer: "The first half of the plan" });
    // Kept as written, never as a final answer: nothing else changes.
    expect(w.store.listEvents({ type: "assistant_response" }).some((e) => (e.payload as { text: string }).text.includes("Never"))).toBe(false);
    expect(w.store.requireGoal(w.goalId).note).toBe("Original goal note.");
    expect(w.store.requireTask(w.taskId)).toMatchObject({ status: "open", continuationNote: "Interrupted by the user while the answer was being written after 0 tool calls." });

    await socrates.handle("Go on.");
    expect(contextText(model.requests[1]!)).toContain("The first half of the plan\n\n(The user stopped this turn after 0 tool calls, while this answer was being written; it is incomplete.)");
  });

  it("keeps nothing when the stop lands before any answer text, or when the reply was not streamed", async () => {
    const w = await world();
    const controller = new AbortController();
    const narrating = w.socrates([continueTask()], [(request) => {
      request.onText?.("Looking at the files first.");
      controller.abort();
      return { toolCalls: [call("glob", { pattern: "*" })] };
    }]);
    const first = await narrating.socrates.handle("Look.", { signal: controller.signal, onDraft: () => {} });
    expect(w.store.interruption(first.kind === "answered" ? first.parts[0]!.turn.id : "")!.partial_answer).toBeUndefined();

    const quiet = new AbortController();
    const plain = w.socrates([continueTask()], [(request) => {
      request.onText?.('{"full_answer":"Not streamed');
      quiet.abort();
      return final();
    }]);
    const second = await plain.socrates.handle("Again.", { signal: quiet.signal });
    expect(w.store.interruption(second.kind === "answered" ? second.parts[0]!.turn.id : "")!.partial_answer).toBeUndefined();
  });
});
