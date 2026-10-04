import { describe, expect, it } from "vitest";
import { continueTask, createGoal, decision } from "../../../packages/router/test/helpers";
import { call, final } from "../../../packages/agent/test/helpers";
import { Responder, liveServer, tempDir } from "./helpers";

/** A promise the test opens when it wants a run to continue. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((done) => (open = done));
  return { open, opened };
}

const general = () => ({ text: decision({ decision: "resume_existing", goal_label: "general", workspace_confidence: null }) });
const isResult = (id: string) => (m: Record<string, any>) => m.type === "result" && m.id === id;

describe("the live connection", () => {
  it("needs the session and this server's own origin", async () => {
    const { page, port, token, app } = await liveServer(new Responder("r", () => general()), new Responder("a", () => final()));
    await expect(page({})).rejects.toThrow("refused 401");
    await expect(page({ authorization: `Bearer ${token}`, origin: "http://evil.example" })).rejects.toThrow("refused 403");
    await expect(page({ cookie: `socrates_v2_session=${token}`, origin: `http://127.0.0.1:${port}` })).resolves.toBeDefined();
    // A refused upgrade closes its connection, so the server can still shut down promptly.
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("streams a message's activity and result, and lets a reconnecting page catch up exactly", async () => {
    const { page, rt } = await liveServer(new Responder("r", () => createGoal("Shop", "Fix checkout")), new Responder("a", () => final({ full_answer: "Checkout fixed." })));
    const p = await page();
    p.send({ type: "hello" });
    const first = await p.next((m) => m.type === "state");
    expect(first).toMatchObject({ ready: true, busy: false, queue: [], approvals: [], lanes: [] });

    p.send({ type: "send", id: "m1", text: "Fix the checkout.", to: "main" });
    expect(await p.next((m) => m.type === "accepted")).toEqual({ type: "accepted", id: "m1", conversation: "main" });
    const result = await p.next(isResult("m1"));
    expect(result).toMatchObject({ conversation: "main", result: { kind: "answered", text: "Checkout fixed.", laneId: null, notices: [], parts: [{ order: 1, status: "completed", task: "Fix checkout", laneId: null }] } });
    const kinds = p.received.filter((m) => m.type === "activity").map((m) => `${m.kind}:${m.conversation}`);
    expect(kinds).toEqual(expect.arrayContaining(["message:main", "routed:main", "answer:main", "finished:main", "ledger:main"]));
    const routed = p.received.find((m) => m.kind === "routed")!;
    expect(routed).toMatchObject({ goal: { number: 1, title: "Shop" }, task: { number: 1, title: "Fix checkout" }, lane: null });

    // A second page that knew everything up to the routing step catches up from there, and only from there.
    const later = await page();
    later.send({ type: "hello", after: routed.seq });
    await later.next((m) => m.type === "state");
    const replay = await later.next((m) => m.type === "activity" && m.kind === "finished");
    expect(replay.seq).toBeGreaterThan(routed.seq as number);
    expect(later.received.some((m) => m.type === "activity" && (m.seq as number) <= (routed.seq as number))).toBe(false);
    expect((await later.next((m) => m.type === "state")) ?? null).toBeDefined;
    expect(rt.store.latestEventSeq()).toBeGreaterThan(routed.seq as number);
  });

  it("asks a page that is too far behind to reload its history", async () => {
    const { page } = await liveServer(new Responder("r", () => general()), new Responder("a", () => final()), { replayMax: 2 });
    const p = await page();
    p.send({ type: "send", id: "m1", text: "Hello.", to: "main" });
    await p.next(isResult("m1"));
    p.send({ type: "hello", after: 0 });
    expect(await p.next((m) => m.type === "reset")).toMatchObject({ seq: expect.any(Number) });
  });

  it("refuses main while it works, queues for it, and runs the queue as soon as main is free", async () => {
    const hold = gate();
    const agent = new Responder("a", async (m) => {
      if (m === "Run the slow suite.") await hold.opened;
      return final({ full_answer: `Done: ${m}` });
    });
    const { page } = await liveServer(new Responder("r", (m) => (m.startsWith("Run") ? createGoal("Server", "Run tests") : general())), agent);
    const p = await page();
    p.send({ type: "send", id: "slow", text: "Run the slow suite.", to: "main" });
    await p.next((m) => m.type === "state" && m.busy);

    p.send({ type: "send", id: "early", text: "What is 2 + 2?", to: "main" });
    expect(await p.next((m) => m.type === "error" && m.id === "early")).toMatchObject({ code: "main_busy" });

    p.send({ type: "queue", id: "q1", text: "What is 2 + 2?" });
    p.send({ type: "queue", id: "q2", text: "Draft a greeting." });
    p.send({ type: "queue", id: "q3", text: "Forget this one." });
    p.send({ type: "queue_edit", id: "q2", text: "Draft a short greeting." });
    p.send({ type: "queue_remove", id: "q3" });
    const queued = await p.next((m) => m.type === "state" && m.queue.length === 2 && m.queue[1].text === "Draft a short greeting.");
    expect(queued.queue).toEqual([{ id: "q1", text: "What is 2 + 2?" }, { id: "q2", text: "Draft a short greeting." }]);
    p.send({ type: "queue_remove", id: "missing" });
    expect(await p.next((m) => m.type === "error" && m.code === "not_found")).toBeDefined();

    hold.open();
    expect((await p.next(isResult("slow"))).result.text).toBe("Done: Run the slow suite.");
    expect((await p.next(isResult("q1"))).result.text).toBe("Done: What is 2 + 2?");
    expect((await p.next(isResult("q2"))).result.text).toBe("Done: Draft a short greeting.");
    expect(await p.next((m) => m.type === "state" && !m.busy && m.queue.length === 0)).toBeDefined();
  });

  it("runs a lane beside main, tags its activity with the lane, and moves a queued message into a lane", async () => {
    const hold = gate();
    const agent = new Responder("a", async (m) => {
      if (m === "Run the slow suite.") await hold.opened;
      return final({ full_answer: `Done: ${m}` });
    });
    const router = new Responder("r", (m) => (m.startsWith("Run") ? createGoal("Server", "Run tests") : createGoal(m.slice(0, 20), m.slice(0, 20))));
    const { page } = await liveServer(router, agent);
    const p = await page();
    p.send({ type: "send", id: "slow", text: "Run the slow suite.", to: "main" });
    await p.next((m) => m.type === "state" && m.busy);
    p.send({ type: "send", id: "docs", text: "Write the docs.", to: "new_lane" });
    const accepted = await p.next((m) => m.type === "accepted" && m.id === "docs");
    const lane = accepted.conversation as string;
    const result = await p.next(isResult("docs"));
    expect(result).toMatchObject({ conversation: lane, result: { laneId: lane, notices: ["Lane 1 finished: Write the docs. — Done: Write the docs."] } });
    expect(p.received.filter((m) => m.type === "activity" && m.conversation === lane).map((m) => m.kind)).toEqual(expect.arrayContaining(["lane", "message", "routed", "answer", "finished"]));

    p.send({ type: "queue", id: "q1", text: "Plan the garden." });
    p.send({ type: "queue_to_lane", id: "q1" });
    const moved = await p.next((m) => m.type === "accepted" && m.id === "q1");
    expect(moved.conversation).not.toBe(lane);
    expect((await p.next(isResult("q1"))).result.text).toBe("Done: Plan the garden.");
    hold.open();
    await p.next(isResult("slow"));
  });

  it("puts an approval in the panel that asked; an answer, or stopping the run, settles it", async () => {
    const folder = tempDir();
    const steps = new Map<string, number>();
    const agent = new Responder("a", (m) => {
      const n = steps.get(m) ?? 0;
      steps.set(m, n + 1);
      return n === 0 ? { toolCalls: [call("terminal", { command: "echo approved-run", timeout_ms: 0 })] } : final({ full_answer: `Done: ${m}` });
    });
    const { page, rt } = await liveServer(new Responder("r", (m) => createGoal(m.slice(0, 20), m.slice(0, 20))), agent);
    const workspace = rt.store.createWorkspace("project", folder);
    await rt.updateSettings({ workingFolder: workspace.id });
    const p = await page();

    p.send({ type: "send", id: "a1", text: "Run it with no deadline.", to: "new_lane" });
    const asked = await p.next((m) => m.type === "approval");
    const lane = (await p.next((m) => m.type === "accepted" && m.id === "a1")).conversation;
    expect(asked).toMatchObject({ conversation: lane, lane: 1, kind: "no_deadline", tool: "terminal", detail: "Run without a deadline: echo approved-run", task: "g1/t1 Run it with no deadl" });
    expect(await p.next((m) => m.type === "state" && m.approvals.length === 1 && m.lanes[0]?.waitingForApproval)).toBeDefined();
    p.send({ type: "approve", approval: asked.id, granted: true });
    const finished = await p.next((m) => m.type === "activity" && m.kind === "tool_finished");
    expect(finished).toMatchObject({ conversation: lane, status: "ok", handle: "e1", task: "g1/t1" });
    expect(finished.preview).toContain("approved-run");
    await p.next(isResult("a1"));
    p.send({ type: "approve", approval: asked.id, granted: true });
    expect(await p.next((m) => m.type === "error" && m.code === "not_found")).toBeDefined();

    // Stopping a run that waits for approval refuses it, and the turn ends interrupted.
    p.send({ type: "send", id: "a2", text: "Run another with no deadline.", to: "main" });
    await p.next((m) => m.type === "approval" && m.conversation === "main");
    p.send({ type: "cancel", conversation: "main" });
    const stopped = await p.next(isResult("a2"));
    expect(stopped.result.parts[0].status).toBe("interrupted");
    expect(await p.next((m) => m.type === "state" && m.approvals.length === 0 && !m.busy)).toBeDefined();
    p.send({ type: "cancel", conversation: "main" });
    expect(await p.next((m) => m.type === "error" && m.code === "not_running")).toBeDefined();
  });

  it("tells every page when main hands a message to the lane busy with its task, and frees main", async () => {
    const hold = gate();
    const agent = new Responder("a", async (m) => {
      if (m === "Refactor the server.") await hold.opened;
      return final({ full_answer: `Done: ${m}` });
    });
    const { page } = await liveServer(new Responder("r", (m) => (m === "Start the server work." ? createGoal("Server", "Refactor") : m === "Hello." ? general() : continueTask())), agent);
    const p = await page();
    p.send({ type: "send", id: "m0", text: "Start the server work.", to: "main" });
    await p.next(isResult("m0"));
    p.send({ type: "send", id: "lane", text: "Refactor the server.", to: "new_lane" });
    const lane = (await p.next((m) => m.type === "accepted" && m.id === "lane")).conversation;
    await p.next((m) => m.type === "activity" && m.kind === "routed" && m.conversation === lane);
    p.send({ type: "send", id: "more", text: "Also rename the config.", to: "main" });
    expect(await p.next((m) => m.type === "handed_off")).toEqual({ type: "handed_off", id: "more", conversation: lane, lane: 1 });
    expect(await p.next((m) => m.type === "activity" && m.kind === "handed_off")).toMatchObject({ conversation: "main", lane: 1 });
    p.send({ type: "send", id: "hi", text: "Hello.", to: "main" });
    expect((await p.next(isResult("hi"))).result.text).toBe("Done: Hello.");
    hold.open();
    expect(await p.next(isResult("more"))).toMatchObject({ conversation: lane, result: { notices: [expect.stringMatching(/^Lane 1 finished: /)] } });
  });

  it("answers bad commands, unknown lanes, and setup-needed with clear errors", async () => {
    const { page } = await liveServer(new Responder("r", () => general()), new Responder("a", () => final()), { settings: {} });
    const p = await page();
    p.send({ type: "send", id: "x", text: "Hi.", to: "main" });
    expect(await p.next((m) => m.type === "error")).toMatchObject({ id: "x", code: "setup_needed", message: expect.stringContaining("Add an API key") });
    (p as unknown as { send: (c: unknown) => void }).send("not json" as never);
    expect(await p.next((m) => m.type === "error" && m.code === "invalid_command")).toBeDefined();
    p.send({ type: "send", id: "bad id!", text: "x", to: "main" });
    expect(await p.next((m) => m.type === "error" && m.code === "invalid_command")).toMatchObject({ message: expect.stringContaining("id") });
  });

  it("returns a tool call's complete output, and stopping the server cancels running work", async () => {
    const hold = gate();
    const steps = new Map<string, number>();
    const agent = new Responder("a", async (m) => {
      const n = steps.get(m) ?? 0;
      steps.set(m, n + 1);
      if (m === "Wait forever.") await hold.opened;
      return n === 0 && m === "Read it." ? { toolCalls: [call("context_retrieve", { action: "ledger_search", target: "all_goals" })] } : final({ full_answer: "ok" });
    });
    const { page, app, rt, token, port } = await liveServer(new Responder("r", (m) => createGoal(m.slice(0, 20), m.slice(0, 20))), agent);
    const p = await page();
    p.send({ type: "send", id: "r1", text: "Read it.", to: "main" });
    const finished = await p.next((m) => m.type === "activity" && m.kind === "tool_finished");
    await p.next(isResult("r1"));
    const evidence = await app.inject({ method: "GET", url: `/api/evidence?task=${finished.task}&handle=${finished.handle}`, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } });
    expect(evidence.json()).toMatchObject({ task: finished.task, handle: "e1", tool: "context_retrieve", status: finished.status, truncated: false });
    expect(evidence.json().content.startsWith(finished.preview)).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/evidence?task=g9/t9&handle=e1", headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } })).statusCode).toBe(404);

    p.send({ type: "send", id: "w1", text: "Wait forever.", to: "main" });
    await p.next((m) => m.type === "state" && m.busy);
    await app.close();
    const turns = rt.store.listEvents({ type: "turn_interrupted" });
    expect(turns.at(-1)?.payload).toMatchObject({ reason: "cancelled" });
    hold.open();
  });
});
