import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { Responder, liveServer, messageOf } from "./helpers";

const isResult = (id: string) => (m: Record<string, any>) => m.type === "result" && m.id === id;
const naming = (request: { system: string }) => request.system.startsWith("You name a chat");

/** Answers held until the test lets them go, by message. */
function held() {
  const waiting = new Map<string, () => void>();
  return {
    wait: (message: string) => new Promise<void>((resolve) => waiting.set(message, resolve)),
    release: (message: string) => waiting.get(message)!(),
  };
}

/** A server whose agent holds every message starting "Slow" until released. */
async function setup() {
  const gate = held();
  const router = new Responder("r", (_m, request) => (naming(request) ? { text: "A chat" } : { text: "the router must not be asked" }));
  const agent = new Responder("a", async (message) => {
    if (message.startsWith("Slow")) await gate.wait(message);
    return final({ full_answer: `Answered: ${message}` });
  });
  const server = await liveServer(router, agent);
  const p = await server.page();
  p.send({ type: "hello" });
  await p.next((m) => m.type === "state");
  const asked = (message: string) => expect.poll(() => agent.requests.some((r) => messageOf(r) === message), { timeout: 5000 }).toBe(true);
  const chats = () => server.rt.store.listTasks(server.rt.chatsGoal().id);
  const chatOf = (title: string) => {
    const task = chats().find((t) => t.objective === title)!;
    return { goal: server.rt.chatsGoal().number, task: task.number };
  };
  return { ...server, p, gate, agent, router, asked, chatOf };
}

describe("standard-mode chats run beside each other, each as its own lane would", () => {
  it("works in two chats at once without holding the main conversation, and stops only the chat asked", async () => {
    const { p, rt, gate, asked, chatOf } = await setup();
    p.send({ type: "send", id: "m1", text: "Slow A", to: "main", chat: { goal: null, task: null } });
    await asked("Slow A");
    p.send({ type: "send", id: "m2", text: "Slow B", to: "main", chat: { goal: null, task: null } });
    await asked("Slow B");

    // Both work; the main conversation is free, and the page is told which chats work.
    expect(rt.socrates!.busy).toBe(false);
    expect(rt.socrates!.runningChats).toBe(2);
    const a = chatOf("Slow A");
    const b = chatOf("Slow B");
    const state = await p.next((m) => m.type === "state" && m.working?.length === 2);
    expect(state.working).toEqual(expect.arrayContaining([a, b]));
    expect(state.busy).toBe(false);

    // Stopping the main conversation leaves the chats alone; stopping a chat stops only it.
    p.send({ type: "cancel", conversation: "main" });
    expect(await p.next((m) => m.type === "error" && m.code === "not_running")).toBeTruthy();
    p.send({ type: "cancel", conversation: "main", chat: b });
    await p.next(isResult("m2"));
    expect(rt.store.listEvents({ type: "turn_interrupted" })).toHaveLength(1);
    expect(rt.socrates!.runningChats).toBe(1);

    gate.release("Slow A");
    const done = await p.next(isResult("m1"));
    expect(done.result.parts[0].status).toBe("completed");
    expect(rt.socrates!.runningChats).toBe(0);
  });

  it("queues a message for a working chat until that chat is free, while other chats go on", async () => {
    const { p, rt, gate, asked, chatOf } = await setup();
    p.send({ type: "send", id: "m1", text: "Slow A", to: "main", chat: { goal: null, task: null } });
    await asked("Slow A");
    const a = chatOf("Slow A");

    // Sent to the working chat, it is refused so the page queues it there.
    p.send({ type: "send", id: "m2", text: "Then this in A", to: "main", chat: a });
    expect(await p.next((m) => m.type === "error" && m.id === "m2")).toMatchObject({ code: "chat_busy" });
    p.send({ type: "queue", id: "m2", text: "Then this in A", chat: a });
    expect((await p.next((m) => m.type === "state" && m.queue.length === 1)).queue[0]).toMatchObject({ id: "m2", chat: a });
    // Another chat sent meanwhile is not held up by it.
    p.send({ type: "send", id: "m3", text: "Quick C", to: "main", chat: { goal: null, task: null } });
    await p.next(isResult("m3"));
    expect(rt.store.listTasks(rt.chatsGoal().id)).toHaveLength(2);

    gate.release("Slow A");
    await p.next(isResult("m1"));
    // It starts once A is free, in A, and the page learns which saved message it is.
    const accepted = await p.next((m) => m.type === "accepted" && m.id === "m2");
    const message = rt.store.listEvents({ type: "user_message" }).find((e) => (e.payload as { text: string }).text === "Then this in A")!;
    expect(accepted.seq).toBe(message.seq);
    await p.next(isResult("m2"));
    const turn = rt.store.listEvents({ type: "turn_bound" }).at(-1)!;
    expect(rt.store.requireTask(rt.store.requireTurn(turn.turn_id!).taskId!).objective).toBe("Slow A");
  });

  it("runs at most four chats at once; a fifth waits in the queue and starts when one finishes", async () => {
    const { p, rt, gate, asked } = await setup();
    for (const n of [1, 2, 3, 4]) {
      p.send({ type: "send", id: `m${n}`, text: `Slow ${n}`, to: "main", chat: { goal: null, task: null } });
      await asked(`Slow ${n}`);
    }
    p.send({ type: "send", id: "m5", text: "Fifth", to: "main", chat: { goal: null, task: null } });
    expect(await p.next((m) => m.type === "error" && m.id === "m5")).toMatchObject({ code: "chat_busy" });
    p.send({ type: "queue", id: "m5", text: "Fifth", chat: { goal: null, task: null } });
    await p.next((m) => m.type === "state" && m.queue.length === 1);
    expect(rt.socrates!.runningChats).toBe(4);

    gate.release("Slow 2");
    await p.next(isResult("m2"));
    await p.next(isResult("m5"));
    for (const n of [1, 3, 4]) gate.release(`Slow ${n}`);
    for (const n of [1, 3, 4]) await p.next(isResult(`m${n}`));
  });

  it("changes the model that names chats at once, even while a chat works; other models wait until Socrates is idle", async () => {
    const { p, app, token, port, rt, gate, asked } = await setup();
    const headers = { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` };
    p.send({ type: "send", id: "m1", text: "Slow A", to: "main", chat: { goal: null, task: null } });
    await asked("Slow A");

    const renamed = await app.inject({ method: "PUT", url: "/api/settings", headers, payload: { titler: { provider: "openrouter", model: "some/namer" } } });
    expect(renamed.statusCode).toBe(200);
    expect(rt.models.titler).toMatchObject({ provider: "openrouter", model: "some/namer", source: "settings" });
    // The chat goes on: Socrates was not rebuilt.
    expect(rt.socrates!.runningChats).toBe(1);
    const routing = await app.inject({ method: "PUT", url: "/api/settings", headers, payload: { router: { provider: "gemini", model: "router" } } });
    expect(routing.statusCode).not.toBe(200);

    gate.release("Slow A");
    await p.next(isResult("m1"));
    // Back to automatic.
    expect((await app.inject({ method: "PUT", url: "/api/settings", headers, payload: { titler: null } })).statusCode).toBe(200);
    expect(rt.models.titler?.model).not.toBe("some/namer");
  });
});
