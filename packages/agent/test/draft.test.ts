import { ModelError } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { type Draft, draftOf } from "../src";
import { continueTask } from "../../router/test/helpers";
import { call, final, world } from "./helpers";

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
});
