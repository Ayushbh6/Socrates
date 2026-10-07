import { ScriptedModel } from "@socrates/providers";
import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { continueTask, createGoal } from "../../../packages/router/test/helpers";
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
    await expect.poll(() => rt.store.requireTask(task!.id).title, { timeout: 5000 }).toBe("Checkout repair");

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

describe("switching between flow and standard mode", () => {
  it("picks up in flow mode the chat that standard mode continued last, with its standard turns in the history", async () => {
    const flow: Record<string, () => { text: string }> = {
      "Describe the workspace.": () => createGoal("Workspace exploration", "Describe workspace folder contents"),
      "Critique my resume.": () => createGoal("Career profile", "Review and critique resume"),
      "And the TU folder?": () => continueTask(),
    };
    const router = new Responder("r", (message, request) => (naming(request) ? { text: "unused" } : flow[message]?.() ?? { text: `unexpected: ${message}` }));
    const agent = new Responder("a", (message) => final({ full_answer: `Answer to: ${message}` }));
    const { page, rt } = await liveServer(router, agent);
    const store = rt.store;
    const p = await page();
    p.send({ type: "hello" });
    await p.next((m) => m.type === "state");
    const say = async (id: string, text: string, chat?: { goal: number; task: number }) => {
      p.send({ type: "send", id, text, to: "main", ...(chat ? { chat } : {}) });
      await p.next(isResult(id));
    };

    // Flow: one goal, then another.
    await say("f1", "Describe the workspace.");
    await say("f2", "Critique my resume.");
    const workspace = store.listGoals().find((g) => g.title === "Workspace exploration")!;
    const describe = store.listTasks(workspace.id)[0]!;
    expect(store.currentBinding()!.task.title).toBe("Review and critique resume");

    // Standard: back to the first goal's chat, two more questions there.
    await say("s1", "What is in CoverNow?", { goal: workspace.number, task: describe.number });
    await say("s2", "And Me?", { goal: workspace.number, task: describe.number });
    expect(store.currentBinding()!.task.id).toBe(describe.id);

    // Flow again: the router sees that chat as the current one and continues it.
    const before = router.requests.length;
    await say("f3", "And the TU folder?");
    const routing = router.requests.slice(before).find((r) => !naming(r))!;
    const context = JSON.stringify(routing.messages);
    expect(context).toContain("Workspace exploration");
    expect(context).toContain("And Me?");
    const last = store.currentBinding()!;
    expect(last.task.id).toBe(describe.id);
    expect(store.listTasks(workspace.id)).toHaveLength(1);

    // The agent's context for that turn holds the questions asked in standard mode.
    const work = JSON.stringify(agent.requests.at(-1)!.messages);
    expect(work).toContain("What is in CoverNow?");
    expect(work).toContain("And Me?");
    expect(work).not.toContain("Critique my resume.");
  });
});

