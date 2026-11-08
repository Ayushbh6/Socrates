import { describe, expect, it } from "vitest";
import { decision, defineTask } from "../../../packages/router/test/helpers";
import { final } from "../../../packages/agent/test/helpers";
import { Responder, liveServer } from "./helpers";

/** docs/visible-routing-plan.md, R1: the page gets the router's reason and what it searched for. */
describe("the routing reason on the page", () => {
  it("comes with the routed activity and the history part, and a search says what it looked for", async () => {
    let routerCalls = 0;
    const reason = "You're picking up the checkout work in your shop project.";
    const router = new Responder("r", () => (++routerCalls === 1
      ? { toolCalls: [{ name: "ledger_query", input: { match: "checkout" } }] }
      : { text: decision({ decision: "create_new", new_goal_title: "Shop", new_goal_objective: "Deliver Shop.", task_decision: "create_task", new_task_title: "Fix checkout", ...defineTask("Fix checkout"), reason }) }));
    const { page, app, token, port } = await liveServer(router, new Responder("a", () => final({ full_answer: "Checkout fixed." })));
    const p = await page();
    p.send({ type: "hello" });
    await p.next((m) => m.type === "state");
    p.send({ type: "send", id: "m1", text: "Fix the checkout.", to: "main" });
    await p.next((m) => m.type === "result" && m.id === "m1");

    expect(p.received.find((m) => m.kind === "routed")).toMatchObject({ task: { title: "Fix checkout" }, reason });
    const trails = p.received.filter((m) => m.type === "progress").map((m) => m.trail as { stage: string; detail?: string }[]);
    expect(trails.at(-1)).toContainEqual(expect.objectContaining({ stage: "searching", detail: "checkout" }));

    const history = await app.inject({ method: "GET", url: "/api/history", headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` } });
    expect(history.json().items.at(-1).parts[0]).toMatchObject({ task: { title: "Fix checkout" }, reason });
  });
});
