import { describe, expect, it } from "vitest";
import { describeCall, describeResult, diffCounts } from "../src/calls";

const words = (tool: string, input: unknown) => {
  const c = describeCall(tool, input);
  return [c.verb, c.target, c.detail].filter(Boolean).join(" ");
};
const ok = (result: unknown, content = "") => ({ status: "ok" as const, content, result, error: null, wall_time_ms: 1200 });

describe("tool calls in plain words", () => {
  it("names each call by what it does, never by its JSON", () => {
    expect(words("read", { path: "src/app.ts" })).toBe("Read src/app.ts");
    expect(words("read", { path: "src/app.ts", offset: 80 })).toBe("Read src/app.ts from line 80");
    expect(words("grep", { pattern: "onText", path: "src", type: "ts" })).toBe("Searched for onText in src in ts files");
    expect(words("glob", { pattern: "**/*.tsx" })).toBe("Listed files matching **/*.tsx");
    expect(words("edit", { path: "a.ts", edits: [{}, {}] })).toBe("Edited a.ts 2 changes");
    expect(words("apply_patch", { patch: "*** Begin Patch\n*** Add File: b.ts\n+x\n*** End Patch" })).toBe("Created b.ts");
    expect(words("apply_patch", { patch: "*** Update File: a.ts\n*** Update File: b.ts\n*** Delete File: c.ts" })).toBe("Edited a.ts and 2 more files");
    expect(words("terminal", { command: "npm test" })).toBe("Ran npm test");
    expect(words("terminal", { command: "npm run dev", background: true, name: "web" })).toBe("Started npm run dev in the background as web");
    expect(words("terminal", { command: "cat <<EOF\nlong\nEOF", cwd: "app" })).toBe("Ran cat <<EOF … in app");
    expect(words("terminal", { command: "npm test", cwd: "/Users/me/work/shop/" })).toBe("Ran npm test in shop");
    expect(describeCall("terminal", { command: "npm test" }).active).toBe("Running");
  });

  it("says what was typed and pressed in a terminal, and what a wait waits for", () => {
    expect(words("terminal_control", { action: "write", terminal: "configure", input: "shop", submit: true })).toBe("Typed shop in configure and pressed Enter");
    expect(words("terminal_control", { action: "write", terminal: "configure", input: "a", submit: false })).toBe("Typed a in configure");
    expect(words("terminal_control", { action: "write", terminal: "vite", keys: ["DOWN", "DOWN", "DOWN", "ENTER"] })).toBe("Pressed Down ×3, Enter in vite");
    expect(words("terminal_control", { action: "write", terminal: "dev", keys: ["CTRL_C"] })).toBe("Pressed Ctrl-C in dev");
    expect(words("terminal_control", { action: "wait", terminal: "configure", event: "exit" })).toBe("Waited for configure to finish");
    expect(words("terminal_control", { action: "wait", terminal: "dev", event: "pattern", pattern: "ready" })).toBe('Waited for dev to print "ready"');
    expect(words("terminal_control", { action: "wait", terminals: ["web", "api", "docs"], event: "exit" })).toBe("Waited for web, api, docs to finish");
    expect(words("terminal_control", { action: "wait", terminal: "web", event: "port_open", port: 5173 })).toBe("Waited for web to open port 5173");
    expect(words("terminal_control", { action: "wait", terminal: "web", event: "idle" })).toBe("Waited for web to go quiet");
    expect(words("terminal_control", { action: "screen", terminal: "shadcn" })).toBe("Looked at the screen of shadcn");
    expect(words("terminal_control", { action: "wait", terminal: "setup", event: "input_required" })).toBe("Waited for setup to ask for input");
    expect(words("terminal_control", { action: "terminate", terminal: "dev" })).toBe("Stopped dev");
    expect(words("terminal_control", { action: "resize", terminal: "dev", cols: 100, rows: 30 })).toBe("Resized dev to 100×30");
  });

  it("names memory, capability and MCP calls", () => {
    expect(words("context_retrieve", { action: "search", query: "login bug" })).toBe("Looked back for login bug");
    expect(words("context_retrieve", { action: "memory", query: "Berlin trip" })).toBe("Recalled what it remembers about Berlin trip");
    expect(words("context_retrieve", { action: "memory" })).toBe("Recalled what it remembers");
    expect(words("capability_control", { action: "activate", ref: "c2" })).toBe("Turned on c2");
    expect(describeCall("playwright.browser_navigate", { url: "http://localhost:5173" })).toMatchObject({ kind: "other", verb: "Used", target: "playwright.browser_navigate", detail: "http://localhost:5173" });
  });
});

