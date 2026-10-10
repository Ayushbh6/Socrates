import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { continueTask } from "../../router/test/helpers";
import { call, final, world } from "./helpers";

/** The JSON examples of agent-harness.md's `memory` section of context_retrieve, in order. */
function documented(): unknown[] {
  const doc = readFileSync(new URL("../../../architecture/agent-harness.md", import.meta.url), "utf8");
  const section = doc.slice(doc.indexOf("#### `memory` — what is remembered about the user"), doc.indexOf("### Conditional capabilities"));
  return [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!));
}

describe("the documented memory action", () => {
  it("returns exactly what agent-harness.md shows", async () => {
    const [searchInput, searchOutput, emptyOutput, inspectInput, inspectOutput] = documented();
    const w = await world();
    const said = w.store.turnsForTask(w.taskId).at(-1)!;
    const refs = { goal_id: w.goalId, task_id: w.taskId, chat_id: said.chatId, turn_id: said.id };
    // m1 is always on (in <MEMORY>), so the action never repeats it; m4 belongs to another goal.
    w.store.saveMemory({ kind: "preference", goalId: null, text: "Prefers pnpm over npm.", by: "agent" }, refs);
    w.store.saveMemory({ kind: "knowledge", goalId: null, text: "The Berlin trip is from 14 to 18 March.", by: "agent" }, refs);
    w.store.saveMemory({ kind: "knowledge", goalId: w.goalId, text: "Flights for the Berlin trip leave Vienna at 7:10.", by: "user" });
    w.store.saveMemory({ kind: "knowledge", goalId: w.store.createGoal({ title: "Other" }).id, text: "The other Berlin trip plan.", by: "user" });
    const { socrates, model } = w.socrates([continueTask()], [
      { toolCalls: [call("context_retrieve", searchInput), call("context_retrieve", { action: "memory", query: "dentist" }), call("context_retrieve", inspectInput)] },
      final(),
    ]);
    await socrates.handle("What do you remember about the trip?");
    const results = model.requests[1]!.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content as string));
    expect(results).toEqual([searchOutput, emptyOutput, inspectOutput]);
  });
});
