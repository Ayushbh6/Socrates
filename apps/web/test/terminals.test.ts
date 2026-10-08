import { describe, expect, it } from "vitest";
import { cameForward, fallback, terminalState } from "../src/lib/terminals";
import type { TerminalView } from "../src/lib/types";

const term = (id: string, over: Partial<TerminalView> = {}): TerminalView => ({
  id, name: id, command: "npm run dev", cwd: ".", task: null, status: "running", exitCode: null, signal: null, reason: null,
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
