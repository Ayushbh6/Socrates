import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection } from "node:net";
import path from "node:path";
import { HashEmbedder } from "@socrates/providers";
import { continueTask, createGoal, decision, defineTask } from "../../../packages/router/test/helpers";
import { call, final } from "../../../packages/agent/test/helpers";
import { Responder, SCRIPTED, liveServer, tempDir } from "./helpers";

/** A promise the test opens when it wants a run to continue. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((done) => (open = done));
  return { open, opened };
}

const general = () => ({ text: decision({ decision: "resume_existing", goal_label: "general", workspace_confidence: null }) });
const isResult = (id: string) => (m: Record<string, any>) => m.type === "result" && m.id === id;

describe("the live connection", () => {
  it("broadcasts access settings to both pages and exposes them in API status", async () => {
    const { rt, page, app, token, port } = await liveServer(new Responder("r", () => general()), new Responder("a", () => final()));
    const first = await page();
    const second = await page();
    first.send({ type: "hello" });
    second.send({ type: "hello" });
    await Promise.all([first.next(m => m.type === "state"), second.next(m => m.type === "state")]);
    await rt.updateSettings({ access: { scope: "full", approvals: "auto" } });
    const match = (m: Record<string, any>) => m.type === "state" && m.access?.scope === "full" && m.access?.approvals === "auto";
    expect((await first.next(match)).access).toEqual(rt.settings.access);
    expect((await second.next(match)).access).toEqual(rt.settings.access);
    await rt.updateSettings({ timeZone: "Europe/Vienna" });
    const updated = (m: Record<string, any>) => m.type === "state" && m.ready && m.settings?.timeZone === "Europe/Vienna";
    expect((await first.next(updated)).settings).toEqual(rt.settings);
    expect((await second.next(updated)).settings).toEqual(rt.settings);
    const status = await app.inject({ method: "GET", url: "/api/status", headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` } });
    expect(status.statusCode).toBe(200);
    expect(status.json().access).toEqual(rt.settings.access);
  });
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
    const original = p.received.filter((m) => m.type === "activity" && (m.seq as number) > (routed.seq as number));
    const caughtUp = later.received.filter((m) => m.type === "activity").concat(replay);
    expect(caughtUp).toEqual(original);
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
    expect(asked).toMatchObject({ conversation: lane, lane: 1, kind: "action", tool: "terminal", detail: "Run echo approved-run (without a deadline)", preview: JSON.stringify({ command: "echo approved-run", timeout_ms: 0 }), task: "g1/t1 Run it with no deadl" });
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
    expect(await p.next((m) => m.type === "handed_off")).toEqual({ type: "handed_off", id: "more", conversation: lane, lane: 1, mainReleased: true });
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
      return n === 0 && m === "Read it." ? { toolCalls: [call("context_retrieve", { action: "ledger_search", query: "Read" })] } : final({ full_answer: "ok" });
    });
    const { page, app, rt, token, port } = await liveServer(new Responder("r", (m) => createGoal(m.slice(0, 20), m.slice(0, 20))), agent);
    const p = await page();
    p.send({ type: "send", id: "r1", text: "Read it.", to: "main" });
    const finished = await p.next((m) => m.type === "activity" && m.kind === "tool_finished");
    await p.next(isResult("r1"));
    const evidence = await app.inject({ method: "GET", url: `/api/evidence?task=${finished.task}&handle=${finished.handle}`, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } });
    expect(evidence.json()).toMatchObject({ task: finished.task, handle: "e1", tool: "context_retrieve", status: "ok", truncated: false });
    const turn = rt.store.getTurn(finished.turnId)!;
    expect(JSON.parse(evidence.json().content)).toEqual(rt.store.getEvidence(turn.taskId!, 1)!.result!.result);
    expect((await app.inject({ method: "GET", url: "/api/evidence?task=g9/t9&handle=e1", headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } })).statusCode).toBe(404);

    p.send({ type: "send", id: "w1", text: "Wait forever.", to: "main" });
    await p.next((m) => m.type === "activity" && m.kind === "routed" && m.task.title === "Wait forever.");
    await app.close();
    const turns = rt.store.listEvents({ type: "turn_interrupted" });
    expect(turns.at(-1)?.payload).toMatchObject({ reason: "cancelled" });
    hold.open();
  });
});

describe("drafts of a reply that is arriving", () => {
  it("does not revive a cancelled draft when its producer ignores the abort", async () => {
    const hold = gate();
    let late: ((text: string) => void) | undefined;
    const { page, rt } = await liveServer(new Responder("r", () => general()), new Responder("a", async (_m, request) => {
      late = request.onText;
      request.onText?.('{"full_answer":"Partial');
      await hold.opened;
      request.onText?.(" from an ignored abort");
      return final();
    }));
    const p = await page(); p.send({type:"hello"}); p.send({type:"send",id:"stop",text:"Stop it.",to:"main"});
    await p.next(m => m.type === "draft");
    p.send({type:"cancel",conversation:"main"});
    await p.next(isResult("stop"));
    late?.(" after persistence"); hold.open();
    const joined = await page(); joined.send({type:"hello"}); await joined.next(m => m.type === "state");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(joined.received.filter(m => m.type === "draft")).toEqual([]);
    expect(rt.store.listEvents({type:"assistant_response"})).toEqual([]);
  });
  /** An agent that streams the first part of its answer, waits, then finishes. */
  function slowAgent(hold: ReturnType<typeof gate>, answer: string) {
    return new Responder("a", async (_m, request) => {
      const text = final({ full_answer: answer }).text;
      const cut = text.indexOf(answer) + 8;
      request.onText?.(text.slice(0, cut));
      await hold.opened;
      request.onText?.(text.slice(cut));
      return { text };
    });
  }
  const drafts = (p: { received: Record<string, any>[] }) => p.received.filter((m) => m.type === "draft");

  it("sends the readable part of a reply as it arrives, to a page that joins late too, and never after the saved answer", async () => {
    const hold = gate();
    const { page, rt } = await liveServer(new Responder("r", () => createGoal("Shop", "Fix checkout")), slowAgent(hold, "Checkout fixed."));
    const p = await page();
    p.send({ type: "hello" });
    p.send({ type: "send", id: "m1", text: "Fix the checkout.", to: "main" });
    const draft = await p.next((m) => m.type === "draft");
    expect(draft).toMatchObject({ conversation: "main", call: 1, kind: "answer", text: "Checkout" });
    const routed = p.received.find((m) => m.type === "activity" && m.kind === "routed")!;
    expect(draft.turnId).toBe(routed.turnId);

    // A page that opens mid-reply is brought up to date with the draft, after the state.
    const late = await page();
    late.send({ type: "hello" });
    await late.next((m) => m.type === "state");
    expect(await late.next((m) => m.type === "draft")).toEqual(draft);

    hold.open();
    await p.next(isResult("m1"));
    const sequence = p.received.map((m) => (m.type === "draft" ? "draft" : m.type === "activity" ? m.kind : m.type));
    expect(sequence.lastIndexOf("draft")).toBeLessThan(sequence.indexOf("answer"));
    // Only the saved answer is in the record, and a page joining afterwards sees no draft.
    expect(rt.store.listEvents({ type: "assistant_response" }).map((e) => (e.payload as { text: string }).text)).toEqual(["Checkout fixed."]);
    const after = await page();
    after.send({ type: "hello" });
    await after.next((m) => m.type === "state");
    await new Promise((r) => setTimeout(r, 120));
    expect(drafts(after)).toEqual([]);
  });

  it("keeps the answer written before Stop, live and in history, without saving it as an answer", async () => {
    const hold = gate();
    const { page, rt, app, token, port } = await liveServer(new Responder("r", () => createGoal("Shop", "Fix checkout")), slowAgent(hold, "Checkout fixed."));
    const p = await page();
    p.send({ type: "hello" });
    p.send({ type: "send", id: "m1", text: "Fix the checkout.", to: "main" });
    await p.next((m) => m.type === "draft");
    p.send({ type: "cancel", conversation: "main" });
    await p.next(isResult("m1"));
    const finished = await p.next((m) => m.type === "activity" && m.kind === "finished");
    expect(finished).toMatchObject({ status: "interrupted", reason: "cancelled", partial: "Checkout" });
    expect(rt.store.listEvents({ type: "assistant_response" })).toEqual([]);
    const history = await app.inject({ method: "GET", url: "/api/history", headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` } });
    expect(history.json().items[0].parts[0]).toMatchObject({ status: "interrupted", interrupted: "cancelled", answer: "Checkout" });
    hold.open();
  });

  it("sends a lane's draft under the lane and keeps drafts of simultaneous turns apart", async () => {
    const hold = gate();
    const { page } = await liveServer(new Responder("r", (m) => createGoal(m.slice(0, 12), m.slice(0, 12))), new Responder("a", async (m, request) => {
      const text = final({ full_answer: `Answer to ${m}` }).text;
      request.onText?.(text.slice(0, 30));
      await hold.opened;
      return { text };
    }));
    const p = await page();
    p.send({ type: "hello" });
    p.send({ type: "send", id: "a", text: "Alpha question.", to: "main" });
    const mainDraft = await p.next((m) => m.type === "draft" && m.conversation === "main");
    p.send({ type: "send", id: "b", text: "Beta question.", to: "new_lane" });
    const lane = (await p.next((m) => m.type === "accepted" && m.id === "b")).conversation as string;
    const laneDraft = await p.next((m) => m.type === "draft" && m.conversation === lane);
    expect(laneDraft.turnId).not.toBe(mainDraft.turnId);
    expect(mainDraft.text).toContain("Answer to Alph");
    expect(laneDraft.text).toContain("Answer to Beta");
    hold.open();
    await p.next(isResult("a"));
    await p.next(isResult("b"));
  });
});

describe("S2 closure regressions", () => {
  it("delivers events saved between connection and hello exactly once", async () => {
    const { page, rt } = await liveServer(new Responder("r", () => general()), new Responder("a", () => final()));
    const p = await page();
    const event = rt.store.recordUserMessage("Between upgrade and hello.");
    p.send({ type: "hello", after: 0 });
    await p.next((m) => m.type === "state");
    await p.next((m) => m.type === "activity" && m.seq === event.seq);
    p.send({ type: "hello" });
    await p.next((m) => m.type === "state");
    expect(p.received.filter((m) => m.type === "activity" && m.seq === event.seq)).toEqual([]);
    const next = rt.store.recordUserMessage("Live after hello.");
    expect(await p.next((m) => m.type === "activity" && m.seq === next.seq)).toMatchObject({ text: "Live after hello." });
  });

  it("isolates simultaneous approvals, shares them on reconnect, and refuses pending work on shutdown", async () => {
    const folder = tempDir();
    const steps = new Map<string, number>();
    const agent = new Responder("a", (m) => {
      const n = steps.get(m) ?? 0;
      steps.set(m, n + 1);
      return n === 0 ? { toolCalls: [call("terminal", { command: `echo ${m}`, timeout_ms: 0 })] } : final();
    });
    const { page, app, rt } = await liveServer(new Responder("r", (m) => createGoal(m, m)), agent);
    const workspace = rt.store.createWorkspace("project", folder);
    await rt.updateSettings({ workingFolder: workspace.id });
    const p = await page();
    p.send({ type: "send", id: "main", text: "MAIN", to: "main" });
    const main = await p.next((m) => m.type === "approval" && m.conversation === "main");
    p.send({ type: "send", id: "lane", text: "LANE", to: "new_lane" });
    const lane = await p.next((m) => m.type === "approval" && m.conversation !== "main");
    const other = await page();
    other.send({ type: "hello" });
    expect((await other.next((m) => m.type === "state")).approvals).toEqual(expect.arrayContaining([expect.objectContaining({ id: main.id }), expect.objectContaining({ id: lane.id })]));
    other.send({ type: "approve", approval: main.id, granted: true });
    await p.next(isResult("main"));
    other.send({ type: "hello" });
    expect((await other.next((m) => m.type === "state" && m.approvals.length === 1)).approvals[0].id).toBe(lane.id);
    p.send({ type: "approve", approval: lane.id, granted: false });
    await p.next(isResult("lane"));
    expect(rt.store.listEvents({ type: "approval_decided" }).map((e) => e.payload)).toEqual([
      expect.objectContaining({ granted: true, detail: "Run echo MAIN (without a deadline)" }),
      expect.objectContaining({ granted: false, detail: "Run echo LANE (without a deadline)" }),
    ]);
    p.send({ type: "send", id: "shutdown", text: "SHUTDOWN", to: "main" });
    await p.next((m) => m.type === "approval" && m.detail.includes("SHUTDOWN"));
    await app.close();
    expect(rt.store.listEvents({ type: "turn_interrupted" }).at(-1)?.payload).toMatchObject({ reason: "cancelled" });
  });

  it("retrieves the full retained terminal output and caps large recordings without exposing diagnostics", async () => {
    const folder = tempDir();
    let n = 0;
    const { page, rt, app, token, port } = await liveServer(new Responder("r", () => createGoal("Output", "Read output")), new Responder("a", () => n++ === 0 ? {
      text: "I will inspect the command output.",
      toolCalls: [call("terminal", { command: "node -e \"process.stdout.write('A'.repeat(12000)+'MIDDLE-KESTREL'+'Z'.repeat(12000))\"" })],
    } : final()));
    const workspace = rt.store.createWorkspace("project", folder);
    await rt.updateSettings({ workingFolder: workspace.id, access: { approvals: "auto" } });
    const p = await page();
    p.send({ type: "send", id: "output", text: "Read output.", to: "main" });
    expect(await p.next((m) => m.type === "activity" && m.kind === "step")).toMatchObject({ text: "I will inspect the command output.", conversation: "main" });
    const finished = await p.next((m) => m.type === "activity" && m.kind === "tool_finished");
    const result = await p.next(isResult("output"));
    expect(finished.preview).toHaveLength(2000);
    expect(finished.truncated).toBe(true);
    const get = (task: string, handle: string) => app.inject({ method: "GET", url: `/api/evidence?task=${task}&handle=${handle}`, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } });
    const evidence = (await get(finished.task, finished.handle)).json();
    expect(evidence).toMatchObject({ content: `${"A".repeat(12000)}MIDDLE-KESTREL${"Z".repeat(12000)}`, truncated: false, outputLost: false });
    const turn = rt.store.requireTurn(result.result.parts[0].turnId);
    const refs = { goal_id: turn.goalId!, task_id: turn.taskId!, turn_id: turn.id, chat_id: turn.chatId };
    const large = rt.store.recordToolCall(refs, { callId: "large", tool: "terminal", input: { command: "synthetic large output" } });
    rt.store.recordToolResult(refs, { call_id: "large", handle: large.handle, tool: "terminal", status: "ok", content: "shortened", result: { output_full: "X".repeat(200001), output_lost: true }, error: null, diagnostics: "private diagnostics", observed: [], facts: [], wall_time_ms: 1 });
    const capped = await get(finished.task, large.handle);
    expect(capped.json()).toMatchObject({ content: "X".repeat(200000), truncated: true, outputLost: true });
    expect(capped.body).not.toContain("private diagnostics");
    const pending = rt.store.recordToolCall(refs, { callId: "failed-mcp", tool: "mcp__fixture__read", input: {} });
    expect((await get(finished.task, pending.handle)).json().content).toBeNull();
    const failure = { content: `FULL-MCP-FAILURE:${"Y".repeat(5000)}` };
    const error = { code: "mcp_tool_error", message: "Shortened failure", correction: "Retry with corrected input.", retryable: true };
    rt.store.recordToolResult(refs, { call_id: "failed-mcp", handle: pending.handle, tool: "mcp__fixture__read", status: "error", content: "shortened failure", result: null, error, failure_detail: failure, diagnostics: "private MCP diagnostics", observed: [], facts: [], wall_time_ms: 1 });
    const failed = await get(finished.task, pending.handle);
    expect(JSON.parse(failed.json().content)).toEqual({ error, failure_detail: failure });
    expect(failed.body).not.toContain("private MCP diagnostics");
    expect((await get("g9007199254740992/t1", "e1")).statusCode).toBe(400);
    expect((await get("g1/t1", "e0")).statusCode).toBe(400);
  });

  it("bounds shutdown when a connected page never answers its WebSocket close frame", async () => {
    const { app, port, token } = await liveServer(new Responder("r", () => general()), new Responder("a", () => final()));
    const socket = createConnection({ host: "127.0.0.1", port });
    await once(socket, "connect");
    const upgraded = once(socket, "data");
    socket.write(`GET /api/live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    expect(String((await upgraded)[0])).toContain("101 Switching Protocols");
    socket.pause();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("WebSocket prevented shutdown")), 2500); })]);
      expect(Date.now() - started).toBeLessThan(2500);
    } finally { clearTimeout(timer); socket.destroy(); }
  });

  it("preserves exact message text and rejects unknown or closed lanes before acceptance", async () => {
    const { page, rt } = await liveServer(new Responder("r", () => general()), new Responder("a", () => final()));
    const p = await page();
    const text = "  Hello.\n\n";
    p.send({ type: "send", id: "exact", text, to: "main" });
    await p.next(isResult("exact"));
    expect(rt.store.listEvents({ type: "user_message" }).at(-1)?.payload).toEqual({ text });
    const lane = rt.store.openLane();
    rt.store.closeLane(lane.id);
    for (const to of ["missing", lane.id]) {
      p.send({ type: "send", id: to, text: "Hi.", to });
      expect(await p.next((m) => m.type === "error" && m.id === to)).toMatchObject({ code: "lane_closed" });
      expect(p.received.some((m) => m.type === "accepted" && m.id === to)).toBe(false);
    }
    p.send({ type: "send", id: "blank", text: " \n ", to: "main" });
    expect(await p.next((m) => m.type === "error" && m.code === "invalid_command")).toBeDefined();
  });

  it("reserves IDs across queued messages, other tabs and reconnects, including completed messages", async () => {
    const hold = gate();
    const { page, rt } = await liveServer(new Responder("r", () => general()), new Responder("a", async (m) => {
      if (m === "Hold.") await hold.opened;
      return final();
    }));
    const p = await page(), other = await page();
    p.send({ type: "send", id: "hold", text: "Hold.", to: "main" });
    await p.next((m) => m.type === "state" && m.busy);
    p.send({ type: "queue", id: "same", text: "Queued." });
    await p.next((m) => m.type === "state" && m.queue.length === 1);
    other.send({ type: "send", id: "same", text: "Duplicate.", to: "new_lane" });
    expect(await other.next((m) => m.type === "error" && m.id === "same")).toMatchObject({ code: "duplicate" });
    hold.open();
    await p.next(isResult("same"));
    await p.close();
    const again = await page();
    again.send({ type: "send", id: "same", text: "Replay.", to: "main" });
    expect(await again.next((m) => m.type === "error" && m.id === "same")).toMatchObject({ code: "duplicate" });
    expect(rt.store.listEvents({ type: "user_message" }).map((e) => e.payload)).toEqual([{ text: "Hold." }, { text: "Queued." }]);
  });

  it("refuses a fifth running lane and preserves a queued item when moving it fails", async () => {
    const hold = gate();
    const { page, rt } = await liveServer(new Responder("r", (m) => createGoal(m, m)), new Responder("a", async () => {
      await hold.opened;
      return final();
    }));
    const p = await page();
    p.send({ type: "send", id: "main", text: "Main", to: "main" });
    await p.next((m) => m.type === "state" && m.busy);
    for (let i = 1; i <= 4; i++) {
      p.send({ type: "send", id: `lane${i}`, text: `Lane ${i}`, to: "new_lane" });
      await p.next((m) => m.type === "accepted" && m.id === `lane${i}`);
    }
    p.send({ type: "send", id: "fifth", text: "Fifth", to: "new_lane" });
    expect(await p.next((m) => m.type === "error" && m.id === "fifth")).toMatchObject({ code: "lane_limit" });
    p.send({ type: "queue", id: "move", text: "Move" });
    await p.next((m) => m.type === "state" && m.queue.length === 1);
    p.send({ type: "queue_to_lane", id: "move" });
    expect(await p.next((m) => m.type === "error" && m.id === "move")).toMatchObject({ code: "lane_limit" });
    p.send({ type: "hello" });
    expect((await p.next((m) => m.type === "state" && m.queue.length === 1)).queue).toEqual([{ id: "move", text: "Move" }]);
    expect(rt.store.listLanes()).toHaveLength(4);
    hold.open();
    await p.next(isResult("move"));
  });

  it("enforces the queue bound and closes only idle lanes", async () => {
    const hold = gate();
    const { page, rt } = await liveServer(new Responder("r", () => general()), new Responder("a", async () => {
      await hold.opened;
      return final();
    }));
    const p = await page();
    p.send({ type: "send", id: "main", text: "Main", to: "main" });
    await p.next((m) => m.type === "state" && m.busy);
    p.send({ type: "send", id: "lane", text: "Lane", to: "new_lane" });
    const lane = (await p.next((m) => m.type === "accepted" && m.id === "lane")).conversation;
    p.send({ type: "close_lane", lane });
    expect(await p.next((m) => m.type === "error" && m.code === "lane_running")).toBeDefined();
    for (let i = 0; i < 21; i++) p.send({ type: "queue", id: `q${i}`, text: `Message ${i}` });
    expect(await p.next((m) => m.type === "error" && m.id === "q20")).toMatchObject({ code: "queue_full" });
    expect((await p.next((m) => m.type === "state" && m.queue.length === 20)).queue).toHaveLength(20);
    p.received.length = 0;
    for (let i = 0; i < 20; i++) p.send({ type: "queue_remove", id: `q${i}` });
    await p.next((m) => m.type === "state" && m.queue.length === 0 && m.busy);
    hold.open();
    await p.next(isResult("lane"));
    p.send({ type: "close_lane", lane });
    await p.next((m) => m.type === "activity" && m.kind === "lane" && m.state === "closed");
    expect(rt.store.getLane(lane)?.closedAt).not.toBeNull();
    expect(rt.store.conversationMessages(lane, { limit: 30 })).toHaveLength(1);
  });

  it("broadcasts configuration readiness to every tab and resumes the queue after rebuilding", async () => {
    const started = gate(), hold = gate();
    let rebuilding = false;
    const { page, app, rt, token, port } = await liveServer(new Responder("r", () => general()), new Responder("a", () => final()), {
      settings: {},
      deps: { makeEmbedder: () => {
        const client = new HashEmbedder();
        return { id: client.id, embed: async (...args) => {
          if (rebuilding) { started.open(); await hold.opened; }
          return client.embed(...args);
        } };
      } },
    });
    const p = await page(), other = await page();
    rebuilding = true;
    p.send({ type: "hello" });
    other.send({ type: "hello" });
    await p.next((m) => m.type === "state");
    await other.next((m) => m.type === "state");
    const update = app.inject({ method: "PUT", url: "/api/settings", payload: SCRIPTED, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } });
    // Inject begins when its thenable is consumed.
    const updating = Promise.resolve(update);
    await started.opened;
    p.send({ type: "send", id: "early", text: "Hello.", to: "main" });
    expect(await p.next((m) => m.type === "error" && m.id === "early")).toMatchObject({ code: "busy" });
    p.send({ type: "queue", id: "queued", text: "Wait for setup." });
    expect((await other.next((m) => m.type === "state" && m.queue.length === 1)).ready).toBe(false);
    rebuilding = false;
    hold.open();
    expect((await updating).statusCode).toBe(200);
    expect(await p.next((m) => m.type === "state" && m.ready)).toBeDefined();
    expect(await other.next((m) => m.type === "state" && m.ready)).toBeDefined();
    await p.next(isResult("queued"));
    expect(rt.store.listEvents({ type: "user_message" })).toHaveLength(1);
  });

  it("resets a cursor from a different or older data folder that is ahead of the ledger", async () => {
    const { page } = await liveServer(new Responder("r", () => general()), new Responder("a", () => final()));
    const p = await page();
    p.send({ type: "hello", after: 999_999 });
    expect(await p.next((m) => m.type === "reset")).toMatchObject({ seq: 0 });
  });

  for (const cancellation of ["main", "lane"] as const) it(`cancels a compound handoff through ${cancellation} while retaining main ownership`, async () => {
    const started = gate(), hold = gate();
    const text = "Fix it, then write docs.";
    const part = (order: number, extra: object) => ({ order, request: order === 1 ? "Fix it" : "write docs", goal_label: "current", new_goal_title: null, task_label: null, new_task_title: null, workspace_confidence: "high", reason: "r", depends_on: order === 2 ? [1] : [], ...extra });
    const router = new Responder("r", (m) => m === "Seed" ? createGoal("Server", "Fix") : m === text ? { text: decision({ decision: "compound", workspace_confidence: null, parts: [
      part(1, { decision: "continue_current", task_decision: "continue_task", task_label: "current" }),
      part(2, { decision: "continue_current", task_decision: "create_task", new_task_title: "Write docs", ...defineTask("Write docs") }),
    ] as never }) } : continueTask());
    const { page, rt } = await liveServer(router, new Responder("a", async (m) => {
      if (m === "Hold lane") { started.open(); await hold.opened; }
      return final();
    }));
    const p = await page();
    p.send({ type: "send", id: "seed", text: "Seed", to: "main" });
    await p.next(isResult("seed"));
    p.send({ type: "send", id: "lane", text: "Hold lane", to: "new_lane" });
    const lane = (await p.next((m) => m.type === "accepted" && m.id === "lane")).conversation;
    await started.opened;
    p.send({ type: "send", id: "compound", text, to: "main" });
    expect(await p.next((m) => m.type === "handed_off" && m.id === "compound")).toMatchObject({ mainReleased: false });
    expect(rt.socrates?.busy).toBe(true);
    p.send({ type: "cancel", conversation: cancellation === "main" ? "main" : lane });
    expect(await p.next(isResult("compound"))).toMatchObject({ conversation: "main", result: { parts: [{ status: "interrupted" }, { status: "interrupted" }] } });
    hold.open();
    await p.next(isResult("lane"));
  });

  it("takes explicit anchor approve, reject and supersede decisions through the socket", async () => {
    const folder = tempDir();
    writeFileSync(path.join(folder, "plan.md"), "Approved plan.\n");
    const { page, rt } = await liveServer(new Responder("r", (m) => m === "Seed" ? createGoal("Plan", "Review plan") : continueTask()), new Responder("a", () => final()));
    const workspace = rt.store.createWorkspace("project", folder);
    await rt.updateSettings({ workingFolder: workspace.id });
    const p = await page();
    p.send({ type: "send", id: "seed", text: "Seed", to: "main" });
    await p.next(isResult("seed"));
    const goalId = rt.store.getGoalByNumber(1)!.id;
    const sendDecision = async (id: string, decision: string) => {
      p.send({ type: "send", id, text: "Apply my selection.", to: "main", anchorDecisions: [{ goalId, path: "plan.md", role: "plan", decision }] });
      return p.next(isResult(id));
    };
    expect((await sendDecision("approve", "approve")).result.parts[0].anchorChanges).toEqual([{ path: "plan.md", role: "plan", status: "active" }]);
    expect((await sendDecision("supersede", "supersede")).result.parts[0].anchorChanges).toEqual([{ path: "plan.md", role: "plan", status: "superseded" }]);
    rt.store.upsertAnchor({ goalId, path: "plan.md", role: "plan", summary: "Candidate", status: "provisional" });
    expect((await sendDecision("reject", "reject")).result.parts[0].anchorChanges).toEqual([{ path: "plan.md", role: "plan", status: "superseded" }]);
  });
});
