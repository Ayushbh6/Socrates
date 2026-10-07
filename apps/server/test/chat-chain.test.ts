import { ScriptedModel } from "@socrates/providers";
import type { ModelClient } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { continueTask, createGoal } from "../../../packages/router/test/helpers";
import { SCRIPTED, home, server } from "./helpers";
import { conversationHistory, goalsView } from "../src";

describe("a long task that rolled over into a new chat", () => {
  it("tells the page which chat each part ran in, and how many chats each task has", async () => {
    const router = new ScriptedModel("test:router", [createGoal("Shop", "Fix checkout"), continueTask()]);
    const chat = new ScriptedModel("test:chat", [final({ full_answer: "Fixed." }), final({ full_answer: "Tested." })]);
    const makeModel = (_p: string, model: string): ModelClient => (model === "router" ? router : chat);
    const { rt } = await server(home({ settings: SCRIPTED }), { makeModel });
    const store = rt.store;

    await rt.socrates!.handle("Fix the checkout in my shop.");
    expect(goalsView(store)[0]!.tasks[0]!.chats).toBe(1);

    const task = store.listTasks(store.listGoals().find((g) => !g.general)!.id)[0]!;
    const first = store.currentChat(task.id);
    const capsule = store.recordHistoryRecord({ goal_id: task.goalId, task_id: task.id, chat_id: first.id }, { kind: "handover", from: 1, to: 1, content: {} });
    const second = store.rolloverChat(first.id, capsule);
    expect(second).toMatchObject({ ordinal: 2, continuationOf: first.id, handoverRef: capsule.handle });

    await rt.socrates!.handle("Now test it.");
    const items = conversationHistory(store, null).items;
    expect(items.map((i) => i.parts[0]!.chat)).toEqual([2, 1]);
    expect(goalsView(store)[0]!.tasks[0]!.chats).toBe(2);
    expect(store.listChats(task.id).map((c) => c.ordinal)).toEqual([1, 2]);
  });
});
