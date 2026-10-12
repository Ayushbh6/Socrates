import { describe, expect, it } from "vitest";
import { countTokens, eventTime } from "@socrates/shared";
import { exchange, general } from "../../router/test/helpers";
import { assembleContext, generalHistoryParts } from "../src";
import { renderActivity } from "@socrates/router";
import { final, contextText, world } from "./helpers";

async function days() {
  const w = await world();
  w.clock.set("2026-10-09T00:49:00+02:00");
  const friday = await exchange(w.store, "Please test the terminal", general(), "Blocked by missing folder.", "Initial request blocked.");
  w.clock.set("2026-10-10T15:03:00+02:00");
  const saturday = await exchange(w.store, "Try again", general(), "Test passed, exit code 0.", "Test completed; nothing pending.");
  if (friday.kind !== "routed" || saturday.kind !== "routed") throw new Error("fixture");
  w.clock.set("2026-10-11T12:10:13+02:00");
  return { w, friday: friday.parts[0]!.turn, saturday: saturday.parts[0]!.turn };
}

describe("daily General continuity", () => {
  it("passes chronological earlier days to Flow and Standard without project or duplicate carryover", async () => {
    const { w, friday, saturday } = await days();
    const { socrates, model } = w.socrates([general()], [final(), final()]);
    await socrates.handle("Hello Sunday");
    const first = contextText(model.requests[0]!);
    expect(first).toContain("Blocked by missing folder.");
    expect(first).toContain("Test passed, exit code 0.");
    expect(first.indexOf("Please test the terminal")).toBeLessThan(first.indexOf("Try again"));
    expect(first).toContain("2026-10-08T22:49"); expect(first).toContain("2026-10-10T");
    expect(first).not.toContain("Start the project work.");
    const task = w.store.requireTask(saturday.taskId!); const goal = w.store.requireGoal(task.goalId);
    await socrates.handle("A Standard follow-up", { target: { taskId: task.id }, contextFromTask: task.id });
    const second = contextText(model.requests[1]!);
    expect(second).toContain("Test passed, exit code 0.");
    expect(second).not.toContain("CONTINUED_GENERAL_CONTEXT");
    expect(second.match(/### USER_REQUEST\n```text\nPlease test the terminal/g)).toHaveLength(1);
    expect(first).toContain(`turn_number ${friday.projectTurn}`);
  });

  it("bounds large exchanges, excludes unfinished/current and omitted spans, and gives retrieval references", async () => {
    const { w, saturday } = await days();
    const task = w.store.requireTask(saturday.taskId!);
    w.store.completeTurn(w.store.bindTurn({ userEventId: w.store.recordUserMessage("huge " + "x ".repeat(25000)).id, taskId: task.id, route: "general" }).id, { responseEventId: w.store.recordResponse("Large exact response " + "y ".repeat(25000)).id });
    const unfinished = w.store.bindTurn({ userEventId: w.store.recordUserMessage("unfinished secret").id, taskId: task.id, route: "general" });
    const current = w.store.bindTurn({ userEventId: w.store.recordUserMessage("current secret").id, taskId: task.id, route: "general" });
    const history = generalHistoryParts(w.store, current, "Europe/Vienna");
    const text = history.parts.map(p => p.text).join("");
    expect(countTokens(text)).toBeLessThanOrEqual(30000);
    expect(text).toContain("EXCERPT"); expect(text).toContain("retrieve_ref: turn_number");
    expect(text).not.toContain("unfinished secret"); expect(text).not.toContain("current secret");
    expect(history.included).not.toContain(unfinished.projectTurn);
    w.store.recordOmission({ goal_id: task.goalId, task_id: task.id, chat_id: current.chatId!, turn_id: current.id }, { from: saturday.projectTurn, to: current.projectTurn - 1 });
    const rebuilt = generalHistoryParts(w.store, current, "Europe/Vienna");
    expect(rebuilt.parts.map(p => p.text).join("")).not.toContain("Large exact response");
  });

  it("keeps history and stable instructions byte-identical when only time changes", async () => {
    const { w, saturday } = await days();
    const turn = w.store.bindTurn({ userEventId: w.store.recordUserMessage("Hello").id, taskId: saturday.taskId!, route: "general" });
    const base = { store: w.store, turn, capabilities: { skills: [], mcpTools: [] }, dependsOn: [], part: null, timeZone: "Europe/Vienna" };
    const first = assembleContext({ ...base, now: new Date("2026-10-11T10:10:13Z") });
    const next = assembleContext({ ...base, now: new Date("2026-10-11T10:11:13Z") });
    expect(first.slice(0, -1)).toEqual(next.slice(0, -1));
    expect(first.at(-1)?.text).toContain("2026-10-11T12:10:13+02:00");
    expect(next.at(-1)?.text).toContain("2026-10-11T12:11:13+02:00");
    const activity = renderActivity(w.store, w.clock.now(), "Europe/Vienna", turn.userEventId);
    expect(activity).not.toContain(`turn_number ${turn.projectTurn} |`);
    expect(activity).toContain("chat/task open; execution completed");
    expect(activity).toContain("requested Saturday 2026-10-10 15:03:00 Europe/Vienna");
  });
});


it("excludes set-aside General attempts after Redo while preserving exact retrieval", async () => {
  const { w } = await days();
  const { socrates, model } = w.socrates([general(), general()], [final({ full_answer: "WRONG_GENERAL_ANSWER" }), final(), final()]);
  const first = await socrates.handle("Put this in a project");
  if (first.kind !== "answered") throw Error("fixture");
  const original = first.parts[0]!.turn;
  await socrates.handle("Put this in a project", { target: { taskId: w.taskId }, pinned: true, redoOf: original.id });
  await socrates.handle("Hello again");
  expect(contextText(model.requests.at(-1)!)).not.toContain("WRONG_GENERAL_ANSWER");
  expect(w.store.getEvent(original.responseEventId!)?.payload).toMatchObject({ text: "WRONG_GENERAL_ANSWER" });
});


it("labels weekdays and local times across midnight and the Vienna daylight-saving transition", () => {
  expect(eventTime("2026-10-08T22:49:02.594Z", "Europe/Vienna")).toBe("Friday 2026-10-09 00:49:02 Europe/Vienna (UTC 2026-10-08T22:49:02.594Z)");
  expect(eventTime("2026-10-10T13:05:41.009Z", "Europe/Vienna")).toContain("Saturday 2026-10-10 15:05:41");
  expect(eventTime("2026-10-25T00:30:00Z", "Europe/Vienna")).toContain("Sunday 2026-10-25 02:30:00");
  expect(eventTime("2026-10-25T01:30:00Z", "Europe/Vienna")).toContain("Sunday 2026-10-25 02:30:00");
});
