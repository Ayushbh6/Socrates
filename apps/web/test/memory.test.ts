import { describe, expect, it } from "vitest";
import { emptyModel, reduce } from "../src/lib/model";
import type { ServerMessage } from "../src/lib/types";

let seq = 100;
const act = (body: Record<string, unknown>): ServerMessage => ({ type: "activity", seq: ++seq, at: "2026-10-10T10:00:00Z", conversation: "main", ...body } as ServerMessage);
const run = (...messages: ServerMessage[]) => messages.reduce((m, message) => reduce(m, { type: "server", message }), emptyModel());
const memory = (turnId: string, change: string, number: number, text: string) => act({ kind: "memory", turnId, change, memory: { handle: `m${number}`, number, text, kind: "preference", everywhere: true } });
const asked = (turnId: string, text: string) => [
  act({ kind: "message", text }),
  act({ kind: "routed", turnId, projectTurn: 1, goal: { number: 1, title: "Shop" }, task: { number: 1, title: "Tooling" }, chat: 1, lane: null }),
  act({ kind: "answer", turnId, text: "Noted." }),
];

describe("memory under an answer", () => {
  it("shows what the answer remembered and forgot, follows an undo or edit made later, and ignores turns not on the page", () => {
    const model = run(
      ...asked("t1", "Use pnpm, and forget the tabs thing."),
      memory("t1", "saved", 3, "Prefers pnpm over npm."),
      memory("t1", "forgotten", 2, "Uses tabs."),
      act({ kind: "finished", turnId: "t1", status: "completed", reason: null }),
    );
    expect(model.conversations.main![0]!.memories).toEqual([
      { number: 3, text: "Prefers pnpm over npm.", saved: true, forgotten: false },
      { number: 2, text: "Uses tabs.", saved: false, forgotten: true },
    ]);
    const later = [memory("t1", "edited", 3, "Prefers pnpm, never npm."), memory("t1", "forgotten", 3, "Prefers pnpm, never npm.")].reduce((m, message) => reduce(m, { type: "server", message }), model);
    expect(later.conversations.main![0]!.memories[0]).toEqual({ number: 3, text: "Prefers pnpm, never npm.", saved: true, forgotten: true });
    // An edit of a memory this answer did not change, or a change on a turn not loaded here, adds nothing.
    expect(reduce(model, { type: "server", message: memory("t1", "edited", 9, "Other.") }).conversations.main![0]!.memories).toHaveLength(2);
    expect(reduce(model, { type: "server", message: memory("t9", "saved", 9, "Other.") }).conversations).toEqual(model.conversations);
  });
});
