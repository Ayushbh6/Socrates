import type { ModelClient, ModelRequest, ModelResponse } from "@socrates/contracts";
import { abortable } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import type { ApprovalOrigin, ApprovalRequest } from "@socrates/tools";
import { describe, expect, it } from "vitest";
import { continueTask, createGoal, createTask, decision, defineTask } from "../../router/test/helpers";
import { MAX_RUNNING_LANES, Socrates, type SocratesOptions } from "../src";
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
