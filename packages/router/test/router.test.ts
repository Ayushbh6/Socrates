import { ModelError } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { buildRoutingContext } from "../src";
import { TZ, continueTask, createGoal, createTask, decision, defineTask, exchange, general, routerWith, setup } from "./helpers";

describe("routing outcomes and binding", () => {
  it("routes a first greeting to the general task", async () => {
    const { store } = setup();
    const { router, routerModel } = routerWith(store, [general()]);
    const result = await router.route("Hi, how are you?");
    expect(result.kind).toBe("routed");
    if (result.kind !== "routed") return;
    expect(result.parts[0]!.goal.general).toBe(true);
    expect(result.parts[0]!.task.general).toBe(true);

    const input = routerModel.requests[0]!.messages[0]!.content as string;
    expect(input).toContain("<RECENT_EXACT_HISTORY>\nNone\n</RECENT_EXACT_HISTORY>");
    expect(input).toContain("CURRENT\nNone");
    expect(input).toContain("label: general");
    expect(input.trimEnd().endsWith("<CURRENT_USER_MESSAGE>\nHi, how are you?\n</CURRENT_USER_MESSAGE>")).toBe(true);
  });

  it("persists the exact message before routing", async () => {
    const { store } = setup();
    const { router } = routerWith(store, [general()]);
    const result = await router.route("  exact  text\n");
    expect(store.getEvent(result.userEventId)?.payload).toEqual({ text: "  exact  text\n" });
  });

  it("creates a goal and task, then continues and extends it", async () => {
    const { store } = setup();
    const r1 = await exchange(store, "Review the memory system", createGoal("Socrates development", "Review Socrates memory system"));
    expect(r1.kind === "routed" && r1.parts[0]!.created).toEqual({ goal: true, task: true });

    const r2 = await exchange(store, "What is its biggest weakness?", continueTask());
    expect(r2.kind === "routed" && r2.parts[0]!.task.title).toBe("Review Socrates memory system");

    const r3 = await exchange(store, "Does issue #42 still reproduce?", createTask("Investigate GitHub issue #42"));
    if (r3.kind !== "routed") throw new Error("expected routed");
    expect(r3.parts[0]!.goal.title).toBe("Socrates development");
    expect(r3.parts[0]!.task.number).toBe(2);
    expect(r3.parts[0]!.turn.projectTurn).toBe(3);
  });

  it("resumes an earlier task of the current goal by its listed label", async () => {
    const { store } = setup();
    await exchange(store, "Review the memory system", createGoal("Socrates development", "Review memory system"));
    await exchange(store, "Look at issue #42", createTask("Investigate issue #42"));
    const { router, routerModel } = routerWith(store, [
      { text: decision({ decision: "resume_existing", goal_label: "current", task_decision: "resume_task", task_label: "task_1" }) },
    ]);
    const result = await router.route("Could that memory fix lose information?");
    const input = routerModel.requests[0]!.messages[0]!.content as string;
    expect(input).toContain("- current: Investigate issue #42 — open");
    expect(input).toContain("- task_1: Review memory system — open");
    expect(result.kind === "routed" && result.parts[0]!.task.title).toBe("Review memory system");
  });

  it("arms the first-mutation gate for low workspace confidence", async () => {
    const { store } = setup();
    const { router } = routerWith(store, [
      {
        text: decision({
          decision: "create_new",
          new_goal_title: "Checkout",
          new_goal_objective: "Deliver a working checkout.",
          task_decision: "create_task",
          new_task_title: "Fix checkout", ...defineTask("Fix checkout"),
          workspace_confidence: "low",
        }),
      },
    ]);
    const result = await router.route("Fix the checkout bug");
    expect(result.kind === "routed" && result.parts[0]!.turn.gateArmed).toBe(true);
  });

  it("binds a compound message once with one turn per part and a mechanical acknowledgment", async () => {
    const { store } = setup();
    await exchange(store, "Investigate issue #42", createGoal("Socrates development", "Investigate GitHub issue #42"));
    await exchange(store, "Align onboarding with Figma", createTask("Align onboarding page with Figma"));
    const part = (order: number, extra: object) => ({
      order,
      request: order === 1 ? "Post the summary on #42" : "audit the touched endpoints",
      goal_label: "current",
      new_goal_title: null,
      task_label: null,
      new_task_title: null,
      workspace_confidence: "high",
      reason: "r",
      depends_on: order === 2 ? [1] : [],
      ...extra,
    });
    const { router } = routerWith(store, [
      {
        text: decision({
          decision: "compound",
          workspace_confidence: null,
          parts: [
            part(1, { decision: "resume_existing", task_decision: "resume_task", task_label: "task_1" }),
            part(2, { decision: "continue_current", task_decision: "create_task", new_task_title: "Security review of issue #42 API changes", ...defineTask("Security review of issue #42 API changes") }),
          ] as never,
        }),
      },
    ]);
    const result = await router.route("Post the summary on #42, then audit the touched endpoints");
    if (result.kind !== "routed") throw new Error("expected routed");
    expect(result.parts.map((p) => p.task.title)).toEqual(["Investigate GitHub issue #42", "Security review of issue #42 API changes"]);
    expect(result.parts.map((p) => p.turn.userEventId)).toEqual([result.userEventId, result.userEventId]);
    expect(result.parts[1]!.dependsOn).toEqual([1]);
    expect(result.acknowledgment).toBe(
      "Two things here — I'll do Investigate GitHub issue #42 first, then Security review of issue #42 API changes.",
    );
  });
});

