import { describe, expect, it } from "vitest";
import { continueTask } from "../../router/test/helpers";
import { interruptUnfinishedTurns } from "../src";
import { contextText, final, world } from "./helpers";

describe("restart", () => {
  it("interrupts turns a stopped process left running, and the next turn sees why it has no answer", async () => {
    const w = await world();
    const turn = w.store.bindTurn({ userEventId: w.store.recordUserMessage("Run the long migration.").id, taskId: w.taskId, route: "test" });
    w.store.recordToolCall({ goal_id: w.goalId, task_id: w.taskId, chat_id: turn.chatId, turn_id: turn.id }, { callId: "c1", tool: "terminal", input: { command: "npm run migrate" } });

    expect(interruptUnfinishedTurns(w.store).map((t) => t.id)).toEqual([turn.id]);
    expect(interruptUnfinishedTurns(w.store)).toEqual([]);
    expect(w.store.requireTask(w.taskId).continuationNote).toBe("Interrupted when Socrates stopped after 1 tool call.");

    const { socrates, model } = w.socrates([continueTask()], [final()]);
    await socrates.handle("Did the migration finish?");
    expect(contextText(model.requests[0]!)).toContain("(Socrates stopped while this turn ran, after 1 tool call; no answer was given.)");
  });
});
