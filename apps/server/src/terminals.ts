import { existsSync } from "node:fs";
import { type TerminalSession, type TerminalSupervisor, listeningPorts, commandEnvironment } from "@socrates/tools";
import type { WebSocket } from "ws";
import type { Runtime } from "./runtime";

/** How often the list is looked at for changes: a prompt waiting for input is noticed by time, not by an event. */
const LIST_EVERY_MS = 500;
/** Listening ports are looked up this often, since finding them runs ps and lsof. */
const PORTS_EVERY_MS = 5_000;
/** A command the agent runs is shown once it has run this long, so a quick `ls` never flashes a tab. */
const SHOW_AFTER_MS = 2_000;
/** Output for one page is gathered this long and sent as one message. */
const OUTPUT_EVERY_MS = 16;

/** One terminal session, as the page's terminal panel lists it. */
export interface TerminalView {
  id: string;
  name: string;
  command: string;
  cwd: string;
  /** The task that started it, by its title; the page shows no goal or task numbers. */
  task: string | null;
  status: "running" | "exited";
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
  /** A pseudo-terminal the user can type into; over pipes the panel only shows output. */
  pty: boolean;
  background: boolean;
  ready: boolean | null;
  inputRequired: boolean;
  ports: number[];
  cols: number | null;
  rows: number | null;
  startedAt: string;
  exitedAt: string | null;
}

/**
 * The terminal panel's side of the live connection (architecture/server.md,
 * "Terminal panel"): the sessions the agent started, as a list that is sent
 * whenever it changes; each session a page opens, replayed and then streamed
 * as it prints; and what the user does there: type, resize, stop, restart,
 * and dismiss one that has ended. It is the same session the agent drives.
 */