describe("a message that is only images", () => {
  it("is routed by the conversation, never split, and its empty text is kept exactly", async () => {
    const { store } = setup();
    await exchange(store, "Review the onboarding page", createGoal("Onboarding", "Review onboarding page"));
    const attachment = { id: "0123456789abcdef0123456789abcdef", name: "screen.png", path: "/tmp/screen.png", media_type: "image/png" as const, width: 10, height: 10, bytes: 100 };
    const user = store.recordUserMessage("", null, [attachment]);
    const part = (order: number) => ({ order, request: order === 1 ? "this" : "that", decision: "continue_current", goal_label: "current", task_decision: "continue_task", task_label: "current", new_goal_title: null, new_task_title: null, workspace_confidence: "high", reason: "r", depends_on: [] });
    const { router, routerModel } = routerWith(store, [
      { text: decision({ decision: "compound", workspace_confidence: null, parts: [part(1), part(2)] as never }) },
      continueTask(),
    ]);
    const result = await router.route("", undefined, { userEventId: user.id });
    const input = routerModel.requests[0]!.messages[0]!.content as string;
    expect(input).toContain("<CURRENT_ATTACHMENTS>\n[The user attached an image: screen.png]\n</CURRENT_ATTACHMENTS>");
    expect(input.trimEnd().endsWith("<CURRENT_USER_MESSAGE>\n(No text: the user sent only the images in CURRENT_ATTACHMENTS.)\n</CURRENT_USER_MESSAGE>")).toBe(true);
    expect(routerModel.requests[1]!.messages.at(-1)!.content).toContain("request must be an exact, ordered sub-request");
    expect(result.kind === "routed" && result.parts.map((p) => p.task.title)).toEqual(["Review onboarding page"]);
    expect(store.getEvent(user.id)!.payload).toEqual({ text: "", attachments: [attachment] });

    if (result.kind !== "routed") throw new Error("expected routed");
    store.completeTurn(result.parts[0]!.turn.id, { responseEventId: store.recordResponse("A sign-up form.").id, continuationNote: null });

    // Later routing shows the exchange with only its images.
    const { router: next, routerModel: nextModel } = routerWith(store, [continueTask()]);
    await next.route("And the footer?");
    expect(nextModel.requests[0]!.messages[0]!.content).toContain("USER:\n[The user attached an image: screen.png]\n\nSOCRATES:");
  });
});

