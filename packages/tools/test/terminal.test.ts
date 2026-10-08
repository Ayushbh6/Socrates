import net from "node:net";
import { describe, expect, it } from "vitest";
import { harness } from "./helpers";

describe.skipIf(process.platform === "win32")("terminal", () => {
  it("completes a foreground command with exit code, output, and command facts", async () => {
    const h = harness({ files: { "a.txt": "hello\n" } });
    const r = await h.call("terminal", { command: "cat a.txt; echo err >&2; exit 3" });
    expect(r.json).toMatchObject({ status: "completed", terminal: null, exit_code: 3, signal: null, truncated: false });
    expect(r.json.output).toBe("hello\nerr\n");
    expect(h.store.taskFacts(h.binding.taskId).map((f) => f.kind)).toEqual(["command"]);
    expect(h.store.listEvents({ type: "terminal_exited" })).toHaveLength(1);
  });

  it("records test commands with their outcome", async () => {
    const h = harness();
    await h.call("terminal", { command: "echo building; exit 0" });
    await h.call("terminal", { command: "pytest --version >/dev/null 2>&1; exit 1" });
    expect(h.store.taskFacts(h.binding.taskId).filter((f) => f.kind === "test").map((f) => f.value)).toEqual(["pytest --version >/dev/null 2>&1; exit 1 → exit 1"]);
  });

  it("runs in a controlled, non-interactive environment without the harness's credentials", async () => {
    process.env.OPENAI_API_KEY = "sk-test-secret";
    try {
      const h = harness();
      const r = await h.call("terminal", { command: 'echo "key=${OPENAI_API_KEY:-none} pager=$PAGER extra=$EXTRA"; pwd', env: { EXTRA: "yes" }, cwd: "." });
      expect(r.json.output).toContain("key=none pager=cat extra=yes");
      expect(r.json.output.trim().endsWith(h.root)).toBe(true);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("publishes a long-running command as a session after yield_ms, then waits for its exit", async () => {
    const h = harness();
    const r = await h.call("terminal", { command: "echo started; sleep 1; echo finished", yield_ms: 300 });
    // Session ids are numbered across every workspace of the process.
    expect(r.json).toMatchObject({ status: "running", terminal: expect.stringMatching(/^term-\d+$/), ready: null });
    expect(r.json.session_id).toBe(r.json.terminal);
    expect(r.json.output).toBe("started\n");
    const waited = await h.call("terminal_control", { action: "wait", terminal: r.json.terminal, event: "exit" });
    expect(waited.json).toMatchObject({ action: "wait", event: "exit", status: "exited", exit_code: 0 });
    expect(waited.json.output).toBe("finished\n");
  });

  it("starts a named background service and returns once its readiness pattern appears", async () => {
    const h = harness();
    const r = await h.call("terminal", {
      command: "echo booting; sleep 0.3; echo 'Local: http://localhost:4000'; sleep 30",
      background: true,
      name: "dev-server",
      ready: { pattern: "Local: http" },
    });
    expect(r.json).toMatchObject({ status: "running", terminal: "dev-server", ready: true });
    expect(r.json.output).toContain("Local: http://localhost:4000");
    const list = await h.call("terminal_control", { action: "list" });
    expect(list.json.terminals).toEqual([expect.objectContaining({ terminal: "dev-server", status: "running", ready: true, command: expect.stringContaining("booting") })]);
    const dup = await h.call("terminal", { command: "sleep 1", background: true, name: "dev-server" });
    expect(dup.json.error.code).toBe("name_in_use");
    const stop = await h.call("terminal_control", { action: "terminate", terminal: "dev-server" });
    expect(stop.json).toMatchObject({ action: "terminate", status: "exited", accepted: true });
  });

  it("waits for a TCP port to accept connections", async () => {
    const h = harness();
    const port = await new Promise<number>((done) => {
      const probe = net.createServer().listen(0, () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => done(p));
      });
    });
    const server = `node -e "setTimeout(() => require('net').createServer().listen(${port}), 300); setTimeout(() => {}, 30000)"`;
    const r = await h.call("terminal", { command: server, background: true, name: "svc", ready: { port, timeout_ms: 10000 } });
    expect(r.json.ready).toBe(true);
  });

  it("reads retained output by cursor without consuming it, and waits for a pattern in new output", async () => {
    const h = harness();
    await h.call("terminal", { command: "for i in 1 2 3; do echo line$i; done; sleep 0.4; echo READY; sleep 30", background: true, name: "w" });
    const pattern = await h.call("terminal_control", { action: "wait", terminal: "w", event: "pattern", pattern: "READY" });
    expect(pattern.json).toMatchObject({ event: "pattern" });
    expect(pattern.json.output).toContain("line1\nline2\nline3\nREADY\n");
    const again = await h.call("terminal_control", { action: "read", terminal: "w", cursor: "c0", limit_lines: 2 });
    expect(again.json).toMatchObject({ output: "line1\nline2\n", cursor: "c12", truncated: true });
    const rest = await h.call("terminal_control", { action: "read", terminal: "w", cursor: again.json.cursor });
    expect(rest.json.output).toBe("line3\nREADY\n");
    expect((await h.call("terminal_control", { action: "read", terminal: "w", cursor: "x9" })).json.error.code).toBe("invalid_cursor");
  });

  it("writes to stdin, maps CTRL_D and CTRL_C, and signals the process group", async () => {
    const h = harness();
    await h.call("terminal", { command: "cat", background: true, name: "echoer" });
    await h.call("terminal_control", { action: "write", terminal: "echoer", input: "ping" });
    const out = await h.call("terminal_control", { action: "wait", terminal: "echoer", event: "pattern", pattern: "ping" });
    expect(out.json.output).toBe("ping\n");
    const tab = await h.call("terminal_control", { action: "write", terminal: "echoer", keys: ["TAB"] });
    expect(tab.json.error).toMatchObject({ code: "needs_pty", correction: expect.stringContaining("pty: true") });
    expect((await h.call("terminal_control", { action: "wait", terminal: "echoer", event: "input_required" })).json.error.code).toBe("needs_pty");
    expect((await h.call("terminal_control", { action: "resize", terminal: "echoer", cols: 80, rows: 24 })).json.error.code).toBe("needs_pty");
    await h.call("terminal_control", { action: "write", terminal: "echoer", keys: ["CTRL_D"] });
    expect((await h.call("terminal_control", { action: "wait", terminal: "echoer", event: "exit" })).json.exit_code).toBe(0);

    await h.call("terminal", { command: "sleep 30 & sleep 30; echo never", background: true, name: "group" });
    const sig = await h.call("terminal_control", { action: "write", terminal: "group", keys: ["CTRL_C"] });
    expect(sig.json.accepted).toBe(true);
    const exit = await h.call("terminal_control", { action: "wait", terminal: "group", event: "exit" });
    expect(exit.json.signal ?? exit.json.exit_code).toBeTruthy();
  });

  it("asks before SIGKILL and before running without a deadline", async () => {
    const h = harness({ approve: (r) => r.kind !== "sigkill" });
    await h.call("terminal", { command: "sleep 30", background: true, name: "s" });
    const kill = await h.call("terminal_control", { action: "signal", terminal: "s", signal: "SIGKILL" });
    expect(kill.json.error.code).toBe("approval_denied");
    const term = await h.call("terminal_control", { action: "signal", terminal: "s", signal: "SIGTERM" });
    expect(term.json.accepted).toBe(true);
    const forever = await h.call("terminal", { command: "echo ok", timeout_ms: 0 });
    expect(forever.json.status).toBe("completed");
    expect(h.approvals.map((a) => a.kind)).toEqual(["sigkill", "no_deadline"]);
  });

  it("enforces the execution deadline and reports a timeout", async () => {
    const h = harness();
    const r = await h.call("terminal", { command: "echo start; sleep 30", timeout_ms: 300 });
    expect(r.json).toMatchObject({ status: "timed_out", signal: "SIGTERM" });
    expect(r.json.output).toBe("start\n");
  });

  it("restarts a named session under the same name with a new session id", async () => {
    const h = harness();
    const first = (await h.call("terminal", { command: "echo run-$RANDOM; sleep 30", background: true, name: "svc", ready: { pattern: "run-" } })).json.session_id;
    const r = await h.call("terminal_control", { action: "restart", terminal: "svc" });
    expect(r.json).toMatchObject({ action: "restart", terminal: "svc", previous_session_id: first, status: "running", ready: true });
    expect(r.json.session_id).not.toBe(first);
    const list = await h.call("terminal_control", { action: "list" });
    expect(list.json.terminals.map((t: any) => [t.session_id, t.status])).toEqual([[r.json.session_id, "running"], [first, "exited"]]);
  });

  it("stops a foreground command when the call is cancelled", async () => {
    const h = harness();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const r = await h.call("terminal", { command: "sleep 30" }, { signal: controller.signal });
    expect(r.json.error).toMatchObject({ code: "cancelled", retryable: false });
    expect(h.store.listEvents({ type: "terminal_exited" })).toHaveLength(1);
  });

  it("rejects unknown terminals, bad readiness patterns, and missing directories", async () => {
    const h = harness();
    expect((await h.call("terminal", { command: "true", ready: { pattern: "(" } })).json.error.code).toBe("invalid_pattern");
    expect((await h.call("terminal", { command: "true", cwd: "nope" })).json.error.code).toBe("directory_not_found");
    const missing = await h.call("terminal_control", { action: "read", terminal: "ghost" });
    expect(missing.json.error.code).toBe("terminal_not_found");
    expect(missing.json.error.message).toContain("No terminals are running");
    await h.call("terminal", { command: "sleep 30", background: true, name: "plain" });
    expect((await h.call("terminal_control", { action: "wait", terminal: "plain", event: "ready" })).json.error.code).toBe("no_ready_condition");
    expect((await h.call("terminal_control", { action: "wait", terminal: "plain", event: "input_required" })).json.error.code).toBe("needs_pty");
  });
});
