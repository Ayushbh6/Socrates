import { describe, expect, it } from "vitest";
import { fixedClock } from "@socrates/shared";
import { final } from "../../../packages/agent/test/helpers";
import { general } from "../../../packages/router/test/helpers";
import { Responder, liveServer, messageOf, runtime } from "./helpers";

const original = "Please try the terminal test again.";
const ask = {toolCalls: [{name: "ask_user", input: {question: "Which folder should I use for the terminal test?", candidates: [{label: "Work folder", detail: "Use Work as discussed", suggested: true, goal_label: "general"}], allow_new: false}}]};
const result = (id: string) => (m: Record<string, any>) => m.type === "result" && m.id === id;

async function setup(options: {hold?: Promise<void>} = {}) {
  const clock = fixedClock("2026-10-10T13:03:00Z");
  const router = new Responder("router", message => message === original || message === "Another ambiguous request" ? ask : general());
  const agent = new Responder("agent", async message => {if (message === "Hold main" && options.hold) await options.hold; return final({full_answer: `Finished: ${message}`});});
  const s = await liveServer(router, agent, {settings: {chat: {provider: "gemini", model: "chat"}, router: {provider: "gemini", model: "router"}, timeZone: "Europe/Vienna"}, deps: {clock}});
  const old = s.rt.store.ensureGeneral("Europe/Vienna", new Date("2026-10-09T08:00:00Z"));
  const p = await s.page(); p.send({type: "hello"}); await p.next(m => m.type === "state");
  p.send({type: "send", id: "original", text: original, to: "main"});
  await p.next(result("original"));
  const question = s.rt.store.pendingClarification()!;
  const get = async (url: string) => (await s.app.inject({url, headers: {host: `127.0.0.1:${s.port}`, authorization: `Bearer ${s.token}`}})).json();
  return {...s, p, question, old, clock, router, agent, get};
}

