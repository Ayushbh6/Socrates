import { describe, expect, it } from "vitest";
import { loadPty } from "../src/pty";
import { Screen } from "../src/screen";
import { harness } from "./helpers";

const hasPty = loadPty() !== null;

/** A select list as shadcn, clack or inquirer draw it: it hides the cursor, highlights the choice, and redraws in place on every arrow key. */
const MENU = `
const options = ["Next.js", "Vite", "Astro", "Remix"];
let at = 0;
const draw = (first) => {
  if (!first) process.stdout.write("\\x1b[" + options.length + "A");
  for (const [i, o] of options.entries()) process.stdout.write("\\x1b[2K" + (i === at ? "\\x1b[7m❯ " + o + "\\x1b[0m" : "  " + o) + "\\n");
};
process.stdout.write("\\x1b[?25lWhich framework do you want?\\n");
draw(true);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (d) => {
  // Keys can arrive together in one chunk, as a terminal delivers them under load.
  for (const key of d.toString().match(/\\x1b\\[[AB]|\\r/g) ?? []) {
    if (key === "\\x1b[B") at = Math.min(at + 1, options.length - 1);
    else if (key === "\\x1b[A") at = Math.max(at - 1, 0);
    else { process.stdout.write("\\x1b[?25hchose " + options[at] + "\\n"); process.exit(0); }
  }
  draw(false);
});
`;

describe("the screen of a terminal", () => {
  it("shows what a person would see after redraws and erasing, and which line is selected", async () => {
    const screen = new Screen(40, 8);
    screen.write("Pick\r\n\x1b[7m❯ Vue\x1b[0m\r\n  React\r\n  Svelte\r\n");
    screen.write("\x1b[3A\x1b[2K  Vue\r\n\x1b[2K\x1b[7m❯ React\x1b[0m\r\n");
    const s = await screen.snapshot();
    expect(s.lines).toEqual(["Pick", "  Vue", "❯ React", "  Svelte"]);
    expect(s.highlighted).toEqual(["❯ React"]);
    expect(s.fullscreen).toBe(false);
  });

  it("finds the selected line by its colour or its pointer when it is not in reverse video", async () => {
    const coloured = new Screen(40, 8);
    coloured.write("Pick\r\n  Vue\r\n\x1b[36m  React\x1b[0m\r\n  Svelte\r\n");
    expect((await coloured.snapshot()).highlighted).toEqual(["React"]);
    const pointer = new Screen(40, 8);
    pointer.write("Pick\r\n  Vue\r\n> React\r\n  Svelte\r\n");
    expect((await pointer.snapshot()).highlighted).toEqual(["> React"]);
  });

  it("reports the cursor and a full-screen program", async () => {
    const screen = new Screen(20, 5);
    screen.write("\x1b[?1049h\x1b[?25lhi");
    const s = await screen.snapshot();
    expect(s.fullscreen).toBe(true);
    expect(s.cursor).toMatchObject({ row: 0, col: 2, visible: false });
  });
});

describe.skipIf(!hasPty)("an agent driving an interactive menu", () => {
  it("reads the menu's screen, moves the choice with arrow keys from what the screen shows, and confirms it", async () => {
    const h = harness({ files: { "menu.js": MENU } });
    const started = await h.call("terminal", { command: "node menu.js", pty: true, background: true, name: "menu", yield_ms: 1500 });
    expect(started.json).toMatchObject({ status: "running", pty: true });

    // A program that waits for a key comes with its screen.
    const waited = await h.call("terminal_control", { action: "wait", terminal: "menu", event: "input_required" });
    expect(waited.json).toMatchObject({ event: "input_required", screen: { highlighted: ["❯ Next.js"], cursor: { visible: false } } });
    expect(waited.json.screen.text).toContain("Which framework do you want?");

    // Each key's answer is the redrawn menu, not a pile of frames.
    const down = await h.call("terminal_control", { action: "write", terminal: "menu", keys: ["DOWN", "DOWN"], settle_ms: 3000 });
    expect(down.json.screen.text).toBe("Which framework do you want?\n  Next.js\n  Vite\n❯ Astro\n  Remix");
    expect(down.json.screen.highlighted).toEqual(["❯ Astro"]);

    const view = await h.call("terminal_control", { action: "screen", terminal: "menu" });
    expect(view.json).toMatchObject({ screen: { highlighted: ["❯ Astro"] } });
    await h.call("terminal_control", { action: "write", terminal: "menu", keys: ["UP", "ENTER"] });
    const done = await h.call("terminal_control", { action: "wait", terminal: "menu", event: "exit" });
    expect(done.json.output).toContain("chose Vite");
  }, 30_000);

  it("says plainly when a session over pipes has no screen", async () => {
    const h = harness();
    await h.call("terminal", { command: "sleep 30", background: true, name: "piped" });
    const r = await h.call("terminal_control", { action: "screen", terminal: "piped" });
    expect(r.json.error?.code ?? r.json.code).toBe("needs_pty");
    await h.call("terminal_control", { action: "terminate", terminal: "piped" });
  });
});

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

