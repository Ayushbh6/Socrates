import { describe, expect, it } from "vitest";
import { loadPty } from "../../../packages/tools/src/pty";
import { createGoal } from "../../../packages/router/test/helpers";
import { call, final } from "../../../packages/agent/test/helpers";
import { Responder, liveServer, tempDir } from "./helpers";

const hasPty = loadPty() !== null;

/** A prompt that asks for a name and greets it. */
const PROMPT = "node -e \"process.stdout.write('Name? '); process.stdin.setRawMode(true); let n=''; process.stdin.on('data', d => { for (const c of d.toString()) { if (c === '\\r') { process.stdout.write('\\r\\nhi ' + n + '\\r\\n'); return; } n += c; process.stdout.write(c); } })\"";

describe.skipIf(!hasPty)("the terminal panel", () => {
  it("lists what the agent started, replays and streams it to a page, takes the user's typing, and stops and restarts it", async () => {
    const folder = tempDir();
    let n = 0;
    const { page, rt } = await liveServer(new Responder("r", () => createGoal("Greet", "Ask my name")), new Responder("a", () => n++ === 0 ? {
      toolCalls: [call("terminal", { command: PROMPT, pty: true, background: true, name: "greeter", yield_ms: 800 })],
    } : final()));
    const workspace = rt.store.createWorkspace("project", folder);
    await rt.updateSettings({ workingFolder: workspace.id, access: { approvals: "auto" } });
    const p = await page();
    p.send({ type: "hello" });
    expect(await p.next((m) => m.type === "terminals")).toEqual({ type: "terminals", terminals: [] });

    p.send({ type: "send", id: "g", text: "Ask my name.", to: "main" });
    const listed = await p.next((m) => m.type === "terminals" && m.terminals.length === 1);
    // The page names the task by its title, never by its numbers.
    expect(listed.terminals[0]).toMatchObject({ name: "greeter", status: "running", pty: true, background: true, task: "Ask my name", cols: 120, rows: 40 });
    const id = listed.terminals[0].id as string;
    await p.next((m) => m.type === "terminals" && m.terminals[0]?.inputRequired === true, 8_000);

    p.send({ type: "terminal_open", session: id });
    const replay = await p.next((m) => m.type === "terminal_replay");
    expect(replay).toMatchObject({ session: id, cols: 120, rows: 40 });
    expect(replay.data).toContain("Name? ");

    p.send({ type: "terminal_resize", session: id, cols: 90, rows: 20 });
    p.send({ type: "terminal_input", session: id, data: "Ada\r" });
    let shown = "";
    await p.next((m) => m.type === "terminal_output" && (shown += m.data).includes("hi Ada"));
    await p.next((m) => m.type === "terminals" && m.terminals[0]?.cols === 90 && m.terminals[0].inputRequired === false);

    p.send({ type: "terminal_restart", session: id });
    const restarted = await p.next((m) => m.type === "terminal_restarted");
    expect(restarted.next).not.toBe(id);
    // The replacement takes the stopped one's place in the list.
    const after = await p.next((m) => m.type === "terminals" && m.terminals.length === 1 && m.terminals[0].id === restarted.next);
    expect(after.terminals[0]).toMatchObject({ name: "greeter", status: "running" });

    p.send({ type: "terminal_stop", session: restarted.next });
    await p.next((m) => m.type === "terminals" && m.terminals[0]?.status === "exited");
    p.send({ type: "terminal_dismiss", session: restarted.next });
    await p.next((m) => m.type === "terminals" && m.terminals.length === 0);
  });

  it("refuses typing into a session that runs without a terminal, and commands for one that is gone", async () => {
    const folder = tempDir();
    let n = 0;
    const { page, rt } = await liveServer(new Responder("r", () => createGoal("Serve", "Serve it")), new Responder("a", () => n++ === 0 ? {
      toolCalls: [call("terminal", { command: "echo serving; sleep 30", background: true, name: "server", yield_ms: 300 })],
    } : final()));
    const workspace = rt.store.createWorkspace("project", folder);
    await rt.updateSettings({ workingFolder: workspace.id, access: { approvals: "auto" } });
    const p = await page();
    p.send({ type: "hello" });
    p.send({ type: "send", id: "s", text: "Serve it.", to: "main" });
    const listed = await p.next((m) => m.type === "terminals" && m.terminals.length === 1);
    const id = listed.terminals[0].id as string;
    expect(listed.terminals[0]).toMatchObject({ pty: false, cols: null });

    p.send({ type: "terminal_open", session: id });
    expect((await p.next((m) => m.type === "terminal_replay")).data).toBe("serving\r\n");
    p.send({ type: "terminal_input", session: id, data: "x" });
    expect(await p.next((m) => m.type === "error")).toMatchObject({ code: "not_a_terminal" });
    p.send({ type: "terminal_dismiss", session: id });
    expect(await p.next((m) => m.type === "error")).toMatchObject({ code: "terminal_running" });
    p.send({ type: "terminal_stop", session: "term-999999" });
    expect(await p.next((m) => m.type === "error")).toMatchObject({ code: "not_found" });
    p.send({ type: "terminal_stop", session: id });
    await p.next((m) => m.type === "terminals" && m.terminals[0]?.status === "exited");
  });
});