describe("routing question lifecycle through live clients and history", () => {
  it("survives unrelated Standard activity and another page, then answers one original query in today's General", async () => {
    const s = await setup();
    s.p.send({type: "send", id: "other", text: "Independent Standard work", to: "main", chat: {goal: null, task: null}});
    await s.p.next(result("other"));
    const second = await s.page(); second.send({type: "hello"});
    const waiting = await second.next(m => m.type === "state");
    expect(waiting.routingQuestions).toEqual([expect.objectContaining({requestId: s.question.userEventId, state: "pending", message: original})]);
    second.send({type: "reply", id: "reply", clarification: s.question.id, text: "yes pls sure"});
    await second.next(result("reply"));
    const history = await s.get("/api/history?conversation=main");
    expect(history.items).toHaveLength(2);
    const linked = history.items.find((i: any) => i.message === original);
    expect(linked).toMatchObject({clarification: {answer: "yes pls sure", state: "answered"}, parts: [{answer: `Finished: ${original}`, task: {title: "General · Sat 10 Oct"}}]});
    expect(history.items.some((i: any) => i.message === "yes pls sure")).toBe(false);
    expect(s.rt.store.turnsForTask(s.old.task.id)).toHaveLength(0);
    const routed = second.received.find(m => m.kind === "routed" && m.original);
    expect(routed).toMatchObject({messageSeq: linked.seq, original: {message: original}});
    expect(JSON.stringify(s.agent.requests.at(-1)!.messages)).toContain("yes pls sure");
    await s.rt.flushCalls();
    const questions = await s.get("/api/observe/questions?range=all");
    expect(questions.questions.filter((q: any) => q.message === original)).toHaveLength(1);
    expect(questions.questions.some((q: any) => q.message === "yes pls sure")).toBe(false);
    const trace = await s.get(`/api/observe/questions/${s.question.userEventId}/trace`);
    expect(trace.question.message).toBe(original);
    expect(trace.items.some((i: any) => i.text === "Reply to routing question: yes pls sure")).toBe(true);
  });

  it("keeps several unanswered questions distinct and resumes the explicitly selected one", async () => {
    const s = await setup();
    s.p.send({type: "send", id: "second", text: "Another ambiguous request", to: "main"}); await s.p.next(result("second"));
    const pending = s.rt.store.clarifications().filter(q => q.state === "pending"); expect(pending).toHaveLength(2);
    s.p.send({type: "reply", id: "first-reply", clarification: s.question.id, text: "Work"}); await s.p.next(result("first-reply"));
    expect(s.rt.store.clarification(pending[1]!.turnId).state).toBe("pending");
    expect(messageOf(s.agent.requests[0]!)).toBe(original);
  });

  it("rejects duplicate replies from another tab without a second agent run", async () => {
    const s = await setup(); const other = await s.page();
    s.p.send({type: "reply", id: "reply", clarification: s.question.id, text: "Work"}); await s.p.next(result("reply"));
    other.send({type: "reply", id: "duplicate", clarification: s.question.id, text: "Work"});
    await other.next(m => m.type === "error" && m.code === "clarification_resolved");
    expect(s.agent.requests).toHaveLength(1);
  });

  it("loads an old pending request directly, then paginates its completed exchange once at the latest reply", async () => {
    const s = await setup();
    const goal = s.rt.store.createGoal({title: "Independent work"}); const task = s.rt.store.createTask(goal.id, {title: "Questions"});
    for (let i = 0; i < 35; i++) {
      const user = s.rt.store.recordUserMessage(`Independent ${i}`);
      const turn = s.rt.store.bindTurn({userEventId: user.id, taskId: task.id, route: "standard"});
      s.rt.store.completeTurn(turn.id, {responseEventId: s.rt.store.recordResponse("Answer").id, continuationNote: null});
    }
    const recent = await s.get("/api/history?conversation=main"); expect(recent.items.some((i: any) => i.message === original)).toBe(false);
    const old = await s.get(`/api/requests/${s.question.userEventId}`); expect(old.item.message).toBe(original);
    s.p.send({type: "reply", id: "reply", clarification: s.question.id, text: "Work"}); await s.p.next(result("reply"));
    const first = await s.get("/api/history?conversation=main"); expect(first.items[0].message).toBe(original);
    const next = await s.get(`/api/history?conversation=main&before=${first.next}`);
    expect([...first.items, ...next.items].filter((i: any) => i.message === original)).toHaveLength(1);
  });

  it("keeps the original General day after midnight, while new Standard sends continue today's chat with earlier context", async () => {
    const s = await setup(); s.clock.set("2026-10-10T22:30:00Z");
    s.p.send({type: "reply", id: "reply", clarification: s.question.id, text: "Work"}); await s.p.next(result("reply"));
    const first = (await s.get(`/api/requests/${s.question.userEventId}`)).item;
    expect(first.parts[0].task.title).toBe("General · Sat 10 Oct");
    s.p.send({type: "send", id: "today", text: "What did the terminal test show?", to: "main", chat: {goal: first.parts[0].goal.number, task: first.parts[0].task.number}});
    await s.p.next(result("today"));
    const recent = await s.get("/api/history?conversation=main");
    expect(recent.items[0].parts[0].task.title).toBe("General · Sun 11 Oct");
    expect(JSON.stringify(s.agent.requests.at(-1)!.messages)).toContain(`Finished: ${original}`);
  });
  it("queues a clarification reply behind active Flow work and before a later Standard send", async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => {release = resolve;});
    const s = await setup({hold});
    s.p.send({type: "send", id: "hold", text: "Hold main", to: "main"});
    await expect.poll(() => s.agent.requests.some(r => messageOf(r) === "Hold main")).toBe(true);
    s.p.send({type: "reply", id: "reply", clarification: s.question.id, text: "Work"});
    await s.p.next(m => m.type === "state" && m.queue.some((q: any) => q.replyTo === s.question.id));
    const day = s.rt.store.ensureGeneral("Europe/Vienna");
    s.p.send({type: "queue", id: "later", text: "A later Standard request", chat: {goal: day.goal.number, task: day.task.number}});
    await s.p.next(m => m.type === "state" && m.queue.some((q: any) => q.id === "later"));
    release();
    for (const id of ["hold", "reply", "later"]) await s.p.next(result(id));
    expect(s.agent.requests.map(messageOf)).toEqual(["Hold main", original, "A later Standard request"]);
    expect(JSON.stringify(s.agent.requests.at(-1)!.messages)).toContain(`Finished: ${original}`);
  });

  it("restores a pending question after a real runtime restart and resumes the original request", async () => {
    const s = await setup();
    await s.app.close(); await s.rt.close();
    const reopened = await runtime(s.rt.config, {clock: s.clock, makeModel: (_p, model) => model === "router" ? s.router : s.agent});
    expect(reopened.rt.store.clarification(s.question.id).state).toBe("pending");
    const answer = await reopened.rt.socrates!.handle("Work", {replyTo: s.question.id});
    if (answer.kind !== "answered") throw new Error("Expected answer");
    expect(reopened.rt.store.requestForTurn(answer.parts[0]!.turn.id).request).toBe(original);
  });

});
