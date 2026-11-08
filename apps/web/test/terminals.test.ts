import { describe, expect, it } from "vitest";
import { cameForward, fallback, groupByOwner, laneTone, ownerLine, ownerOf, terminalState } from "../src/lib/terminals";
import { strandTerminals } from "../src/lib/strands";
import type { TerminalView } from "../src/lib/types";

const MAIN = { by: "agent" as const, strand: "main" as const, lane: null, goal: "Demo site", goalNumber: 1, taskNumber: 1 };
const lane = (n: number, open = true) => ({ ...MAIN, strand: "lane" as const, lane: { id: `lane_${n}`, number: n, open } });
const YOU = { ...MAIN, by: "user" as const, strand: null };

const term = (id: string, over: Partial<TerminalView> = {}): TerminalView => ({
  id, name: id, command: "npm run dev", cwd: ".", task: null, owner: MAIN, watched: false, status: "running", exitCode: null, signal: null, reason: null,
  pty: false, background: true, ready: null, inputRequired: false, ports: [], cols: null, rows: null, startedAt: "", exitedAt: null, ...over,
});

describe("when the terminal panel comes forward", () => {
  it("not for the sessions a page finds when it opens", () => {
    expect(cameForward(null, [term("term-1"), term("term-2", { inputRequired: true })])).toBeNull();
  });

  it("for a session the agent has just started", () => {
    expect(cameForward([term("term-1")], [term("term-1"), term("term-2")])).toBe("term-2");
    // A command that had already ended by the time it was listed is not news.
    expect(cameForward([term("term-1")], [term("term-1"), term("term-2", { status: "exited" })])).toBeNull();
  });

  it("for one that has just begun to wait for input, ahead of a new one, and only once", () => {
    const before = [term("term-1"), term("term-2")];
    const after = [term("term-1"), term("term-2", { inputRequired: true }), term("term-3")];
    expect(cameForward(before, after)).toBe("term-2");
    expect(cameForward(after, after)).toBeNull();
  });
});

describe("which session the panel shows when its own is gone", () => {
  it("one waiting for input, else one running, else the newest", () => {
    expect(fallback([term("a", { status: "exited" }), term("b"), term("c", { inputRequired: true })])).toBe("c");
    expect(fallback([term("a", { status: "exited" }), term("b")])).toBe("b");
    expect(fallback([term("a", { status: "exited" }), term("b", { status: "exited" })])).toBe("b");
    expect(fallback([])).toBeNull();
  });

  it("reads each state for its tab", () => {
    expect(terminalState(term("a", { inputRequired: true }))).toBe("waiting");
    expect(terminalState(term("a", { status: "exited", reason: "terminated", signal: "SIGTERM" }))).toBe("stopped");
    expect(terminalState(term("a", { status: "exited", reason: "exited", exitCode: 1 }))).toBe("failed");
    expect(terminalState(term("a", { status: "exited", reason: "exited", exitCode: 0 }))).toBe("done");
  });
});

describe("whose a terminal is", () => {
  it("names your shells, main, each lane and a standard chat, each in its own tone", () => {
    expect(ownerOf(term("a", { owner: YOU }))).toMatchObject({ key: "you", label: "You", tone: "you" });
    expect(ownerOf(term("b", { task: "Dev server" }))).toMatchObject({ key: "main", label: "Main", detail: "Dev server", tone: "main" });
    expect(ownerOf(term("c", { owner: lane(2), task: "Server B" }))).toMatchObject({ key: "lane:lane_2", label: "Lane 2", detail: "Server B", tone: "2" });
    // Lane numbers keep growing; their colours repeat every four.
    expect(laneTone(5)).toBe("1");
    expect(ownerOf(term("d", { owner: { ...MAIN, strand: "chat", taskNumber: 4 }, task: "Fix login" }))).toMatchObject({ key: "chat:1/4", label: "Fix login" });
    expect(ownerLine(term("e", { owner: lane(3, false) }))).toBe("Started by Socrates in lane 3 (closed)");
    expect(ownerLine(term("f", { owner: YOU }))).toBe("Opened by you");
  });

  it("groups tabs by owner where each group's first terminal started, so groups never jump", () => {
    const list = [term("t1"), term("t2", { owner: lane(1) }), term("t3", { owner: YOU }), term("t4"), term("t5", { owner: lane(1) })];
    const groups = groupByOwner(list);
    expect(groups.map((g) => g.owner.label)).toEqual(["Main", "Lane 1", "You"]);
    expect(groups.flatMap((g) => g.terminals.map((t) => t.id))).toEqual(["t1", "t4", "t2", "t5", "t3"]);
  });

  it("finds the running terminals a strand chip counts", () => {
    const list = [term("t1"), term("t2", { owner: lane(1) }), term("t3", { owner: lane(1), status: "exited" }), term("t4", { owner: YOU })];
    expect(strandTerminals({ conversation: "lane_1" }, list).map((t) => t.id)).toEqual(["t2"]);
    expect(strandTerminals({ conversation: "main" }, list).map((t) => t.id)).toEqual(["t1"]);
  });
});
