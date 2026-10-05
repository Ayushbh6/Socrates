import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { forgetProcess, processStart, reapLeftovers, recordProcess } from "../src/process-registry";
import { TerminalText, loadPty } from "../src/pty";
import { TerminalSupervisor, commandEnvironment, settles } from "../src/terminals";
import { harness, tempDir } from "./helpers";

const hasPty = loadPty() !== null;
const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("terminal output as plain text", () => {
  it("removes colours and cursor movement, turns progress redraws into lines, and applies backspaces", () => {
    const t = new TerminalText();
    expect(t.push("\x1b[32mok\x1b[0m done\r\n")).toBe("ok done\n");
    expect(t.push("\x1b]0;title\x07Loading 10%\rLoading 90%\r\n")).toBe("Loading 10%\nLoading 90%\n");
    expect(t.push("abc\x08\x08d\n")).toBe("ad\n");
    expect(t.push("\x1b[?25l\x1b[2K\x1b[1Ghidden cursor\n")).toBe("hidden cursor\n");
  });

  it("holds a sequence or a carriage return split between chunks until the rest arrives", () => {
    const t = new TerminalText();
    expect(t.push("red: \x1b[3")).toBe("red: ");
    expect(t.push("1mR\x1b[0m\r")).toBe("R");
    expect(t.push("\nnext")).toBe("\nnext");
    expect(t.push("\x1b")).toBe("");
    expect(t.flush()).toBe("");
  });
});

describe.skipIf(!hasPty)("pseudo-terminal sessions", () => {
  it("answers a prompt: the session says it waits for input, and Enter submits", async () => {
    const h = harness();
    const r = await h.call("terminal", { command: 'read -p "Name? " n; printf "\\033[1mhi %s\\033[0m\\n" "$n"', pty: true, name: "ask", yield_ms: 1500 });
    expect(r.json).toMatchObject({ status: "running", terminal: "ask", pty: true, input_required: true, output: "Name? " });
    expect((await h.call("terminal_control", { action: "list" })).json.terminals[0]).toMatchObject({ terminal: "ask", input_required: true });
    await h.call("terminal_control", { action: "write", terminal: "ask", input: "Ada" });
    const done = await h.call("terminal_control", { action: "wait", terminal: "ask", event: "exit" });
    expect(done.json).toMatchObject({ event: "exit", exit_code: 0 });
    // The typed text is echoed, as in any terminal, and the colours are gone.
    expect(done.json.output).toBe("Ada\nhi Ada\n");
  });

  it("waits until a program asks for input", async () => {
    const h = harness();
    await h.call("terminal", { command: 'sleep 1; read -p "Continue? [y/N] " a; echo "got $a"', pty: true, background: true, name: "later" });
    const waited = await h.call("terminal_control", { action: "wait", terminal: "later", event: "input_required" });
    expect(waited.json).toMatchObject({ event: "input_required", input_required: true, output: "Continue? [y/N] " });
    await h.call("terminal_control", { action: "write", terminal: "later", input: "y" });
    expect((await h.call("terminal_control", { action: "wait", terminal: "later", event: "exit" })).json.output).toContain("got y");
  });

  it("ends any wait when the program asks for input, instead of waiting out the deadline", async () => {
    const h = harness();
    await h.call("terminal", { command: 'sleep 0.5; read -p "Project name? " n; echo "made $n"', pty: true, background: true, name: "wizard" });
    const started = Date.now();
    const asked = await h.call("terminal_control", { action: "wait", terminal: "wizard", event: "exit" });
    expect(asked.json).toMatchObject({ event: "input_required", input_required: true, output: "Project name? " });
    expect(Date.now() - started).toBeLessThan(5_000);
    await h.call("terminal_control", { action: "write", terminal: "wizard", input: "shop" });
    expect((await h.call("terminal_control", { action: "wait", terminal: "wizard", event: "exit" })).json).toMatchObject({ event: "exit", exit_code: 0 });
  });

  it("knows a menu is waiting, which hides the cursor, even though its last line is finished", async () => {
    const h = harness();
    await h.call("terminal", { command: `printf '\\033[?25l'; printf 'Select a framework\\n> Vue\\n  React\\n'; sleep 30`, pty: true, background: true, name: "menu" });
    const asked = await h.call("terminal_control", { action: "wait", terminal: "menu", event: "exit" });
    expect(asked.json).toMatchObject({ event: "input_required", input_required: true });
    expect(asked.json.output).toContain("Select a framework");
    await h.call("terminal_control", { action: "terminate", terminal: "menu" });
    // Once the program shows the cursor again, it is not waiting for a key.
    await h.call("terminal", { command: `printf '\\033[?25lbusy\\n'; printf '\\033[?25hdone\\n'; sleep 30`, pty: true, background: true, name: "quiet" });
    await new Promise((done) => setTimeout(done, 1_200));
    expect((await h.call("terminal_control", { action: "list" })).json.terminals.find((t: { terminal: string }) => t.terminal === "quiet")).toMatchObject({ input_required: false });
    await h.call("terminal_control", { action: "terminate", terminal: "quiet" });
  });

  it("sends keys as a keyboard does, and CTRL_C interrupts the foreground program", async () => {
    const h = harness();
    // Keys sent before the program switches the terminal to raw input would wait in the line buffer.
    await h.call("terminal", { command: "stty -icanon -echo; echo ready; dd bs=1 count=6 2>/dev/null | od -An -tx1", pty: true, background: true, name: "keys" });
    await h.call("terminal_control", { action: "wait", terminal: "keys", event: "pattern", pattern: "ready" });
    await h.call("terminal_control", { action: "write", terminal: "keys", keys: ["UP", "TAB", "ESCAPE", "BACKSPACE"] });
    const keys = await h.call("terminal_control", { action: "wait", terminal: "keys", event: "exit" });
    expect(keys.json.output.trim().split(/\s+/).join(" ")).toBe("1b 5b 41 09 1b 7f");
    await h.call("terminal", { command: "echo started; sleep 30", pty: true, background: true, name: "sleeper" });
    await h.call("terminal_control", { action: "wait", terminal: "sleeper", event: "pattern", pattern: "started" });
    await h.call("terminal_control", { action: "write", terminal: "sleeper", keys: ["CTRL_C"] });
    const stopped = await h.call("terminal_control", { action: "wait", terminal: "sleeper", event: "exit" });
    expect(stopped.json.signal === "SIGINT" || stopped.json.exit_code === 130).toBe(true);
  });

  it("starts at 120×40 and can be resized", async () => {
    const h = harness();
    await h.call("terminal", { command: "while read -r line; do stty size; done", pty: true, background: true, name: "size" });
    await h.call("terminal_control", { action: "write", terminal: "size", input: "a" });
    expect((await h.call("terminal_control", { action: "wait", terminal: "size", event: "pattern", pattern: "40 120" })).json.event).toBe("pattern");
    expect((await h.call("terminal_control", { action: "resize", terminal: "size", cols: 100, rows: 30 })).json).toMatchObject({ accepted: true, cols: 100, rows: 30 });
    await h.call("terminal_control", { action: "write", terminal: "size", input: "b" });
    expect((await h.call("terminal_control", { action: "wait", terminal: "size", event: "pattern", pattern: "30 100" })).json.event).toBe("pattern");
    await h.call("terminal_control", { action: "terminate", terminal: "size" });
  });
});