describe("tool results in plain words", () => {
  it("shows a command's output, its end first kept, and how it ended", () => {
    expect(describeResult("terminal", ok({ status: "completed", exit_code: 1, output: "FAIL a.test.ts\n" }))).toMatchObject({ summary: "exit 1", preview: "FAIL a.test.ts\n", truncated: false, ms: 1200 });
    expect(describeResult("context_retrieve", ok({ action: "memory", memories: [{ ref: "m1", text: "Trip in March." }] }))).toMatchObject({ summary: "1 memory", preview: "m1: Trip in March." });
    expect(describeResult("context_retrieve", ok({ action: "memory", memories: [] })).summary).toBe("nothing remembered");
    const long = `${"x".repeat(3000)}\nlast line\n`;
    expect(describeResult("terminal", ok({ status: "completed", exit_code: 0, output: long }))).toMatchObject({ preview: expect.stringMatching(/^x+\nlast line\n$/), truncated: true });
    expect(describeResult("terminal", ok({ status: "running", terminal: "web", ready: true, output: "" })).summary).toBe("running, ready");
    expect(describeResult("terminal_control", ok({ action: "wait", status: "running", input_required: true, output: "Port? " }))).toMatchObject({ summary: "waiting for input", preview: "Port? " });
  });

  it("marks every failure the same way: a failed call, and a command that exited non-zero, timed out or crashed", () => {
    expect(describeResult("read", { status: "error", content: "", result: null, error: { message: "No such file.", correction: "" } }).failed).toBe(true);
    expect(describeResult("terminal", ok({ status: "completed", exit_code: 1, output: "" })).failed).toBe(true);
    expect(describeResult("terminal", ok({ status: "timed_out", output: "" })).failed).toBe(true);
    expect(describeResult("terminal_control", ok({ action: "wait", event: "exit", status: "exited", signal: "SIGSEGV", output: "" })).failed).toBe(true);
    expect(describeResult("terminal", ok({ status: "completed", exit_code: 0, output: "" })).failed).toBe(false);
    expect(describeResult("terminal", ok({ status: "running", terminal: "web", output: "" })).failed).toBe(false);
    // Stopping a server on purpose, or a wait that ran out of time while the command goes on, is no failure.
    expect(describeResult("terminal_control", ok({ action: "terminate", status: "exited", signal: "SIGTERM", output: "" })).failed).toBe(false);
    expect(describeResult("terminal_control", ok({ action: "read", status: "exited", exit_code: 1, output: "" })).failed).toBe(false);
    expect(describeResult("terminal_control", ok({ action: "wait", event: "timeout", status: "running", output: "" })).failed).toBe(false);
    expect(describeResult("edit", ok({ path: "a.ts", diff: "" })).failed).toBe(false);
  });

  it("shows an edit as its diff with counts, and says when it created the file", () => {
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n same\n";
    expect(diffCounts(diff)).toEqual({ added: 2, removed: 1 });
    expect(describeResult("edit", ok({ path: "a.ts", diff }))).toMatchObject({ summary: "+2 −1", diff, verb: null });
    expect(describeResult("edit", ok({ path: "n.ts", created: true, diff: "+++ b/n.ts\n+x\n" }))).toMatchObject({ summary: "+1 −0", verb: "Created" });
  });

  it("counts searches and files, and shows matches as path:line", () => {
    const matches = [{ path: "a.ts", line_number: 3, text: "onText()" }, { path: "a.ts", line_number: 9, text: "onText" }, { path: "b.ts", line_number: 1, text: "x" }];
    expect(describeResult("grep", ok({ output: "content", matches, truncated: false }))).toMatchObject({ summary: "3 matches in 2 files", preview: "a.ts:3: onText()\na.ts:9: onText\nb.ts:1: x" });
    expect(describeResult("grep", ok({ output: "files", files: [], truncated: false })).summary).toBe("no matches");
    expect(describeResult("glob", ok({ matches: ["a.ts"], truncated: true })).summary).toBe("1+ files");
    expect(describeResult("read", ok({ path: "a.ts", lines: [{}, {}], total_lines: 10 }, "a.ts — lines 1–2 of 10")).summary).toBe("2 of 10 lines");
  });

  it("shows a failure as its message and correction", () => {
    const failed = describeResult("edit", { status: "error", content: "{}", result: null, error: { message: "old_text was not found in a.ts.", correction: "Read a.ts again." }, wall_time_ms: 3 });
    expect(failed).toMatchObject({ summary: "failed", preview: "old_text was not found in a.ts.\nRead a.ts again." });
  });
});