describe("validation, repair, escalation, and fallback", () => {
  it("repairs an invalid label once with a corrective message", async () => {
    const { store } = setup();
    await exchange(store, "Review the memory system", createGoal("Socrates development", "Review memory system"));
    const { router, routerModel } = routerWith(store, [
      { text: decision({ decision: "resume_existing", goal_label: "older_7", task_decision: "resume_task", task_label: "latest" }) },
      continueTask(),
    ]);
    const result = await router.route("keep going");
    expect(result.kind).toBe("routed");
    expect(result.kind === "routed" && result.escalated).toBe(false);
    const repair = routerModel.requests[1]!.messages.at(-1)!.content as string;
    expect(repair).toContain('goal_label "older_7" is unknown');
    expect(repair).toContain("Valid labels: current");
  });

  it("rejects illegal decision combinations", async () => {
    const { store } = setup();
    await exchange(store, "Review the memory system", createGoal("Socrates development", "Review memory system"));
    const { router, routerModel } = routerWith(store, [
      { text: decision({ decision: "resume_existing", goal_label: "current", task_decision: "continue_task", task_label: "current" }) },
      { text: "not json at all" },
    ]);
    const result = await router.route("new thing");
    const repair = routerModel.requests[1]!.messages.at(-1)!.content as string;
    expect(repair).toContain("continue_task is valid only for the current task");
    // Second failure with no main model falls back to the one clearly current goal.
    expect(result.kind === "routed" && result.fallback).toBe("continue_current");
  });

  it("escalates once to the main model after the router model fails twice", async () => {
    const { store } = setup();
    await exchange(store, "Review the memory system", createGoal("Socrates development", "Review memory system"));
    const { router, mainModel } = routerWith(store, [{ text: "{}" }, { text: "{}" }], [continueTask()]);
    const result = await router.route("continue");
    expect(result.kind === "routed" && result.escalated).toBe(true);
    expect(mainModel!.requests).toHaveLength(1);
    const event = store.listEvents({ type: "routing_completed" }).at(-1)!;
    expect(event.payload).toMatchObject({ model: "test:main", attempts: 2, escalated: true });
  });

  it("treats model failures like invalid answers and still binds the message", async () => {
    const { store } = setup();
    await exchange(store, "Review the memory system", createGoal("Socrates development", "Review memory system"));
    const failing = (): never => {
      throw new ModelError("Could not reach the model endpoint.", "network");
    };
    const { router } = routerWith(store, [failing], [failing]);
    const result = await router.route("keep going");
    expect(result.kind === "routed" && result.fallback).toBe("continue_current");
    expect(result.kind === "routed" && result.escalated).toBe(true);
  });

  it("propagates cancellation", async () => {
    const { store } = setup();
    const { router } = routerWith(store, [
      (): never => {
        throw new ModelError("Request aborted.", "aborted");
      },
    ]);
    await expect(router.route("hi")).rejects.toThrow("aborted");
  });

  it("falls back to creating the first goal when nothing exists", async () => {
    const { store } = setup();
    const { router } = routerWith(store, [{ text: "garbage" }, { text: "garbage" }]);
    const result = await router.route("Build me a landing page for my bakery please");
    if (result.kind !== "routed") throw new Error("expected routed");
    expect(result.fallback).toBe("first_goal");
    expect(result.parts[0]!.goal.title).toBe("Build me a landing page for my bakery");
  });

  it("falls back to asking which subject when several goals are plausible", async () => {
    const { store, clock } = setup();
    await exchange(store, "German lessons", createGoal("Ongoing German learning", "Day 1 lesson"));
    clock.advance(3_600_000);
    await exchange(store, "Website work", createGoal("Website X", "Checkout fix"));
    const { router } = routerWith(store, [{ text: "x" }, { text: "y" }]);
    const result = await router.route("continue the German lessons");
    if (result.kind !== "clarify") throw new Error("expected clarify");
    expect(result.fallback).toBe("ask_subject");
    expect(result.question.candidates.map((c) => c.label)).toEqual(["Website X", "Ongoing German learning"]);
  });
});