describe("what a running call shows the user", () => {
  it("sends a waiting command's newest output as it prints, by the call's handle, and nothing after its result", async () => {
    const h = harness();
    const seen: { handle: string; output: string }[] = [];
    const onOutput = (handle: string, output: string) => seen.push({ handle, output });
    const r = await h.call("terminal", { command: 'echo "step one"; sleep 0.5; echo "step two"; sleep 0.5', yield_ms: 5000 }, { onOutput });
    expect(r.json).toMatchObject({ status: "completed", exit_code: 0 });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((s) => s.handle === r.handle)).toBe(true);
    expect(seen[0]!.output).toBe("step one\n");
    expect(seen.at(-1)!.output).toBe("step one\nstep two\n");
    const count = seen.length;
    await new Promise((done) => setTimeout(done, 400));
    expect(seen).toHaveLength(count);

    // A wait shows only what the agent has not read yet.
    await h.call("terminal", { command: 'echo "ready"; sleep 0.4; echo "compiling"; sleep 0.6; echo "built"; sleep 30', background: true, name: "dev" });
    const waits: string[] = [];
    const waited = await h.call("terminal_control", { action: "wait", terminal: "dev", event: "pattern", pattern: "built" }, { onOutput: (_, output) => waits.push(output) });
    expect(waited.json).toMatchObject({ event: "pattern" });
    expect(waits.some((o) => o.endsWith("compiling\n"))).toBe(true);
    await h.call("terminal_control", { action: "terminate", terminal: "dev" });
  });
});