export class TerminalPanel {
  private last = "";
  private readonly changing = new Set<string>();
  private readonly ports = new Map<string, number[]>();
  private portsAt = 0;
  private readonly watching = new Map<WebSocket, Map<string, { stop: () => void; pending: string; timer: ReturnType<typeof setTimeout> | null }>>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly runtime: Runtime,
    private readonly broadcast: (message: object) => void,
    private readonly send: (socket: WebSocket, message: object) => void,
  ) {
    this.timer = setInterval(() => this.publish(), LIST_EVERY_MS);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
    for (const socket of [...this.watching.keys()]) this.detach(socket);
  }

  /** The sessions the panel shows: those that run in the background or for a while, and those that ended; a restarted one gives way to its replacement. */
  list(): TerminalView[] {
    const now = Date.now();
    const sessions = this.sessions().map(({ session }) => session);
    return sessions
      .filter((s) => (s.status === "running" ? s.spec.background || now - s.startedAt.getTime() >= SHOW_AFTER_MS : true))
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map((s) => this.view(s));
  }

  /** Send the list when it changed; ports are looked up every few seconds while something runs. */
  publish(force = false): void {
    if (Date.now() - this.portsAt >= PORTS_EVERY_MS) void this.lookUpPorts();
    const list = this.list();
    const json = JSON.stringify(list);
    if (!force && json === this.last) return;
    this.last = json;
    this.broadcast({ type: "terminals", terminals: list });
  }

  /** Show a page a session: what it already shows, then what it prints. One that is gone (a page reconnecting after a restart) is left to the list. */
  open(socket: WebSocket, id: string): void {
    const session = this.sessions().find(({ session }) => session.id === id)?.session;
    if (!session) return;
    const open = this.watching.get(socket) ?? new Map();
    this.watching.set(socket, open);
    open.get(id)?.stop();
    const entry = { stop: () => {}, pending: "", timer: null as ReturnType<typeof setTimeout> | null };
    open.set(id, entry);
    entry.stop = session.watch(
      (data) => this.send(socket, { type: "terminal_replay", session: id, data, cols: session.screen?.cols ?? null, rows: session.screen?.rows ?? null }),
      (chunk) => {
        entry.pending += chunk;
        entry.timer ??= setTimeout(() => {
          entry.timer = null;
          const data = entry.pending;
          entry.pending = "";
          if (data) this.send(socket, { type: "terminal_output", session: id, data });
        }, OUTPUT_EVERY_MS);
      },
    );
  }

  /** Stop showing a page a session (its tab closed, or the panel did). */
  shut(socket: WebSocket, id: string): void {
    const entry = this.watching.get(socket)?.get(id);
    if (!entry) return;
    entry.stop();
    if (entry.timer) clearTimeout(entry.timer);
    this.watching.get(socket)!.delete(id);
  }

  /** A page went away. */
  detach(socket: WebSocket): void {
    for (const id of [...(this.watching.get(socket)?.keys() ?? [])]) this.shut(socket, id);
    this.watching.delete(socket);
  }

  input(id: string, data: string): void {
    const { supervisor, session } = this.owned(id);
    if (session.status !== "running") throw new TerminalPanelError("terminal_exited", `${session.selector} has ended.`);
    if (!session.proc?.pty) throw new TerminalPanelError("not_a_terminal", `${session.selector} runs without a terminal, so it cannot be typed into.`);
    supervisor.input(session, data);
  }

  resize(id: string, cols: number, rows: number): void {
    const { supervisor, session } = this.owned(id);
    supervisor.resize(session, cols, rows);
  }

  async stop(id: string): Promise<void> {
    const { supervisor, session } = this.owned(id);
    await supervisor.terminate(session);
    this.publish();
  }

  /** Run it again; the page follows the new session. */
  async restart(id: string): Promise<string> {
    return this.exclusive(id, async () => {
      const { supervisor, session } = this.owned(id);
      this.runtime.terminalDirectory(session.spec.cwd);
      const next = await supervisor.restart(session);
      this.publish();
      return next.id;
    });
  }

  create(input: { cwd?: string; goal?: number; task?: number; name?: string }): string {
    const folder = this.runtime.terminalFolder(input.cwd, input.goal);
    const supervisor = this.runtime.terminalManager.forWorkspace(folder.root);
    const names = new Set(supervisor.list().map(s => s.spec.name));
    let n = 1;
    while (names.has(`Shell ${n}`)) n++;
    const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
    const goal = input.goal ? this.runtime.store.getGoalByNumber(input.goal) : null;
    if (input.task && (!goal || !this.runtime.store.getTaskByNumber(goal.id, input.task))) throw new TerminalPanelError("not_found", "That chat is no longer available.");
    const origin = input.goal && input.task ? `g${input.goal}/t${input.task}` : null;
    const session = supervisor.launch({ command: shell, shell, cwd: folder.cwd, cwdRel: folder.cwd,
      env: commandEnvironment(), timeoutMs: null, background: true, name: input.name ?? `Shell ${n}`,
      ready: null, pty: { cols: 120, rows: 30 }, origin,
    }, { onStart() {}, onExit() {} });
    this.publish();
    return session.id;
  }

  rename(id: string, name: string): void {
    const { supervisor, session } = this.owned(id);
    supervisor.rename(session, name);
    this.publish();
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      const { supervisor, session } = this.owned(id);
      await supervisor.terminate(session);
      supervisor.forget(session);
      for (const socket of this.watching.keys()) this.shut(socket, id);
      this.publish();
    });
  }

  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.changing.has(id)) throw new TerminalPanelError("terminal_busy", "This terminal is already changing. Try again in a moment.");
    this.changing.add(id);
    try { return await work(); } finally { this.changing.delete(id); }
  }

  /** Take an ended session off the list. */
  dismiss(id: string): void {
    const { supervisor, session } = this.owned(id);
    if (session.status === "running") throw new TerminalPanelError("terminal_running", `${session.selector} is still running; stop it first.`);
    supervisor.forget(session);
    this.publish();
  }

  private sessions(): { supervisor: TerminalSupervisor; session: TerminalSession }[] {
    return this.runtime.terminalManager.sessions();
  }

  private owned(id: string): { supervisor: TerminalSupervisor; session: TerminalSession } {
    const found = this.sessions().find(({ session }) => session.id === id);
    if (!found) throw new TerminalPanelError("not_found", "That terminal is no longer there.");
    return found;
  }

  private view(s: TerminalSession): TerminalView {
    return {
      id: s.id,
      name: s.spec.name ?? firstWords(s.spec.command),
      command: s.spec.command,
      cwd: s.spec.cwd,
      task: this.taskTitle(s.spec.origin ?? null),
      status: s.status,
      exitCode: s.exitCode,
      signal: s.signal,
      reason: s.exitReason,
      pty: !!s.spec.pty,
      background: s.spec.background,
      ready: s.ready,
      inputRequired: !s.spec.shell && s.inputRequired() === true,
      ports: s.status === "running" ? this.ports.get(s.id) ?? [] : [],
      cols: s.screen?.cols ?? null,
      rows: s.screen?.rows ?? null,
      startedAt: s.startedAt.toISOString(),
      exitedAt: s.exitedAt?.toISOString() ?? null,
    };
  }

  /** "g2/t3" is the task's title on the page. */
  private taskTitle(origin: string | null): string | null {
    const m = origin ? /^g(\d+)\/t(\d+)$/.exec(origin) : null;
    if (!m) return null;
    const store = this.runtime.store;
    const goal = store.getGoalByNumber(Number(m[1]));
    return (goal && store.getTaskByNumber(goal.id, Number(m[2]))?.title) ?? null;
  }

  private async lookUpPorts(): Promise<void> {
    this.portsAt = Date.now();
    const running = this.sessions().map(({ session }) => session).filter((s) => s.status === "running" && s.proc?.pid);
    const found = await Promise.all(running.map(async (s) => [s.id, await listeningPorts(s.proc!.pid!)] as const));
    this.ports.clear();
    for (const [id, ports] of found) this.ports.set(id, ports);
  }
}

export class TerminalPanelError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TerminalPanelError";
  }
}

/** A tab's name for a session the agent did not name: its command's first words. */
function firstWords(command: string): string {
  const words = command.trim().split(/\s+/).slice(0, 3).join(" ");
  return words.length > 32 ? `${words.slice(0, 31)}…` : words;
}
