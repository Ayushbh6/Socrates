import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { continueTask } from "../../../packages/router/test/helpers";
import { Responder, liveServer, messageOf } from "./helpers";

const result = (id: string) => (m: Record<string, any>) => m.type === "result" && m.id === id;

async function setup(options: { slowRouter?: boolean; approval?: boolean } = {}) {
  const gates = new Map<string, () => void>();
  const wait = (key: string) => new Promise<void>((resolve) => gates.set(key, resolve));
  const router = new Responder("r", async (_m, request) => {
    if (request.system.startsWith("You name a chat")) return { text: "A chat" };
    if (options.slowRouter) await wait("router");
    return continueTask();
  });
  const seen = new Set<string>();
  const agent = new Responder("a", async (message) => {
    if ((message === "A" || message === "H") && !seen.has(message)) {
      seen.add(message);
      if (options.approval && message === "A") return { toolCalls: [{ name: "terminal", input: { command: "printf mode-check", timeout_ms: 0 } }] };
      await wait(message);
    }
    return final({ full_answer: `Answered ${message}` });
  });
  const server = await liveServer(router, agent);
  const p = await server.page();
  p.send({ type: "hello" });
  await p.next((m) => m.type === "state");
  const asked = (message: string) => expect.poll(() => agent.requests.some((r) => messageOf(r) === message)).toBe(true);
  p.send({ type: "send", id: "a", text: "A", to: "main", chat: { goal: null, task: null } });
  await asked("A");
  const task = server.rt.store.listTasks(server.rt.chatsGoal().id)[0]!;
  const chat = { goal: server.rt.chatsGoal().number, task: task.number };
  const order = () => agent.requests.map(messageOf).filter((m) => m !== "A" || !options.approval);
  const release = (key: string) => gates.get(key)!();
  const queue = async (id: string) => {
    p.send({ type: "queue", id: id.toLowerCase(), text: id, chat });
    await p.next((m) => m.type === "state" && m.queue.some((q: { id: string }) => q.id === id.toLowerCase()));
  };
  const flow = async (id = "C") => {
    p.send({ type: "send", id: id.toLowerCase(), text: id, to: "main" });
    await p.next((m) => m.type === "accepted" && m.id === id.toLowerCase());
    await expect.poll(() => router.requests.some((r) => !r.system.startsWith("You name a chat"))).toBe(true);
  };
  return { ...server, p, task, chat, agent, router, release, asked, order, queue, flow };
}

describe("messages crossing Standard and Flow", () => {
  it("runs earlier queued Standard messages before a later routed Flow message, with fresh history", async () => {
    const s = await setup();
    await s.queue("B");
    await s.queue("B2");
    await s.flow();
    // Work in another task is still independent.
    s.p.send({ type: "send", id: "d", text: "D", to: "main", chat: { goal: null, task: null } });
    await s.p.next(result("d"));
    s.release("A");
    for (const id of ["a", "b", "b2", "c"]) await s.p.next(result(id));
    expect(s.order().filter((m) => m !== "D")).toEqual(["A", "B", "B2", "C"]);
    const history = JSON.stringify(s.agent.requests.find((r) => messageOf(r) === "C")!.messages);
    expect(history).toContain("Answered B2");
    expect(s.rt.store.listEvents({ type: "user_message" })).toHaveLength(5);
  });

  it("releases a Flow message when an earlier queued message is removed", async () => {
    const s = await setup();
    await s.queue("B");
    await s.flow();
    s.p.send({ type: "queue_remove", id: "b" });
    await s.p.next((m) => m.type === "state" && m.queue.length === 0 && m.busy);
    s.release("A");
    await s.p.next(result("a"));
    await s.p.next(result("c"));
    expect(s.order()).toEqual(["A", "C"]);
  });

  it("does not let a later Standard message pass an earlier Flow message still routing", async () => {
    const s = await setup({ slowRouter: true });
    s.release("A");
    await s.p.next(result("a"));
    s.p.send({ type: "send", id: "b", text: "B", to: "main" });
    await expect.poll(() => s.router.requests.some((r) => !r.system.startsWith("You name a chat"))).toBe(true);
    s.p.send({ type: "send", id: "c", text: "C", to: "main", chat: s.chat });
    await s.p.next((m) => m.type === "accepted" && m.id === "c");
    s.release("router");
    await s.p.next(result("b"));
    await s.p.next(result("c"));
    expect(s.order()).toEqual(["A", "B", "C"]);
  });

  it("stops an owner and its Flow waiter without leaving the task busy", async () => {
    const s = await setup({ approval: true });
    await s.p.next((m) => m.type === "approval");
    await s.flow();
    s.p.send({ type: "cancel", conversation: "main", chat: s.chat });
    for (const id of ["a", "c"]) await s.p.next(result(id));
    await expect.poll(() => s.rt.socrates!.taskBusy(s.task.id)).toBe(false);
    expect(s.rt.socrates!.busy).toBe(false);
    expect(s.rt.socrates!.runningChats).toBe(0);
    s.p.send({ type: "send", id: "d", text: "D", to: "main", chat: s.chat });
    await s.p.next(result("d"));
    expect(s.order()).toEqual(["D"]);
  });

  it("keeps a queued Flow message ahead of a later Standard message when its destination is not known yet", async () => {
    const s = await setup();
    s.release("A");
    await s.p.next(result("a"));
    s.p.send({ type: "send", id: "h", text: "H", to: "main" });
    await s.asked("H");
    s.p.send({ type: "queue", id: "b", text: "B" });
    await s.p.next((m) => m.type === "state" && m.queue.some((q: { id: string }) => q.id === "b"));
    await s.queue("C");
    s.release("H");
    for (const id of ["h", "b", "c"]) await s.p.next(result(id));
    expect(s.order()).toEqual(["A", "H", "B", "C"]);
  });

  it("stops only the Flow waiter, keeping the Standard approval and queue alive", async () => {
    const s = await setup({ approval: true });
    const approval = await s.p.next((m) => m.type === "approval");
    await s.queue("B");
    await s.flow();
    s.p.send({ type: "cancel", conversation: "main" });
    await s.p.next(result("c"));
    expect(s.rt.socrates!.taskBusy(s.task.id)).toBe(true);
    const state = await s.p.next((m) => m.type === "state" && !m.busy && m.queue.length === 1 && m.approvals.some((a: { id: string }) => a.id === approval.id));
    expect(state.queue).toHaveLength(1);
    s.p.send({ type: "approve", approval: approval.id, granted: false });
    await s.p.next(result("a"));
    await s.p.next(result("b"));
    expect(s.order()).toEqual(["B"]);
    await expect.poll(() => s.rt.socrates!.taskBusy(s.task.id)).toBe(false);
  });
});
