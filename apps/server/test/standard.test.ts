import { ScriptedModel } from "@socrates/providers";
import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { cleanTitle, nameChat, provisionalTitle } from "../src/titles";
import { Responder, liveServer } from "./helpers";

const isResult = (id: string) => (m: Record<string, any>) => m.type === "result" && m.id === id;
const naming = (request: { system: string }) => request.system.startsWith("You name a chat");

describe("chat names", () => {
  it("start as the first words of the first message", () => {
    expect(provisionalTitle("  Fix   the checkout on mobile please, it breaks ")).toBe("Fix the checkout on mobile please,…");
    expect(provisionalTitle("Hello there")).toBe("Hello there");
    expect(provisionalTitle("", 2)).toBe("2 images");
    expect(provisionalTitle("")).toBe("New chat");
  });

  it("keep only a short plain name from the model's reply", () => {
    expect(cleanTitle('"Mobile checkout fix."')).toBe("Mobile checkout fix");
    expect(cleanTitle("<think>hmm</think>\nTitle: Resume review\nmore")).toBe("Resume review");
    expect(cleanTitle("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight");
    expect(cleanTitle("  \n ")).toBeNull();
  });

  it("are asked for with the first question and answer, as a recorded call of its own", async () => {
    const model = new ScriptedModel("test:titler", [{ text: "Checkout fix" }]);
    const title = await nameChat(model, { message: "Fix the checkout.", answer: "Fixed the null check.", trace: { goalId: "g", taskId: "t", turnId: "u", userEventId: "e" } });
    expect(title).toBe("Checkout fix");
    expect(model.requests[0]!.trace).toMatchObject({ role: "other", taskId: "t" });
    expect(JSON.stringify(model.requests[0]!.messages)).toContain("Fixed the null check.");
  });
});

describe("standard mode: the user chooses the chat", () => {
  it("never routes: a new chat in Chats, then its name, then the same chat again", async () => {
    const router = new Responder("r", (_m, request) => (naming(request) ? { text: "Checkout repair" } : { text: "the router must not be asked" }));
    const agent = new Responder("a", () => final({ full_answer: "Done." }));
    const { page, rt } = await liveServer(router, agent);
    const p = await page();
    p.send({ type: "hello" });
    await p.next((m) => m.type === "state");

    p.send({ type: "send", id: "m1", text: "Fix the checkout on the phone.", to: "main", chat: { goal: null, task: null } });
    await p.next(isResult("m1"));
    const chats = rt.chatsGoal();
    const [task] = rt.store.listTasks(chats.id);
    expect(task!.objective).toBe("Fix the checkout on the phone.");
    // Named at first by its first words.
    expect(rt.store.listEvents({ type: "task_created" }).at(-1)!.payload).toMatchObject({ title: "Fix the checkout on the phone." });
    expect(router.requests.filter((r) => !naming(r))).toHaveLength(0);

    // The name arrives in the background.
    await expect.poll(() => rt.store.requireTask(task!.id).title).toBe("Checkout repair");

    p.send({ type: "send", id: "m2", text: "Now the tablet.", to: "main", chat: { goal: chats.number, task: task!.number } });
    await p.next(isResult("m2"));
    expect(rt.store.listTasks(chats.id)).toHaveLength(1);
    expect(router.requests.filter((r) => !naming(r))).toHaveLength(0);
    // Only a new chat is named.
    expect(router.requests.filter(naming)).toHaveLength(1);
  });

  it("starts a chat in a goal the user made, and refuses one that does not exist", async () => {
    const router = new Responder("r", (_m, request) => (naming(request) ? { text: "Hero layout" } : { text: "no" }));
    const { page, rt } = await liveServer(router, new Responder("a", () => final({ full_answer: "Done." })));
    const goal = rt.store.createGoal({ title: "Website" });
    const p = await page();
    p.send({ type: "hello" });
    await p.next((m) => m.type === "state");

    p.send({ type: "send", id: "m1", text: "Make the hero fit on phones.", to: "main", chat: { goal: goal.number, task: null } });
    await p.next(isResult("m1"));
    expect(rt.store.listTasks(goal.id).map((t) => t.number)).toEqual([1]);

    p.send({ type: "send", id: "m2", text: "Hello.", to: "main", chat: { goal: 99, task: null } });
    expect(await p.next((m) => m.type === "error" && m.id === "m2")).toMatchObject({ code: "not_found" });
  });
});
