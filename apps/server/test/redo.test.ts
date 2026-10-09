import { describe, expect, it } from "vitest";
import { final } from "../../../packages/agent/test/helpers";
import { createGoal } from "../../../packages/router/test/helpers";
import { Responder, liveServer } from "./helpers";

const isResult = (id: string) => (m: Record<string, any>) => m.type === "result" && m.id === id;
const isError = (id: string) => (m: Record<string, any>) => m.type === "error" && m.id === id;
const naming = (request: { system: string }) => request.system.startsWith("You name a chat");
/** What the agent was shown for its turn. */
const shown = (request: { messages: unknown }) => JSON.stringify(request.messages);

describe("redo in another task", () => {
  it("asks a question again in the chosen chat or today's general conversation, and the page sees where each went", async () => {
    const router = new Responder("r", (_m, request) => (naming(request) ? { text: "Coupons" } : createGoal("Shop", "Fix checkout")));
    const agent = new Responder("a", () => final({ full_answer: "Fixed." }));
    const { page, rt } = await liveServer(router, agent);
    const p = await page();
    p.send({ type: "send", id: "m1", text: "Fix the coupon field.", to: "main" });
    await p.next(isResult("m1"));
    const first = rt.store.listEvents({ type: "turn_bound" }).at(-1)!.turn_id!;
    rt.store.createTask(rt.store.getGoalByNumber(1)!.id, { title: "Coupons" });

    const asked = router.requests.filter((r) => !naming(r)).length;
    p.send({ type: "redo", id: "r1", turn: first, chat: { goal: 1, task: 2 } });
    const redone = await p.next((m) => m.type === "activity" && m.kind === "redone");
    expect(redone).toMatchObject({ turnId: first, to: { goal: { number: 1 }, task: { number: 2, title: "Coupons" }, chat: 1 } });
    const routed = await p.next((m) => m.type === "activity" && m.kind === "routed" && m.turnId !== first);
    expect(routed).toMatchObject({ task: { number: 2 }, redoneFrom: { task: { number: 1, title: "Fix checkout" } } });
    await p.next(isResult("r1"));
    expect(router.requests.filter((r) => !naming(r)).length).toBe(asked);
    expect(shown(agent.requests.at(-1)!)).toContain("<REDONE_FROM>");
    expect(shown(agent.requests.at(-1)!)).toContain("Fix the coupon field.");

    // Refused: the same question twice, nowhere or two places, a question that is not there.
    p.send({ type: "redo", id: "r2", turn: first, chat: { goal: 1, task: 2 } });
    expect(await p.next(isError("r2"))).toMatchObject({ code: "redo_refused", message: "That question was already asked again in another task." });
    p.send({ type: "redo", id: "r3", turn: first });
    expect(await p.next(isError("r3"))).toMatchObject({ code: "bad_request" });
    p.send({ type: "redo", id: "r4", turn: "turn_missing", general: true });
    expect(await p.next(isError("r4"))).toMatchObject({ code: "not_found" });

    // Today's general conversation, which the page may not have seen yet.
    const second = rt.store.listEvents({ type: "turn_bound" }).at(-1)!.turn_id!;
    p.send({ type: "redo", id: "r5", turn: second, general: true });
    await p.next(isResult("r5"));
    const general = rt.store.getGeneralGoal()!;
    expect(rt.store.requireTurn(rt.store.listEvents({ type: "turn_bound" }).at(-1)!.turn_id!).goalId).toBe(general.id);
    expect(rt.store.redoneTo(second)?.goalId).toBe(general.id);
  });
});