describe("terminal output and Unicode", () => {
  const source = "é🙂中".repeat(20_000);
  const script = `process.stdout.write(${JSON.stringify("é🙂中")}.repeat(20000))`;

  it("never splits a character when cutting long output to its beginning and end", async () => {
    const h = harness();
    const r = await h.call("terminal", { command: `node -e '${script}'` });
    expect(r.json.truncated).toBe(true);
    expect(r.json.output).not.toMatch(lonely);
    expect(r.json.output).not.toContain("�");
    expect(r.json.output.startsWith("é🙂中é🙂中")).toBe(true);
  });

  it("pages retained output without losing or splitting a character, and filters lines", async () => {
    const h = harness();
    await h.call("terminal", { command: `node -e '${script};process.stdout.write("<END>");setTimeout(()=>{},30000)'`, background: true, name: "wide" });
    await h.call("terminal_control", { action: "wait", terminal: "wide", event: "pattern", pattern: "<END>" });
    let cursor = "c0";
    let output = "";
    for (let i = 0; i < 40; i++) {
      const page = await h.call("terminal_control", { action: "read", terminal: "wide", cursor });
      expect(page.json.output).not.toMatch(lonely);
      output += page.json.output;
      cursor = page.json.cursor;
      if (!page.json.truncated) break;
    }
    expect(output).toBe(`${source}<END>`);

    await h.call("terminal", { command: 'for i in 1 2 3 4 5; do echo "ok $i"; [ $i = 3 ] && echo "ERROR disk full"; done; echo "ERROR again"; sleep 30', background: true, name: "log" });
    await h.call("terminal_control", { action: "wait", terminal: "log", event: "pattern", pattern: "again" });
    const errors = await h.call("terminal_control", { action: "read", terminal: "log", cursor: "c0", filter: "^ERROR" });
    expect(errors.json).toMatchObject({ filter: "^ERROR", output: "ERROR disk full\nERROR again\n", truncated: false });
    const two = await h.call("terminal_control", { action: "read", terminal: "log", cursor: "c0", filter: "^ok", limit_lines: 2 });
    expect(two.json).toMatchObject({ output: "ok 1\nok 2\n", truncated: true });
    expect((await h.call("terminal_control", { action: "read", terminal: "log", cursor: two.json.cursor, filter: "^ok" })).json.output).toBe("ok 3\nok 4\nok 5\n");
  });
});

describe.skipIf(process.platform === "win32")("process groups left by a crash", () => {
  const group = () => {
    const child = spawn("/bin/sh", ["-c", "sleep 60 & sleep 60"], { detached: true, stdio: "ignore" });
    child.unref();
    return child.pid!;
  };
  const alive = (pid: number) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("lists each session's process group while it runs and forgets it when it ends", async () => {
    const registry = path.join(tempDir(), "terminals.json");
    const supervisor = new TerminalSupervisor({ registry });
    const session = supervisor.launch({ command: "sleep 30", cwd: tempDir(), cwdRel: ".", env: commandEnvironment(), timeoutMs: null, background: true, name: null, ready: null }, { onStart: () => {}, onExit: () => {} });
    expect(JSON.parse(readFileSync(registry, "utf8"))).toEqual([expect.objectContaining({ pid: session.proc!.pid, command: "sleep 30" })]);
    await supervisor.terminate(session);
    await settles(session, 2000);
    expect(JSON.parse(readFileSync(registry, "utf8"))).toEqual([]);
    await supervisor.shutdown();
  });

  it("stops groups a crashed server left running, but never a reused process id", async () => {
    const registry = path.join(tempDir(), "terminals.json");
    const left = group();
    recordProcess(registry, left, "sleep 60");
    const stranger = group();
    recordProcess(registry, stranger, "sleep 60");
    // The stranger's id now names a different process: its recorded start time no longer matches.
    const entries = JSON.parse(readFileSync(registry, "utf8"));
    entries[1].started = "Thu Jan  1 00:00:00 1970";
    (await import("node:fs")).writeFileSync(registry, JSON.stringify(entries));
    expect(processStart(left)).not.toBeNull();
    expect(reapLeftovers(registry)).toBe(1);
    await new Promise((done) => setTimeout(done, 200));
    expect(alive(left)).toBe(false);
    expect(alive(stranger)).toBe(true);
    expect(JSON.parse(readFileSync(registry, "utf8"))).toEqual([]);
    process.kill(-stranger, "SIGKILL");
    forgetProcess(registry, stranger);
  });
});
