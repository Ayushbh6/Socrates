import { describe, expect, it } from "vitest";
import { loadPty } from "../src/pty";
import { TerminalSupervisor, sleep } from "../src/terminals";
import { harness } from "./helpers";

const hasPty = loadPty() !== null;

/** A prompt that asks for a name and greets it. */
const PROMPT = `
process.stdout.write("\\x1b[32mready\\x1b[0m\\r\\nName? ");
process.stdin.setRawMode(true);
let name = "";
process.stdin.on("data", (d) => {
  for (const c of d.toString()) {
    if (c === "\\r") { process.stdout.write("\\r\\nhi " + name + "\\r\\n"); setTimeout(() => process.exit(0), 50); return; }
    name += c;
    process.stdout.write(c);
  }
});
`;

/** Collect what a session shows a page: its replay, then what follows. */
function watcher() {
  const seen = { replay: null as string | null, after: "" };
  const replay = (data: string) => { seen.replay = data; };
  const data = (chunk: string) => { seen.after += chunk; };
  return { seen, replay, data };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

describe.skipIf(!hasPty)("a terminal the page watches and types into", () => {
  it("replays what is on the screen, streams the rest, takes the user's typing, and holds the agent off meanwhile", async () => {
    const h = harness({ files: { "prompt.js": PROMPT } });
    await h.call("terminal", { command: "node prompt.js", pty: true, background: true, name: "ask", yield_ms: 800 });
    const { supervisor, session } = h.runner.terminalSessions()[0]!;
    await h.call("terminal_control", { action: "wait", terminal: "ask", event: "input_required", timeout_ms: 5000 });

    const w = watcher();
    const stop = session.watch(w.replay, w.data);
    await until(() => w.seen.replay !== null);
    // The replay redraws the screen, colours included.
    expect(w.seen.replay).toContain("ready");
    expect(w.seen.replay).toContain("\x1b[32m");
    expect(w.seen.replay).toContain("Name? ");

    supervisor.input(session, "Ada");
    await until(() => w.seen.after.includes("Ada"));
    expect(session.inputRequired()).toBe(false);
    const refused = await h.call("terminal_control", { action: "write", terminal: "ask", input: "Bob" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("user_typing");
    const listed = (await h.call("terminal_control", { action: "list" })).json as { terminals: { user_typed_s_ago?: number }[] };
    expect(listed.terminals[0]!.user_typed_s_ago).toBeLessThan(5);

    supervisor.input(session, "\r");
    await until(() => w.seen.after.includes("hi Ada"));
    // What the agent reads next says the user typed it.
    const read = await h.call("terminal_control", { action: "wait", terminal: "ask", event: "exit", timeout_ms: 5000 });
    expect(read.json).toMatchObject({ event: "exit", user_typed_s_ago: 0 });
    expect((read.json as { output: string }).output).toContain("hi Ada");
    stop();
  });

  it("restarts a session as the same launch under the same name, and the stopped one leaves the listing", async () => {
    const h = harness();
    await h.call("terminal", { command: "sleep 30", background: true, name: "sleeper", yield_ms: 250 });
    const { supervisor, session } = h.runner.terminalSessions()[0]!;
    const next = await supervisor.restart(session);
    expect(next.id).not.toBe(session.id);
    expect(next.selector).toBe("sleeper");
    expect(session.status).toBe("exited");
    expect(h.runner.terminalSessions().map((s) => s.session.id)).toEqual([next.id]);
    // It is recorded as the first one was.
    expect(h.store.listEvents({ type: "terminal_started" })).toHaveLength(2);
  });

  it("resizes a terminal for the panel, and its screen follows", async () => {
    const h = harness();
    await h.call("terminal", { command: "sleep 30", pty: true, background: true, name: "sized", yield_ms: 250 });
    const { supervisor, session } = h.runner.terminalSessions()[0]!;
    supervisor.resize(session, 90, 20);
    expect((await session.screen!.snapshot()).cols).toBe(90);
  });
});

describe("a session over pipes, as the page sees it", () => {
  it("replays its output with terminal line ends and streams what follows", async () => {
    const h = harness();
    await h.call("terminal", { command: "echo one; sleep 0.4; echo two; sleep 30", background: true, name: "log", yield_ms: 250 });
    const { session } = h.runner.terminalSessions()[0]!;
    await until(() => session.output.slice(0).text.includes("one"));
    const w = watcher();
    session.watch(w.replay, w.data);
    expect(w.seen.replay).toBe("one\r\n");
    await until(() => w.seen.after.includes("two"));
    expect(w.seen.after).toBe("two\r\n");
  });

  it("numbers sessions across workspaces, so each has its own id", async () => {
    const a = new TerminalSupervisor();
    const b = new TerminalSupervisor();
    const spec = { command: "true", cwd: process.cwd(), cwdRel: ".", env: {}, timeoutMs: null, background: true, name: null, ready: null };
    const hooks = { onStart: () => {}, onExit: () => {} };
    expect(a.launch(spec, hooks).id).not.toBe(b.launch(spec, hooks).id);
    await Promise.all([a.shutdown(), b.shutdown()]);
  });
});