describe("ledger_query and ask_user", () => {
  it("accepts a gN selector only after ledger_query returned it", async () => {
    const { store, clock } = setup("2026-03-10T10:00:00Z");
    await exchange(store, "Start German", createGoal("Ongoing German learning", "German Day 1"), "ok", "Day 1 done.");
    for (let i = 0; i < 4; i++) {
      clock.advance(86_400_000 * 30);
      await exchange(store, `Website ${i}`, createGoal(`Website ${i}`, `Task ${i}`));
    }
    clock.set("2026-09-01T10:00:00Z");

    const guessed = routerWith(store, [
      { text: decision({ decision: "resume_existing", goal_label: "g1", task_decision: "resume_task", task_label: "g1/t1" }) },
      { text: "still invalid" },
    ]);
    const r1 = await guessed.router.route("remember the thing from March?");
    const repair = guessed.routerModel.requests[1]!.messages.at(-1)!.content as string;
    expect(repair).toContain('goal_label "g1" was not returned by ledger_query');
    expect(r1.fallback).not.toBeNull();

    const queried = routerWith(store, [
      { toolCalls: [{ name: "ledger_query", input: { from: "2026-03-01", to: "2026-03-31" } }] },
      { text: decision({ decision: "resume_existing", goal_label: "g1", task_decision: "resume_task", task_label: "g1/t1" }) },
    ]);
    const r2 = await queried.router.route("remember the thing from March?");
    const toolResult = queried.routerModel.requests[1]!.messages.at(-1)!;
    expect(toolResult).toMatchObject({ role: "tool", toolName: "ledger_query" });
    expect(toolResult.content).toContain("g1 Ongoing German learning · g1/t1 German Day 1");
    if (r2.kind !== "routed") throw new Error("expected routed");
    expect(r2.parts[0]!.goal.title).toBe("Ongoing German learning");
    expect(r2.parts[0]!.task.title).toBe("German Day 1");
  });

  it("caps ledger_query at three calls per routing decision", async () => {
    const { store } = setup();
    await exchange(store, "Review", createGoal("Socrates development", "Review"));
    const q = { toolCalls: [{ name: "ledger_query", input: { match: "anything" } }] };
    const { router, routerModel } = routerWith(store, [q, q, q, q, continueTask()]);
    await router.route("hmm");
    const fourth = routerModel.requests[4]!.messages.at(-1)!;
    expect(fourth.content).toContain("ledger_query_limit");
  });

  it("rejects a clarification without candidates and stores a constructive one outside every task", async () => {
    const { store } = setup();
    await exchange(store, "German", createGoal("Ongoing German learning", "Day 10 lesson"));
    await exchange(store, "Website", createGoal("Website X", "Checkout fix"));
    const ask = {
      question: "Yesterday you worked on two things — which should we continue with?",
      candidates: [
        { label: "Website X", detail: "checkout flow fix, most recent", suggested: true },
        { label: "German lessons", detail: "Day 10 lesson" },
      ],
      allow_new: true,
    };
    const { router, routerModel } = routerWith(store, [
      { toolCalls: [{ name: "ask_user", input: { question: "Which one?", candidates: [], allow_new: true } }] },
      { toolCalls: [{ name: "ask_user", input: ask }] },
    ]);
    const result = await router.route("Let's continue the project from yesterday.");
    expect(routerModel.requests[1]!.messages.at(-1)!.content).toContain("candidates must be non-empty");
    if (result.kind !== "clarify") throw new Error("expected clarify");
    expect(result.turn.kind).toBe("clarification");
    expect(result.text).toBe(
      "Yesterday you worked on two things — which should we continue with?\n" +
        "• Website X — checkout flow fix, most recent (suggested)\n" +
        "• German lessons — Day 10 lesson\n" +
        "• None of these — start something new",
    );

    // The answer re-enters routing: ask_user is withdrawn and the question is in recent history.
    const answer = routerWith(store, [
      { text: decision({ decision: "resume_existing", goal_label: "older_1", task_decision: "resume_task", task_label: "latest" }) },
    ]);
    const r2 = await answer.router.route("The German one.");
    const req = answer.routerModel.requests[0]!;
    expect(req.tools!.map((t) => t.name)).toEqual(["ledger_query"]);
    expect(req.messages[0]!.content).toContain("[routing clarification — not bound to any task]");
    expect(req.messages[0]!.content).toContain("<ROUTING_NOTE>");
    expect(r2.kind === "routed" && r2.parts[0]!.task.title).toBe("Day 10 lesson");
  });

  it("allows the zero-history clarify only when there is no activity", async () => {
    const { store } = setup();
    const { router } = routerWith(store, [
      { toolCalls: [{ name: "ask_user", input: { question: "No past sessions on this — start it as new work?", candidates: [], allow_new: true, zero_history: true } }] },
    ]);
    const result = await router.route("Continue the project from last week");
    expect(result.kind).toBe("clarify");
  });
});

