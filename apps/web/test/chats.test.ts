import { describe, expect, it } from "vitest";
import { chatThread, groupChats, newThread } from "../src/lib/chats";
import type { Exchange } from "../src/lib/model";
import type { GoalView } from "../src/lib/types";

const goal = (number: number, title: string, tasks: ([number, string] | [number, string, number])[], general = false): GoalView => ({ number, title, objective: null, note: null, status: "open", general, workspace: null, tasks: tasks.map(([n, t, chats]) => ({ number: n, title: t, ...(chats ? { chats } : {}), status: "open", note: null })) });
const ex = (key: string, at: string, route: [number, number] | [number, number, number] | null, state: Exchange["state"] = "done"): Exchange => ({ key, at, state, route: route && { goal: { number: route[0], title: `g${route[0]}` }, task: { number: route[1], title: `t${route[1]}` }, ...(route[2] ? { chat: route[2] } : {}) } }) as Exchange;

describe("the chats of each goal", () => {
  const goals = [goal(0, "General", [[1, "x"]], true), goal(1, "Resume", [[1, "Critique"], [2, "Rewrite"]]), goal(2, "Explore", [[1, "Folders"]])];

  it("puts the goal and chat worked on last first, and leaves out general conversation", () => {
    const list = [ex("m1", "2026-10-05T09:00:00Z", [1, 1]), ex("m2", "2026-10-06T09:00:00Z", [2, 1]), ex("m3", "2026-10-06T10:00:00Z", [1, 2], "working")];
    const grouped = groupChats(goals, list);
    expect(grouped.map((g) => g.title)).toEqual(["Resume", "Explore"]);
    expect(grouped[0]?.chats.map((c) => c.title)).toEqual(["Rewrite", "Critique"]);
    expect(grouped[0]?.working).toBe(true);
    expect(grouped[1]?.working).toBe(false);
  });

  it("marks the goal that holds the plain chats", () => {
    const withChats = [...goals, { ...goal(3, "Chats", [[1, "Quick question"]]), chats: true }];
    expect(groupChats(withChats, []).map((g) => [g.title, g.plain])).toEqual([["Chats", true], ["Explore", false], ["Resume", false]]);
  });

  it("keeps newest-made first for a chat nothing was asked in since loading", () => {
    expect(groupChats(goals, [])[0]?.title).toBe("Explore");
    expect(groupChats(goals, [])[1]?.chats.map((c) => c.title)).toEqual(["Rewrite", "Critique"]);
  });
});

describe("a long task that continued in a new chat", () => {
  const goals = [goal(1, "Site", [[1, "Fix the header", 3], [2, "Write copy"]])];
  const list = [ex("m1", "2026-10-06T09:00:00Z", [1, 1, 1]), ex("m2", "2026-10-06T10:00:00Z", [1, 1, 2]), ex("m3", "2026-10-06T11:00:00Z", [1, 1])];

  it("lists each chat of the chain, named after the task, in order", () => {
    const [site] = groupChats(goals, list);
    expect(site?.chats.map((c) => [c.title, c.chat])).toEqual([["Fix the header", 1], ["Fix the header — continued", 2], ["Fix the header — continued (3)", 3], ["Write copy", 1]]);
    expect(site?.chats[1]?.at).toBe("2026-10-06T10:00:00Z");
  });

  it("keeps each chat's questions to itself, and treats a question without a chat as the first", () => {
    expect(chatThread(list, 1, 1, 2).map((e) => e.key)).toEqual(["m2"]);
    expect(chatThread(list, 1, 1, 1).map((e) => e.key)).toEqual(["m1", "m3"]);
  });
});

describe("one chat's questions", () => {
  const list = [ex("m1", "a", [1, 1]), ex("m2", "b", [2, 1]), ex("m3", "c", [1, 1]), ex("m4", "d", null, "sending")];

  it("holds its own questions and an unrouted one sent after them", () => {
    expect(chatThread(list, 1, 1).map((e) => e.key)).toEqual(["m1", "m3", "m4"]);
    expect(chatThread(list, 2, 1).map((e) => e.key)).toEqual(["m2", "m4"]);
  });

  it("starts empty for a new chat, then holds what is asked", () => {
    expect(newThread(list, "m4")).toEqual([]);
    expect(newThread([...list, ex("m5", "e", null, "sending")], "m4").map((e) => e.key)).toEqual(["m5"]);
    expect(newThread(list, null)).toHaveLength(4);
  });
});