describe("renaming and archiving chats and goals", () => {
  async function setup() {
    const router = new Responder("r", (_m, request) => (naming(request) ? { text: "Machine name" } : { text: "no" }));
    const agent = new Responder("a", () => final({ full_answer: "Done." }));
    const live = await liveServer(router, agent);
    const call = async (method: string, url: string, body?: object) => {
      const response = await live.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${live.token}`, host: `127.0.0.1:${live.port}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
      return { status: response.statusCode, body: response.json() as any };
    };
    return { ...live, call, router, agent };
  }

  it("renames a chat and a goal; the user's name is never replaced by the namer", async () => {
    const { page, rt, call } = await setup();
    const p = await page();
    p.send({ type: "hello" });
    await p.next((m) => m.type === "state");
    const goal = rt.store.createGoal({ title: "Website" });
    p.send({ type: "send", id: "m1", text: "Make the hero fit on phones.", to: "main", chat: { goal: goal.number, task: null } });
    // The user renames the chat while it is still being worked on, before the namer answers.
    const task = await expect.poll(() => rt.store.listTasks(goal.id)[0], { timeout: 5000 }).toBeDefined().then(() => rt.store.listTasks(goal.id)[0]!);
    expect((await call("PATCH", `/api/goals/${goal.number}/tasks/${task.number}`, { title: "Hero on phones" })).status).toBe(200);
    await p.next(isResult("m1"));
    await new Promise((r) => setTimeout(r, 150));
    expect(rt.store.requireTask(task.id).title).toBe("Hero on phones");
    expect(rt.store.titleSetByUser(task.id)).toBe(true);

    expect((await call("PATCH", `/api/goals/${goal.number}`, { title: "Company site" })).body.title).toBe("Company site");
    expect((await call("PATCH", `/api/goals/${goal.number}`, { title: "   " })).status).toBe(400);
    expect((await call("PATCH", "/api/goals/99", { title: "x" })).status).toBe(404);
  });

  it("archives a chat and a goal out of the lists and the router's view, and restores them", async () => {
    const { page, rt, call } = await setup();
    const p = await page();
    p.send({ type: "hello" });
    await p.next((m) => m.type === "state");
    const goal = rt.store.createGoal({ title: "Website" });
    p.send({ type: "send", id: "m1", text: "Make the hero fit on phones.", to: "main", chat: { goal: goal.number, task: null } });
    await p.next(isResult("m1"));
    const task = rt.store.listTasks(goal.id)[0]!;

    expect((await call("POST", `/api/goals/${goal.number}/tasks/${task.number}/archive`)).status).toBe(200);
    expect((await call("GET", "/api/goals")).body.find((g: any) => g.number === goal.number).tasks).toEqual([]);
    expect((await call("GET", "/api/archived")).body.tasks).toEqual([expect.objectContaining({ number: task.number, goal: { number: goal.number, title: "Website" } })]);

    // An archived chat is not found, so nothing can be sent into it.
    p.send({ type: "send", id: "m2", text: "More.", to: "main", chat: { goal: goal.number, task: task.number } });
    expect(await p.next((m) => m.type === "error" && m.id === "m2")).toMatchObject({ code: "not_found" });

    expect((await call("POST", `/api/goals/${goal.number}/tasks/${task.number}/restore`)).status).toBe(200);
    p.send({ type: "send", id: "m3", text: "More.", to: "main", chat: { goal: goal.number, task: task.number } });
    await p.next(isResult("m3"));

    expect((await call("POST", `/api/goals/${goal.number}/archive`)).status).toBe(200);
    expect((await call("GET", "/api/goals")).body.some((g: any) => g.number === goal.number)).toBe(false);
    expect((await call("GET", "/api/archived")).body.goals).toEqual([expect.objectContaining({ number: goal.number, chats: 1 })]);
    expect((await call("POST", `/api/goals/${goal.number}/restore`)).status).toBe(200);
    expect((await call("GET", "/api/goals")).body.find((g: any) => g.number === goal.number).tasks).toHaveLength(1);
  });

  it("will not archive the Chats list, and refuses while Socrates is working in the chat", async () => {
    const gate = new Promise<void>(() => {});
    const router = new Responder("r", () => ({ text: "no" }));
    const agent = new Responder("a", async () => (await gate, final()));
    const live = await liveServer(router, agent);
    const call = (method: string, url: string) => live.app.inject({ method: method as "POST", url, headers: { authorization: `Bearer ${live.token}`, host: `127.0.0.1:${live.port}` } });
    const p = await live.page();
    p.send({ type: "hello" });
    await p.next((m) => m.type === "state");
    p.send({ type: "send", id: "m1", text: "Take a while.", to: "main", chat: { goal: null, task: null } });
    await p.next((m) => m.type === "accepted");
    const chats = live.rt.chatsGoal();
    await expect.poll(() => live.rt.store.listTasks(chats.id).length, { timeout: 5000 }).toBe(1);
    const task = live.rt.store.listTasks(chats.id)[0]!;
    await expect.poll(async () => (await call("POST", `/api/goals/${chats.number}/tasks/${task.number}/archive`)).statusCode, { timeout: 5000 }).toBe(409);
    expect((await call("POST", `/api/goals/${chats.number}/archive`)).statusCode).toBe(400);
    live.rt.socrates!.close().catch(() => {});
  });
});