const server = (port: number) => `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1',()=>console.log('listening ${port}'))"`;

describe("several servers at once, each tracked and stopped on its own", () => {
  it("lists each with its port and age, waits for a port or a stop, and leaves the others running", async () => {
    const h = harness();
    const ports = [await freePort(), await freePort(), await freePort()];
    const names = ["web", "api", "docs"];
    for (const [i, name] of names.entries()) {
      const r = await h.call("terminal", { command: server(ports[i]!), background: true, name, ready: { pattern: "listening", port: ports[i]! } });
      expect(r.json).toMatchObject({ status: "running", ready: true });
    }
    const list = (await h.call("terminal_control", { action: "list" })).json.terminals;
    expect(list.map((t: any) => [t.terminal, t.listening_ports, t.status])).toEqual([["web", [ports[0]], "running"], ["api", [ports[1]], "running"], ["docs", [ports[2]], "running"]]);
    expect(list[0]).toMatchObject({ started_in: expect.stringMatching(/^g\d+\/t\d+$/), running_for_s: expect.any(Number), quiet_for_s: expect.any(Number) });

    // Stop one; its port closes, and the other two keep serving.
    await h.call("terminal_control", { action: "terminate", terminal: "api" });
    const closed = await h.call("terminal_control", { action: "wait", terminal: "web", event: "port_closed", port: ports[1], timeout_ms: 5000 });
    expect(closed.json.event).toBe("port_closed");
    const after = (await h.call("terminal_control", { action: "list" })).json.terminals;
    expect(after.find((t: any) => t.terminal === "api")).toMatchObject({ status: "exited" });
    expect(after.filter((t: any) => t.status === "running").map((t: any) => t.terminal)).toEqual(["web", "docs"]);
    const open = await h.call("terminal_control", { action: "wait", terminal: "docs", event: "port_open", port: ports[2] });
    expect(open.json.event).toBe("port_open");

    // Wait on several at once: the first to stop is named, with the state of the rest.
    await h.call("terminal", { command: "sleep 1", background: true, name: "job" });
    const first = (await h.call("terminal_control", { action: "wait", terminals: ["web", "docs", "job"], event: "exit", timeout_ms: 8000 })).json;
    expect(first).toMatchObject({ event: "exit", terminal: "job", others: [{ terminal: "web", status: "running" }, { terminal: "docs", status: "running" }] });
    await h.call("terminal_control", { action: "terminate", terminal: "docs" });
    await h.call("terminal_control", { action: "terminate", terminal: "web" });
  }, 30_000);

  it("gives up at the time it was given, and tells quiet from busy", async () => {
    const h = harness();
    await h.call("terminal", { command: "echo up; sleep 30", background: true, name: "quiet" });
    const started = Date.now();
    const timed = await h.call("terminal_control", { action: "wait", terminal: "quiet", event: "exit", timeout_ms: 600 });
    expect(timed.json.event).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
    const idle = await h.call("terminal_control", { action: "wait", terminal: "quiet", event: "idle", idle_ms: 400 });
    expect(idle.json.event).toBe("idle");
    await h.call("terminal_control", { action: "terminate", terminal: "quiet" });
  });

  it("refuses a wait that cannot work, with a way to fix it", async () => {
    const h = harness();
    await h.call("terminal", { command: "sleep 30", background: true, name: "s" });
    const both = await h.call("terminal_control", { action: "wait", terminal: "s", terminals: ["s", "s"], event: "exit" });
    expect(both.json.error?.code ?? both.json.code).toBe("invalid_parameters");
    const none = await h.call("terminal_control", { action: "wait", event: "exit" });
    expect(none.json.error?.code ?? none.json.code).toBe("invalid_parameters");
    const noPort = await h.call("terminal_control", { action: "wait", terminal: "s", event: "port_open" });
    expect(noPort.json.error?.code ?? noPort.json.code).toBe("invalid_parameters");
    await h.call("terminal_control", { action: "terminate", terminal: "s" });
  });
});
