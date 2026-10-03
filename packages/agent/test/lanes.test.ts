import type { ModelClient, ModelRequest, ModelResponse } from "@socrates/contracts";
import { abortable, countTokens } from "@socrates/shared";
import { laneSummaries } from "@socrates/router";
import { LedgerStore } from "@socrates/store";
import type { ApprovalOrigin, ApprovalRequest } from "@socrates/tools";
import { describe, expect, it } from "vitest";
import { continueTask, createGoal, createTask, decision, defineTask } from "../../router/test/helpers";
import { LANES_MAX_TOKENS, lanesBlock, MAX_RUNNING_LANES, Socrates, type SocratesOptions } from "../src";
import { call, contextText, final, world } from "./helpers";

type Out = { text: string } | { toolCalls: { name: string; input: unknown }[] };

/** The exact user message a router or agent request is about. */
const messageOf = (request: ModelRequest) => /<CURRENT_USER_MESSAGE>\n([\s\S]*?)\n<\/CURRENT_USER_MESSAGE>/.exec(contextText(request))?.[1]?.split("\n")[0] ?? "";

/** A model that answers by message, so runs that overlap get their own answers in any order. */
class Responder implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private calls = 0;
  constructor(readonly id: string, private readonly respond: (message: string, request: ModelRequest) => Out | Promise<Out>) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const answer = Promise.resolve(this.respond(messageOf(request), request));
    const out = request.signal ? await abortable(answer, request.signal) : await answer;
    const toolCalls = "toolCalls" in out ? out.toolCalls.map((c) => ({ ...c, id: `call_${++this.calls}` })) : [];
    return { text: "text" in out ? out.text : "", toolCalls, stopReason: toolCalls.length ? "tool_use" : "end", usage: { promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}

/** A promise the test opens when it wants a run to continue. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((done) => (open = done));
  return { open, opened };
}

function socrates(store: LedgerStore, router: Responder, agent: Responder, options: Partial<SocratesOptions> = {}) {
  return new Socrates({ store, model: agent, routerModel: router, timeZone: "UTC", approve: async () => true, retryDelaysMs: [0, 0], ...options });
}

const settled = async (p: Promise<unknown>) => (await Promise.race([p.then(() => true, () => true), new Promise((done) => setTimeout(() => done(false), 30))])) as boolean;

describe("lanes", () => {
  it("a lane works alongside the main conversation and never changes what main's current task is", async () => {
    const w = await world();
    const slow = gate();
    const router = new Responder("test:router", (m) => (m.startsWith("Start the docs") ? createGoal("Docs site", "Set up the docs site") : continueTask()));
    const agent = new Responder("test:agent", async (m) => {
      if (m === "Run the slow suite.") await slow.opened;
      return final({ full_answer: `Done: ${m}` });
    });
    const s = socrates(w.store, router, agent);
    let opened: string | null = null;
    const main = s.handle("Run the slow suite.");
    const lane = await s.handle("Start the docs site.", { lane: "new", onLane: (id) => (opened = id) });

    expect(lane).toMatchObject({ kind: "answered", text: "Done: Start the docs site.", laneId: opened });
    expect(await settled(main)).toBe(false);
    expect(s.busy).toBe(true);
    const laneTurn = lane.kind === "answered" ? lane.parts[0]!.turn : null;
    expect(laneTurn?.laneId).toBe(opened);
    // The lane's newer turn is the lane's current work; main's current is still main's task.
    expect(w.store.currentBinding()!.task.id).toBe(w.taskId);
    expect(w.store.currentBinding(opened)!.task.title).toBe("Set up the docs site");
    expect(s.lanes()).toEqual([expect.objectContaining({ id: opened, number: 1, running: false })]);

    slow.open();
    expect(await main).toMatchObject({ kind: "answered", text: "Done: Run the slow suite.", laneId: null });
    expect(s.busy).toBe(false);
    await s.close();
  });

  it("a lane's later messages continue its task directly, and main routing never sees the lane's turns as its own", async () => {
    const w = await world();
    const router = new Responder("test:router", (m) => (m.startsWith("Open project X") ? createGoal("Project X", "Bootstrap project X") : continueTask()));
    const agent = new Responder("test:agent", (m) => final({ full_answer: `Done: ${m}` }));
    const s = socrates(w.store, router, agent);
    const first = await s.handle("Open project X and scaffold it.", { lane: "new" });
    const laneId = first.laneId!;
    const routed = router.requests.length;
    const second = await s.handle("Also add a README.", { lane: laneId });
    expect(router.requests.length).toBe(routed);
    expect(second.kind === "answered" && second.parts[0]!.task.title).toBe("Bootstrap project X");
    // The lane's own history is in its context.
    expect(contextText(agent.requests.at(-1)!)).toContain("Open project X and scaffold it.");

    await s.handle("How is the server work going?");
    const mainRouting = contextText(router.requests.at(-1)!);
    expect(mainRouting).not.toContain("Also add a README.");
    expect(mainRouting).toMatch(/<KNOWN_GOALS>\nCURRENT\nlabel: current\ntitle: Project work/);
    await s.close();
  });

  it("a main message for a task busy in a lane is handed to that lane, and main is free at once", async () => {
    const w = await world();
    const hold = gate();
    const router = new Responder("test:router", (m) => (m === "Hello there." ? { text: decision({ decision: "resume_existing", goal_label: "general", workspace_confidence: null }) } : continueTask()));
    const agent = new Responder("test:agent", async (m) => {
      if (m === "Refactor the server.") await hold.opened;
      return final({ full_answer: `Done: ${m}` });
    });
    const s = socrates(w.store, router, agent);
    // The lane continues main's current task.
    const lane = s.handle("Refactor the server.", { lane: "new" });
    await new Promise((done) => setTimeout(done, 10));
    const laneId = s.lanes()[0]!.id;

    let handedTo: string | null = null;
    const handed = s.handle("Also update the README.", { onHandoff: (id) => (handedTo = id) });
    await new Promise((done) => setTimeout(done, 10));
    expect(handedTo).toBe(laneId);
    expect(s.busy).toBe(false);
    // Main takes another message while the handed-off one waits for the lane.
    expect(await s.handle("Hello there.")).toMatchObject({ kind: "answered", text: "Done: Hello there.", laneId: null });
    expect(await settled(handed)).toBe(false);

    hold.open();
    await lane;
    const result = await handed;
    expect(result.kind === "answered" && result.parts[0]!.turn.laneId).toBe(laneId);
    // It ran after the lane's turn, with that turn in its history.
    const request = agent.requests.find((r) => messageOf(r) === "Also update the README.")!;
    expect(contextText(request)).toContain("Refactor the server.");
    // The lane's agent knows it is that lane, and that this message came from main.
    expect(contextText(request)).toContain(`lane: you are lane 1, working this task beside the main conversation. The user wrote this message in the main conversation; it was handed to you because you work this task.`);
    expect(contextText(agent.requests.find((r) => messageOf(r) === "Refactor the server.")!)).toMatch(/lane: you are lane 1, working this task beside the main conversation\.\n/);
    expect(contextText(agent.requests.find((r) => messageOf(r) === "Hello there.")!)).not.toContain("lane: you are");
    expect(w.store.listEvents({ type: "turn_moved_to_lane" })).toHaveLength(1);
    await s.close();
  });

  it("approvals reach the run that asked, labelled with its lane", async () => {
    const w = await world();
    const router = new Responder("test:router", (m) => (m.startsWith("Lane") ? createGoal("Lane work", "Lane task") : continueTask()));
    const steps = new Map<string, number>();
    const agent = new Responder("test:agent", (m) => {
      const n = steps.get(m) ?? 0;
      steps.set(m, n + 1);
      return n === 0 ? { toolCalls: [call("terminal", { command: "echo hi", timeout_ms: 0 })] } : final({ full_answer: "ok" });
    });
    const s = socrates(w.store, router, agent, { resolveWorkspace: () => ({ name: "project", rootPath: w.root }) });
    const asked: { who: string; request: ApprovalRequest; origin?: ApprovalOrigin }[] = [];
    const approve = (who: string) => async (request: ApprovalRequest, origin?: ApprovalOrigin) => (asked.push({ who, request, ...(origin ? { origin } : {}) }), false);
    const [main, lane] = await Promise.all([
      s.handle("Main work.", { approve: approve("main") }),
      s.handle("Lane work.", { lane: "new", approve: approve("lane") }),
    ]);
    expect(asked.map((a) => a.who).sort()).toEqual(["lane", "main"]);
    expect(asked.find((a) => a.who === "main")!.origin).toMatchObject({ laneId: null, turnId: main.kind === "answered" ? main.parts[0]!.turn.id : "" });
    expect(asked.find((a) => a.who === "lane")!.origin).toMatchObject({ laneId: lane.laneId, taskId: lane.kind === "answered" ? lane.parts[0]!.task.id : "" });
    expect(asked.every((a) => a.request.kind === "no_deadline")).toBe(true);
    await s.close();
  });

  it("stopping one lane leaves the others running", async () => {
    const w = await world();
    const hold = gate();
    const router = new Responder("test:router", (m) => createGoal(m.slice(0, 20), m.slice(0, 20)));
    const agent = new Responder("test:agent", async (m) => {
      await hold.opened;
      return final({ full_answer: `Done: ${m}` });
    });
    const s = socrates(w.store, router, agent);
    const stop = new AbortController();
    const a = s.handle("Lane A work.", { lane: "new", signal: stop.signal });
    const b = s.handle("Lane B work.", { lane: "new" });
    await new Promise((done) => setTimeout(done, 10));
    stop.abort();
    const stopped = await a;
    expect(stopped.kind === "answered" && stopped.parts[0]!.status).toBe("interrupted");
    expect(await settled(b)).toBe(false);
    hold.open();
    expect(await b).toMatchObject({ kind: "answered", text: "Done: Lane B work." });
    await s.close();
  });

  it(`refuses a lane beyond ${MAX_RUNNING_LANES} running ones before recording anything, but queues more work for a running lane`, async () => {
    const w = await world();
    const hold = gate();
    const router = new Responder("test:router", (m) => createGoal(m.slice(0, 20), m.slice(0, 20)));
    const agent = new Responder("test:agent", async (m) => {
      if (m.startsWith("Lane")) await hold.opened;
      return final({ full_answer: `Done: ${m}` });
    });
    const s = socrates(w.store, router, agent);
    const runs = Array.from({ length: MAX_RUNNING_LANES }, (_, i) => s.handle(`Lane ${i + 1} work.`, { lane: "new" }));
    await new Promise((done) => setTimeout(done, 10));
    const events = w.store.latestEventSeq();
    await expect(s.handle("One lane too many.", { lane: "new" })).rejects.toMatchObject({ name: "SocratesBusyError", reason: "lane_limit" });
    expect(w.store.latestEventSeq()).toBe(events);
    expect(w.store.listLanes()).toHaveLength(MAX_RUNNING_LANES);

    // More work for a running lane waits for its task instead.
    const firstLane = s.lanes()[0]!.id;
    const queued = s.handle("Then add tests.", { lane: firstLane });
    expect(await settled(queued)).toBe(false);
    expect(() => s.closeLane(firstLane)).toThrow(expect.objectContaining({ reason: "lane_running" }));
    hold.open();
    await Promise.all(runs);
    expect(await queued).toMatchObject({ kind: "answered", text: "Done: Then add tests.", laneId: firstLane });
    await s.close();
  });

  it("asks and answers a routing clarification inside the lane, without touching main", async () => {
    const w = await world();
    const router = new Responder("test:router", (m, request) => {
      if (m === "Open the other project.") return { toolCalls: [{ name: "ask_user", input: { question: "Which project?", candidates: [{ label: "Project work", detail: "The server work", goal_label: "current" }], allow_new: true } }] };
      if (contextText(request).includes("<ROUTING_NOTE>")) return createGoal("Website", "Build the website");
      return continueTask();
    });
    const agent = new Responder("test:agent", (m) => final({ full_answer: `Done: ${m}` }));
    const s = socrates(w.store, router, agent);
    const asked = await s.handle("Open the other project.", { lane: "new" });
    expect(asked).toMatchObject({ kind: "clarify", laneId: expect.any(String) });
    expect(w.store.pendingClarification()).toBeNull();
    expect(w.store.pendingClarification(asked.laneId)).not.toBeNull();

    // Main carries on with its own task.
    await s.handle("Keep going on the server.");
    expect(contextText(router.requests.at(-1)!)).not.toContain("<ROUTING_NOTE>");

    const answered = await s.handle("A new website.", { lane: asked.laneId! });
    expect(answered.kind === "answered" && answered.parts[0]!.task.title).toBe("Build the website");
    expect(answered.kind === "answered" && answered.parts[0]!.turn.laneId).toBe(asked.laneId);
    await s.close();
  });

  it("runs a compound message's parts in order inside its lane", async () => {
    const w = await world();
    const part = (order: number, extra: object) => ({ order, request: order === 1 ? "Fix the server" : "write the docs", goal_label: "current", new_goal_title: null, task_label: null, new_task_title: null, workspace_confidence: "high", reason: "r", depends_on: order === 2 ? [1] : [], ...extra });
    const router = new Responder("test:router", () => ({
      text: decision({
        decision: "compound",
        workspace_confidence: null,
        parts: [
          part(1, { decision: "continue_current", task_decision: "continue_task", task_label: "current" }),
          part(2, { decision: "continue_current", task_decision: "create_task", new_task_title: "Write the docs", ...defineTask("Write the docs") }),
        ] as never,
      }),
    }));
    const agent = new Responder("test:agent", () => final({ full_answer: "ok" }));
    const s = socrates(w.store, router, agent);
    const result = await s.handle("Fix the server, then write the docs.", { lane: "new" });
    expect(result.kind === "answered" && result.parts.map((p) => [p.order, p.task.title, p.turn.laneId])).toEqual([[1, "Fix the server", result.laneId], [2, "Write the docs", result.laneId]]);
    await s.close();
  });

  it("lanes survive a restart and an event-only rebuild; a closed lane takes no more messages", async () => {
    const w = await world();
    const router = new Responder("test:router", () => createTask("Lane task"));
    const agent = new Responder("test:agent", () => final());
    const s = socrates(w.store, router, agent);
    const lane = await s.handle("Lane work.", { lane: "new" });
    const handed = await s.handle("Main work.");
    await s.close();

    const rebuilt = LedgerStore.open({ path: ":memory:", clock: w.clock });
    rebuilt.restoreEvents(w.store.listEvents());
    for (const store of [w.store, rebuilt]) {
      const again = socrates(store, router, agent);
      expect(again.lanes()).toEqual([expect.objectContaining({ id: lane.laneId, number: 1, running: false })]);
      expect(store.currentBinding(lane.laneId)!.task.title).toBe("Lane task");
      expect(store.currentBinding()!.task.id).toBe(handed.kind === "answered" ? handed.parts[0]!.task.id : "");
      await again.close();
    }
    const after = socrates(w.store, router, agent);
    after.closeLane(lane.laneId!);
    expect(after.lanes()).toEqual([]);
    await expect(after.handle("More.", { lane: lane.laneId! })).rejects.toMatchObject({ reason: "lane_closed" });
    await after.close();
    rebuilt.close();
  });
});


describe("L1 lifecycle regressions", () => {
  it("serializes messages arriving before a new lane finishes routing", async () => {
    const w = await world();
    const started = gate(), route = gate();
    const router = new Responder("router", async () => { started.open(); await route.opened; return createTask("Lane task"); });
    const agent = new Responder("agent", (m) => final({ full_answer: m }));
    const s = socrates(w.store, router, agent);
    let id = "";
    const first = s.handle("First", { lane: "new", onLane: (lane) => { id = lane; } });
    await started.opened;
    const second = s.handle("Second", { lane: id });
    expect(await settled(second)).toBe(false);
    expect(router.requests).toHaveLength(1);
    expect(w.store.listEvents({ type: "user_message" }).filter((e) => (e.payload as { text: string }).text === "Second")).toHaveLength(1);
    route.open();
    const [a, b] = await Promise.all([first, second]);
    expect(router.requests).toHaveLength(1);
    expect(a.kind === "answered" && b.kind === "answered" && a.parts[0]!.task.id === b.parts[0]!.task.id).toBe(true);
    expect(contextText(agent.requests[1]!)).toContain("First");
    await s.close();
  });

  it("cancelling a task waiter does not let another lane overlap its predecessor", async () => {
    const w = await world();
    const started = gate(), hold = gate();
    const agent = new Responder("agent", async (m) => {
      if (m === "First") { started.open(); await hold.opened; }
      return final({ full_answer: m });
    });
    const s = socrates(w.store, new Responder("router", () => continueTask()), agent);
    const first = s.handle("First", { lane: "new" });
    await started.opened;
    const controller = new AbortController();
    const second = s.handle("Second", { lane: "new", signal: controller.signal });
    expect(await settled(second)).toBe(false);
    controller.abort();
    expect(await second).toMatchObject({ kind: "answered", parts: [expect.objectContaining({ status: "interrupted" })] });
    const third = s.handle("Third", { lane: "new" });
    expect(await settled(third)).toBe(false);
    expect(agent.requests.map(messageOf)).toEqual(["First"]);
    hold.open();
    await Promise.all([first, third]);
    await s.close();
  });

  it("releases lane reservations when lifecycle callbacks throw", async () => {
    const w = await world();
    const started = gate(), hold = gate();
    const s = socrates(w.store, new Responder("router", () => continueTask()), new Responder("agent", async (m) => {
      if (m === "First") { started.open(); await hold.opened; }
      return final();
    }));
    await expect(s.handle("Rejected", { lane: "new", onLane() { throw new Error("UI failed"); } })).rejects.toThrow("UI failed");
    expect(s.lanes()[0]!.running).toBe(false);
    s.closeLane(s.lanes()[0]!.id);
    const first = s.handle("First", { lane: "new" });
    await started.opened;
    expect(await s.handle("Handed", { onHandoff() { throw new Error("UI failed"); } })).toMatchObject({ kind: "answered", parts: [expect.objectContaining({ status: "interrupted" })] });
    hold.open();
    await first;
    expect(s.lanes().every((lane) => !lane.running)).toBe(true);
    s.closeLane(s.lanes()[0]!.id);
    await s.close();
  });

  it("close cancels even a router provider that ignores its signal", async () => {
    const w = await world();
    const started = gate();
    const router: ModelClient = { id: "uncooperative", complete() { started.open(); return new Promise(() => {}); } };
    const s = new Socrates({ store: w.store, model: new Responder("agent", () => final()), routerModel: router, timeZone: "UTC", approve: async () => true });
    const run = s.handle("Work", { lane: "new" }).catch(() => null);
    await started.opened;
    await s.close();
    await run;
    expect(s.lanes()[0]!.running).toBe(false);
    expect(w.store.listEvents({ type: "turn_bound" })).toHaveLength(1); // Only world's seed.
  });

  it("an already-cancelled message records no lane or user message", async () => {
    const w = await world();
    const s = socrates(w.store, new Responder("router", () => continueTask()), new Responder("agent", () => final()));
    const before = w.store.latestEventSeq();
    await expect(s.handle("Work", { lane: "new", signal: AbortSignal.abort() })).rejects.toBeDefined();
    expect(w.store.latestEventSeq()).toBe(before);
    await s.close();
  });
});


it("a handoff waits behind the lane's queued follow-up without deadlocking", async () => {
  const w = await world();
  const started = gate(), hold = gate();
  const agent = new Responder("agent", async (m) => {
    if (m === "First") { started.open(); await hold.opened; }
    return final({ full_answer: m });
  });
  const s = socrates(w.store, new Responder("router", () => continueTask()), agent);
  const first = s.handle("First", { lane: "new" });
  await started.opened;
  const second = s.handle("Second", { lane: s.lanes()[0]!.id });
  const third = s.handle("Third");
  expect(await settled(third)).toBe(false);
  expect(s.busy).toBe(false);
  hold.open();
  await Promise.all([first, second, third]);
  expect(agent.requests.map(messageOf)).toEqual(["First", "Second", "Third"]);
  await s.close();
});


it("cancels queued lane work promptly while retaining its single recorded message", async () => {
  const w = await world();
  const started = gate(), hold = gate();
  const agent = new Responder("agent", async (m) => {
    if (m === "First") { started.open(); await hold.opened; }
    return final();
  });
  const s = socrates(w.store, new Responder("router", () => continueTask()), agent);
  const first = s.handle("First", { lane: "new" });
  await started.opened;
  const stop = new AbortController();
  const queued = s.handle("Queued", { lane: s.lanes()[0]!.id, signal: stop.signal });
  const rejected = expect(queued).rejects.toBeDefined();
  stop.abort();
  await rejected;
  expect(agent.requests.map(messageOf)).toEqual(["First"]);
  expect(w.store.listEvents({ type: "user_message" }).filter((e) => (e.payload as { text: string }).text === "Queued")).toHaveLength(1);
  hold.open(); await first; await s.close();
});

it("a cancelled waiter does not redirect handoffs into its now-closed lane", async () => {
  const w = await world();
  const started = gate(), hold = gate(), handed = gate();
  const s = socrates(w.store, new Responder("router", () => continueTask()), new Responder("agent", async (m) => {
    if (m === "First") { started.open(); await hold.opened; }
    return final();
  }));
  const first = s.handle("First", { lane: "new" });
  await started.opened;
  const owner = s.lanes()[0]!.id;
  const stop = new AbortController();
  const waiting = s.handle("Wait", { lane: "new", signal: stop.signal });
  expect(await settled(waiting)).toBe(false);
  stop.abort();
  const cancelled = await waiting;
  s.closeLane(cancelled.laneId!);
  let destination = "";
  const main = s.handle("Main", { onHandoff(id) { destination = id; handed.open(); } });
  await handed.opened;
  expect(destination).toBe(owner);
  hold.open();
  await Promise.all([first, main]);
  await s.close();
});

it("retains main's reservation while a compound message still has main work", async () => {
  const w = await world();
  const started = gate(), hold = gate(), handed = gate();
  const text = "Fix the server, then write the docs.";
  const part = (order: number, extra: object) => ({ order, request: order === 1 ? "Fix the server" : "write the docs", goal_label: "current", new_goal_title: null, task_label: null, new_task_title: null, workspace_confidence: "high", reason: "r", depends_on: order === 2 ? [1] : [], ...extra });
  const router = new Responder("router", (m) => m === text ? { text: decision({ decision: "compound", workspace_confidence: null, parts: [
    part(1, { decision: "continue_current", task_decision: "continue_task", task_label: "current" }),
    part(2, { decision: "continue_current", task_decision: "create_task", new_task_title: "Write the docs", ...defineTask("Write the docs") }),
  ] as never }) } : continueTask());
  const agent = new Responder("agent", async (m) => {
    if (m === "First") { started.open(); await hold.opened; }
    return final();
  });
  const s = socrates(w.store, router, agent);
  const first = s.handle("First", { lane: "new" });
  await started.opened;
  const main = s.handle(text, { onHandoff() { handed.open(); } });
  await handed.opened;
  expect(s.busy).toBe(true);
  await expect(s.handle("Another main message")).rejects.toMatchObject({ reason: "main_busy" });
  hold.open();
  await first;
  const result = await main;
  expect(result.kind === "answered" && result.parts.map((p) => p.status)).toEqual(["completed", "completed"]);
  expect(s.busy).toBe(false);
  await s.close();
});

describe("the main conversation sees its lanes", () => {
  it("<LANES> shows each lane's status, task, latest step, note and answer, in main only", async () => {
    const w = await world({ files: { "a.txt": "alpha\n" } });
    const reading = gate();
    const approving = gate();
    const router = new Responder("test:router", (m) => (m.startsWith("Read") ? createGoal("Reading", "Read a.txt") : m.startsWith("Run") ? createGoal("Runner", "Run forever") : m.startsWith("Note") ? createGoal("Notes", "Write notes") : continueTask()));
    const steps = new Map<string, number>();
    const agent = new Responder("test:agent", async (m) => {
      const n = steps.get(m) ?? 0;
      steps.set(m, n + 1);
      if (m.startsWith("Read")) {
        if (n === 0) return { toolCalls: [call("read", { path: "a.txt" })] };
        await reading.opened;
      }
      if (m.startsWith("Run") && n === 0) return { toolCalls: [call("terminal", { command: "echo hi", timeout_ms: 0 })] };
      return final({ full_answer: `Done with ${m} All good.`, continuation_note: `Finished ${m}` });
    });
    const s = socrates(w.store, router, agent, { resolveWorkspace: () => ({ name: "project", rootPath: w.root }) });
    const notes = await s.handle("Note the plan.", { lane: "new" });
    const read = s.handle("Read the file.", { lane: "new" });
    const run = s.handle("Run the command.", { lane: "new", approve: async () => (await approving.opened, true) });
    // Wait until lane 2 has read the file and lane 3 is asking for approval.
    for (let i = 0; i < 200 && !(s.lanes()[2]?.waitingForApproval && w.store.listEvents({ type: "tool_completed" }).length); i++) await new Promise((done) => setTimeout(done, 10));
    expect(s.lanes().map((l) => [l.number, l.running, l.waitingForApproval])).toEqual([[1, false, false], [2, true, false], [3, true, true]]);

    await s.handle("How are the lanes doing?");
    const mainContext = contextText(agent.requests.at(-1)!);
    const block = /<LANES>\n([\s\S]*?)\n<\/LANES>/.exec(mainContext)![1]!;
    expect(block).toBe([
      `lane 2 · working since 10:00 · g3/t1 "Read a.txt" in goal "Reading" · workspace project`,
      `  latest step: read a.txt`,
      `lane 3 · waiting for the user's approval · g4/t1 "Run forever" in goal "Runner" · workspace project`,
      `  latest step: terminal: echo hi`,
      `lane 1 · finished at 10:00 · g2/t1 "Write notes" in goal "Notes" · workspace project`,
      `  note: Finished Note the plan.`,
      `  answer: Done with Note the plan. All good.`,
    ].join("\n"));
    expect(mainContext.indexOf("<LANES>")).toBeGreaterThan(mainContext.indexOf("<CURRENT_TASK>"));
    expect(mainContext.indexOf("<LANES>")).toBeLessThan(mainContext.indexOf("<CURRENT_USER_MESSAGE>"));
    // A lane's own context does not list the lanes.
    expect(contextText(agent.requests.find((r) => messageOf(r) === "Note the plan.")!)).not.toContain("<LANES>");
    expect(notes.notice).toBe("Lane 1 finished: Write notes — Done with Note the plan.");

    reading.open();
    approving.open();
    await Promise.all([read, run]);
    await s.close();
  });

  it("lane results carry a one-line notice for main: finished, stopped, a question, or handed-off work", async () => {
    const w = await world();
    const hold = gate();
    const router = new Responder("test:router", (m) => {
      if (m === "Open the other project.") return { toolCalls: [{ name: "ask_user", input: { question: "Which project do you mean? The server or the docs.", candidates: [{ label: "Project work", detail: "The server work", goal_label: "current" }], allow_new: true } }] };
      return continueTask();
    });
    const agent = new Responder("test:agent", async (m) => {
      if (m === "Refactor the server.") await hold.opened;
      return final({ full_answer: `Done: ${m}` });
    });
    const s = socrates(w.store, router, agent);
    const asked = await s.handle("Open the other project.", { lane: "new" });
    expect(asked.notice).toBe("Lane 1 needs an answer: Which project do you mean?");

    const stop = new AbortController();
    const lane = s.handle("Refactor the server.", { lane: "new", signal: stop.signal });
    await new Promise((done) => setTimeout(done, 10));
    const handed = s.handle("Also rename the config.");
    await new Promise((done) => setTimeout(done, 10));
    stop.abort();
    expect((await lane).notice).toMatch(/^Lane 2 stopped: Fix the server — Stopped after 0 tool calls\.$/);
    expect((await handed).notice).toBe("Lane 2 finished: Fix the server — Done: Also rename the config.");
    expect((await s.handle("Back to main.")).notice).toBeNull();
    hold.open();
    await s.close();
  });
});

it("<LANES> marks a working lane's note as being from before its current run", async () => {
  const w = await world();
  const hold = gate();
  // A question about a lane goes to the general task, as the router is told to.
  const router = new Responder("test:router", (m) => (m === "How is it going?" ? { text: decision({ decision: "resume_existing", goal_label: "general", workspace_confidence: null }) } : continueTask()));
  const agent = new Responder("test:agent", async (m) => {
    if (m === "Run it again.") await hold.opened;
    return final({ full_answer: "ok" });
  });
  const s = socrates(w.store, router, agent);
  // The world's task already has a note from an earlier turn; the lane re-runs that task.
  const lane = s.handle("Run it again.", { lane: "new" });
  await new Promise((done) => setTimeout(done, 20));
  await s.handle("How is it going?");
  const block = /<LANES>\n([\s\S]*?)\n<\/LANES>/.exec(contextText(agent.requests.at(-1)!))![1]!;
  expect(block).toContain(`  note from before this run: ${w.store.requireTask(w.taskId).continuationNote}`);
  hold.open();
  await lane;
  await s.close();
});

it("keeps the active lane turn visible when a newer handoff is queued or cancelled", async () => {
  const w = await world();
  const started = gate(), hold = gate(), handed = gate();
  const s = socrates(w.store, new Responder("router", () => continueTask()), new Responder("agent", async (m) => {
    if (m === "First") { started.open(); await hold.opened; }
    return final();
  }));
  const first = s.handle("First", { lane: "new" });
  await started.opened;
  const original = w.store.latestLaneTurn(s.lanes()[0]!.id)!;
  const stop = new AbortController();
  w.clock.advance(60_000);
  const next = s.handle("Next", { signal: stop.signal, onHandoff() { handed.open(); } });
  await handed.opened;
  expect(w.store.latestLaneTurn(original.laneId!)!.id).toBe(original.id);
  stop.abort(); await next;
  const summary = laneSummaries(w.store, w.clock.now())[0]!;
  expect(summary).toMatchObject({ status: "working", at: original.createdAt, text: null });
  hold.open(); await first; await s.close();
});

it("clears cancelled approval state and ignores its late settlement during a newer approval", async () => {
  const w = await world();
  const asked = gate(), old = gate(), askedAgain = gate(), newer = gate();
  const counts = new Map<string, number>();
  const s = socrates(w.store, new Responder("router", () => continueTask()), new Responder("agent", (m) => {
    const n = counts.get(m) ?? 0; counts.set(m, n + 1);
    return n === 0 ? { toolCalls: [call("terminal", { command: "echo ok", timeout_ms: 0 })] } : final();
  }));
  const stop = new AbortController();
  const first = s.handle("First", { lane: "new", signal: stop.signal, approve: async () => { asked.open(); await old.opened; return true; } });
  await asked.opened;
  expect(s.lanes()[0]!.waitingForApproval).toBe(true);
  stop.abort(); await first;
  expect(s.lanes()[0]).toMatchObject({ running: false, waitingForApproval: false });
  const second = s.handle("Second", { lane: s.lanes()[0]!.id, approve: async () => { askedAgain.open(); await newer.opened; return true; } });
  await askedAgain.opened;
  old.open(); await Promise.resolve(); await Promise.resolve();
  expect(s.lanes()[0]!.waitingForApproval).toBe(true);
  newer.open(); await second;
  expect(s.lanes()[0]!.waitingForApproval).toBe(false);
  await s.close();
});

it("keeps live lanes visible within budget despite oversized notes and many finished lanes", async () => {
  const w = await world();
  for (let i = 0; i < 44; i++) {
    const lane = w.store.openLane();
    const turn = w.store.bindTurn({ userEventId: w.store.recordUserMessage("Work", lane.id).id, taskId: w.taskId, route: "test" });
    if (i < 40) w.store.completeTurn(turn.id, { responseEventId: w.store.recordResponse("Done").id, continuationNote: "very large note ".repeat(3000) });
  }
  const block = lanesBlock(w.store, laneSummaries(w.store, w.clock.now()).map((s) => ({ ...s, waitingForApproval: false })), w.clock.now(), "UTC")!;
  expect(countTokens(block)).toBeLessThanOrEqual(LANES_MAX_TOKENS);
  for (const n of [41, 42, 43, 44]) expect(block).toContain(`lane ${n} · working`);
  expect(block).toContain("more lanes omitted");
});

it("gives general-task lane runs their lane identity", async () => {
  const w = await world();
  const router = new Responder("router", () => ({ text: decision({ decision: "resume_existing", goal_label: "general", workspace_confidence: null }) }));
  const agent = new Responder("agent", () => final());
  const s = socrates(w.store, router, agent);
  await s.handle("What is two plus two?", { lane: "new" });
  expect(contextText(agent.requests[0]!)).toContain("lane: you are lane 1");
  await s.close();
});

it("reports every compound lane part with its own outcome", async () => {
  const w = await world();
  const text = "Fix the server, then write the docs.";
  const router = new Responder("router", () => ({ text: decision({ decision: "compound", workspace_confidence: null, parts: [
    { order: 1, request: "Fix the server", decision: "continue_current", goal_label: "current", task_decision: "continue_task", task_label: "current", new_goal_title: null, new_task_title: null, workspace_confidence: "high", reason: "r", depends_on: [] },
    { order: 2, request: "write the docs", decision: "continue_current", goal_label: "current", task_decision: "create_task", task_label: null, new_goal_title: null, new_task_title: "Write docs", ...defineTask("Write docs"), workspace_confidence: "high", reason: "r", depends_on: [1] },
  ] as never }) }));
  const stop = new AbortController();
  let steps = 0;
  const agent = new Responder("agent", () => { if (++steps === 2) stop.abort(); return final({ full_answer: "Server fixed." }); });
  const s = socrates(w.store, router, agent);
  const result = await s.handle(text, { lane: "new", signal: stop.signal });
  expect(result.notices).toHaveLength(2);
  expect(result.notices[0]).toBe("Lane 1 finished: Fix the server — Server fixed.");
  expect(result.notices[1]).toMatch(/^Lane 1 stopped: Write docs/);
  expect(result.notice).toBe(result.notices.join("\n"));
  await s.close();
});

it("uses live run state after restart, including while a recovered lane resumes", async () => {
  const w = await world();
  const lane = w.store.openLane();
  w.store.openLane(); // An empty panel left open by the previous process.
  const previous = w.store.bindTurn({ userEventId: w.store.recordUserMessage("Earlier work", lane.id).id, taskId: w.taskId, route: "test" });
  w.store.completeTurn(previous.id, { responseEventId: w.store.recordResponse("Earlier work finished").id });
  const stale = w.store.bindTurn({ userEventId: w.store.recordUserMessage("Old work", lane.id).id, taskId: w.taskId, route: "test" });
  const started = gate(), hold = gate();
  const router = new Responder("router", () => ({ text: decision({ decision: "resume_existing", goal_label: "general", workspace_confidence: null }) }));
  const agent = new Responder("agent", async (m) => { if (m === "Resume") { started.open(); await hold.opened; } return final(); });
  const s = socrates(w.store, router, agent);
  await s.handle("Status");
  expect(contextText(router.requests.at(-1)!)).toContain("lane 1 — stopped");
  expect(contextText(agent.requests.at(-1)!)).toContain("lane 1 · stopped");
  expect(contextText(agent.requests.at(-1)!)).toContain("lane 2 · idle");
  w.clock.advance(60_000);
  const run = s.handle("Resume", { lane: lane.id });
  await started.opened;
  await s.handle("Status again");
  expect(contextText(agent.requests.at(-1)!)).toContain("lane 1 · working since 10:01");
  hold.open(); await run;
  await s.handle("Final status");
  expect(contextText(agent.requests.at(-1)!)).toContain("lane 1 · finished");
  // Summary repair does not rewrite the exact history of the interrupted process.
  expect(w.store.requireTurn(stale.id).status).toBe("in_progress");
  await s.close();
});
