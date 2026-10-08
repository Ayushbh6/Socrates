import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { createGoal } from "../../../packages/router/test/helpers";
import { Responder, liveServer } from "./helpers";

const isResult = (id: string) => (m: Record<string, any>) => m.type === "result" && m.id === id;
const naming = (request: { system: string }) => request.system.startsWith("You name a chat");
/** What the agent was shown for its turn. */
const shown = (request: { messages: unknown }) => JSON.stringify(request.messages);

describe("goal and task status, set by the user", () => {
  it("marks a task done, superseded or open again, and a goal; the goals list says who closed a task and why", async () => {
    let close = true;
    const router = new Responder("r", () => createGoal("Shop", "Fix checkout"));
    const agent = new Responder("a", () => final({ full_answer: "Fixed.", ...(close ? { task_complete: { reason: "The checkout test passes." } } : {}) }));
    const { page, rt, app, token, port } = await liveServer(router, agent);
    const headers = { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` };
    const goals = async () => (await app.inject({ method: "GET", url: "/api/goals", headers })).json() as { number: number; status: string; tasks: { status: string; closed: unknown }[] }[];
    const status = (url: string, value: string) => app.inject({ method: "POST", url, headers, payload: { status: value } });

    const p = await page();
    p.send({ type: "send", id: "m1", text: "Fix the checkout.", to: "main" });
    await p.next(isResult("m1"));
    // Socrates closed it, with its reason.
    expect((await goals())[0]!.tasks[0]).toMatchObject({ status: "completed", closed: { by: "socrates", reason: "The checkout test passes." } });

    expect((await status("/api/goals/1/tasks/1/status", "open")).statusCode).toBe(200);
    expect((await goals())[0]!.tasks[0]).toMatchObject({ status: "open", closed: null });
    await status("/api/goals/1/tasks/1/status", "superseded");
    expect((await goals())[0]!.tasks[0]).toMatchObject({ status: "superseded", closed: { by: "user", reason: null } });
    await status("/api/goals/1/status", "completed");
    expect((await goals())[0]).toMatchObject({ status: "completed" });
    expect(rt.store.listEvents({ type: "goal_status_set" }).map((e) => e.payload)).toEqual([{ status: "completed" }]);
    // A goal's status is the user's alone; its tasks keep theirs.
    expect((await goals())[0]!.tasks[0]!.status).toBe("superseded");

    expect((await status("/api/goals/1/tasks/9/status", "open")).statusCode).toBe(404);
    expect((await status("/api/goals/1/tasks/1/status", "done")).statusCode).toBe(400);

    // The router is told what the user chose.
    p.send({ type: "send", id: "m2", text: "Something else entirely.", to: "main" });
    await p.next(isResult("m2"));
    const told = shown(router.requests.at(-1)!);
    expect(told).toContain("Fix checkout — superseded by the user");
    expect(told).toContain("status: completed (set by the user)");
  });

  it("tells the agent the user reopened a task, so it stays open unless the reopened work is finished", async () => {
    const router = new Responder("r", () => createGoal("Shop", "Fix checkout"));
    const agent = new Responder("a", () => final({ full_answer: "Fixed.", task_complete: { reason: "Tests pass." } }));
    const { page, rt } = await liveServer(router, agent);
    const p = await page();
    p.send({ type: "send", id: "m1", text: "Fix the checkout.", to: "main" });
    await p.next(isResult("m1"));
    const task = rt.store.listTasks(rt.store.getGoalByNumber(1)!.id)[0]!;
    rt.store.setTaskStatus(task.id, "open");

    // The next message kept in this task is not routed, and the agent is told why it is open.
    const asked = router.requests.length;
    p.send({ type: "send", id: "m2", text: "One more thing on the checkout.", to: "main", keep: { goal: 1, task: 1 } });
    await p.next(isResult("m2"));
    expect(router.requests.length).toBe(asked);
    const context = shown(agent.requests.at(-1)!);
    expect(context).toContain("the user reopened this task on");
    expect(context).toContain("kept_here: the user chose to keep this message in this task");
    expect(rt.store.turnRoute(rt.store.listEvents({ type: "turn_bound" }).at(-1)!.turn_id!)).toBe("pinned");
  });

  it("keeps a message in a closed task: the task is reopened as the user's choice, and only that message skips the router", async () => {
    const router = new Responder("r", () => createGoal("Shop", "Fix checkout"));
    const agent = new Responder("a", () => final({ full_answer: "Fixed.", task_complete: { reason: "Tests pass." } }));
    const { page, rt } = await liveServer(router, agent);
    const p = await page();
    p.send({ type: "send", id: "m1", text: "Fix the checkout.", to: "main" });
    await p.next(isResult("m1"));
    const task = rt.store.listTasks(rt.store.getGoalByNumber(1)!.id)[0]!;
    expect(rt.store.requireTask(task.id).status).toBe("completed");

    const asked = router.requests.length;
    p.send({ type: "send", id: "m2", text: "Actually, also the coupon field.", to: "main", keep: { goal: 1, task: 1 } });
    await p.next(isResult("m2"));
    expect(router.requests.length).toBe(asked);
    expect(rt.store.listEvents({ type: "task_status_set" }).map((e) => e.payload)).toEqual([{ status: "open" }]);
    // Flow turns may still close it with a reason; the next message is routed again.
    expect(rt.store.statusSource(task.id)).toMatchObject({ by: "socrates", reason: "Tests pass." });
    p.send({ type: "send", id: "m3", text: "And the footer.", to: "main" });
    await p.next(isResult("m3"));
    expect(router.requests.length).toBeGreaterThan(asked);

    // Refusals: a task that is not there, a lane, or both a chat and a kept task.
    p.send({ type: "send", id: "m4", text: "x", to: "main", keep: { goal: 1, task: 7 } });
    expect(await p.next((m) => m.type === "error" && m.id === "m4")).toMatchObject({ code: "not_found" });
    p.send({ type: "send", id: "m5", text: "x", to: "new_lane", keep: { goal: 1, task: 1 } });
    expect(await p.next((m) => m.type === "error" && m.id === "m5")).toMatchObject({ code: "bad_request" });
    p.send({ type: "send", id: "m6", text: "x", to: "main", keep: { goal: 1, task: 1 }, chat: { goal: 1, task: 1 } });
    expect(await p.next((m) => m.type === "error" && m.id === "m6")).toMatchObject({ code: "bad_request" });
  });

  it("never lets the agent close a standard-mode chat, and tells it so", async () => {
    const router = new Responder("r", (_m, request) => (naming(request) ? { text: "Checkout repair" } : { text: "the router must not be asked" }));
    const agent = new Responder("a", () => final({ full_answer: "Fixed.", task_complete: { reason: "Tests pass." } }));
    const { page, rt } = await liveServer(router, agent);
    const p = await page();
    p.send({ type: "send", id: "m1", text: "Fix the checkout.", to: "main", chat: { goal: null, task: null } });
    await p.next(isResult("m1"));
    const [task] = rt.store.listTasks(rt.chatsGoal().id);
    expect(task!.status).toBe("open");
    expect(rt.store.statusSource(task!.id)).toBeNull();
    expect(shown(agent.requests[0]!)).toContain("a chat in standard mode, which is never marked complete");
  });
});
