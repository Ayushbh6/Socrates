import { describe, expect, it } from "vitest";
import { redoBlock } from "../src/components/RedoMenu";
import { emptyModel, reduce } from "../src/lib/model";
import type { ServerMessage } from "../src/lib/types";

let seq = 100;
const act = (body: Record<string, unknown>, at = "2026-10-09T10:00:00Z"): ServerMessage => ({ type: "activity", seq: ++seq, at, conversation: "main", ...body } as ServerMessage);
const run = (...messages: ServerMessage[]) => messages.reduce((m, message) => reduce(m, { type: "server", message }), emptyModel());
const place = (goal: number, goalTitle: string, task: number, taskTitle: string) => ({ goal: { number: goal, title: goalTitle }, task: { number: task, title: taskTitle }, chat: 1 });
const asked = (turnId: string, text: string, where: ReturnType<typeof place>, at: string, extra: Record<string, unknown> = {}) => [
  act({ kind: "message", text }, at),
  act({ kind: "routed", turnId, projectTurn: Number(turnId.slice(1)), goal: where.goal, task: where.task, chat: 1, lane: null, ...extra }, at),
  act({ kind: "answer", turnId, text: "Answered." }, at),
  act({ kind: "finished", turnId, status: "completed", reason: null }, at),
];

describe("redo in another task, on the page", () => {
  const general = place(5, "General conversation", 2, "General · Fri 9 Oct");
  const work = place(1, "Workspace exploration", 1, "Describe folders");

  it("folds the first attempt once it is redone, and says where the redo came from", () => {
    const model = run(
      ...asked("t1", "Test the terminal.", general, "2026-10-09T10:00:00Z"),
      ...asked("t2", "Test the terminal.", work, "2026-10-09T10:01:00Z", { redoneFrom: general }),
      act({ kind: "redone", turnId: "t1", to: work }),
    );
    const [first, second] = model.conversations.main!;
    expect(first).toMatchObject({ redoneTo: work, redoneFrom: null });
    expect(second).toMatchObject({ redoneTo: null, redoneFrom: general });
    // A redo of a question this page has not loaded changes nothing.
    expect(reduce(model, { type: "server", message: act({ kind: "redone", turnId: "t9", to: work }) }).conversations.main).toEqual(model.conversations.main);
  });

  it("offers it for a finished question that is still its task's latest, and says why not otherwise", () => {
    const list = run(
      ...asked("t1", "First.", work, "2026-10-09T10:00:00Z"),
      ...asked("t2", "Second.", work, "2026-10-09T10:01:00Z"),
      ...asked("t3", "Elsewhere.", general, "2026-10-09T10:02:00Z"),
    ).conversations.main!;
    expect(redoBlock(list[0]!, list)).toBe("Later questions in this task build on this answer.");
    expect(redoBlock(list[1]!, list)).toBeNull();
    expect(redoBlock(list[2]!, list)).toBeNull();
    expect(redoBlock({ ...list[1]!, state: "working" }, list)).toBeUndefined();
    expect(redoBlock({ ...list[1]!, redoneTo: general }, list)).toBeUndefined();
  });
});