describe("router context", () => {
  it("retrieves an older open goal for an elliptical message", async () => {
    const { store, clock } = setup("2026-08-20T10:00:00Z");
    const german = await exchange(store, "Start German", createGoal("Ongoing German learning", "German Day 9"), "ok", "Day 9 dative done.");
    if (german.kind !== "routed") throw new Error("expected routed");
    store.reviseGoalNote(german.parts[0]!.goal.id, "German lessons toward B1. Day 10 is next.");
    store.upsertAnchor({ goalId: german.parts[0]!.goal.id, path: "30-day-plan.md", role: "goal_plan", summary: "curriculum and lesson sequence" });
    clock.set("2026-09-01T10:00:00Z");
    await exchange(store, "Flashcards", createGoal("Build German flashcard exporter", "CSV export"));
    for (let i = 0; i < 3; i++) await exchange(store, `Site ${i}`, createGoal(`Website ${i}`, `Page ${i}`));

    const ctx = buildRoutingContext(store, "Okay, let's start today's lesson.", { timeZone: TZ });
    expect(ctx.goals.get("older_1")?.goal.title).toBe("Ongoing German learning");
    expect(ctx.input).toContain("- 30-day-plan.md — curriculum and lesson sequence");
    expect(ctx.input).toContain("- latest: German Day 9 — open; Day 9 dative done.");
  });

  it("keeps only complete exchanges within the history budget, oldest first, tagged with labels", async () => {
    const { store } = setup();
    await exchange(store, "first message", createGoal("Socrates development", "Review memory system"), "first answer");
    await exchange(store, "second message", continueTask(), "second answer");
    const ctx = buildRoutingContext(store, "third", { timeZone: TZ, historyBudgetTokens: 30 });
    expect(ctx.input).toContain("second message");
    expect(ctx.input).not.toContain("first message");
    expect(ctx.input).toContain("[goal=current · task=current · workspace=—]");
    const full = buildRoutingContext(store, "third", { timeZone: TZ });
    expect(full.input.indexOf("first message")).toBeLessThan(full.input.indexOf("second message"));
  });

  it("renders the activity notepad from the ledger", async () => {
    const { store, clock } = setup("2026-08-28T09:00:00Z");
    await exchange(store, "Payments", createGoal("Website X", "Payment provider integration"));
    clock.set("2026-09-01T14:02:00Z");
    await exchange(store, "Checkout", createTask("Checkout flow fix"), "ok", "Tests pass, staging deploy.");
    const ctx = buildRoutingContext(store, "hi", { timeZone: TZ });
    expect(ctx.input).toContain("Last 48 hours (detail):\n2026-09-01 14:02  —            Website X · Checkout flow fix (open) — Tests pass, staging deploy.");
    expect(ctx.input).toContain("Last 7 days (one line each):\n2026-08-28        —            Website X · Payment provider integration (open)");
  });
});
