import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { constants } from "node:os";
import { ToolError } from "./errors";
import { forgetProcess, recordProcess } from "./process-registry";
import { TerminalText, loadPty } from "./pty";

/**
 * The project terminal supervisor (agent-harness.md, "terminal" and
 * "terminal_control"). It owns every process the agent starts in one
 * workspace: each runs in its own process group so the whole tree can be
 * signalled and cleaned up, its output is retained for cursor reads, and it
 * survives model turns until it exits or is stopped.
 *
 * Sessions run over pipes, or in a pseudo-terminal for interactive programs.
 */

export interface LaunchSpec {
  command: string;
  /** Absolute working directory. */
  cwd: string;
  /** Workspace-relative working directory, for display. */
  cwdRel: string;
  env: Record<string, string>;
  /** Execution deadline in milliseconds; null means none. */
  timeoutMs: number | null;
  background: boolean;
  name: string | null;
  ready: { pattern: string | null; port: number | null; timeoutMs: number } | null;
  /** Run in a pseudo-terminal of this size instead of over pipes. */
  pty?: { cols: number; rows: number } | null;
}

/** A running command, over pipes or in a pseudo-terminal. */
export interface SessionProcess {
  readonly pid: number | undefined;
  readonly pty: boolean;
  write(data: string): void;
  /** End of input: closes stdin over pipes, sends the EOF character in a terminal. */
  closeInput(): void;
  resize(cols: number, rows: number): void;
}

/** A pseudo-terminal session that has printed nothing for this long after a partial line is waiting for input. */
export const INPUT_IDLE_MS = 750;
/** A terminal's process may exit before its last output is read; the exit waits this long for it. */
const PTY_DRAIN_MS = 100;

export type ExitReason = "exited" | "terminated" | "timeout" | "failed";

export interface SessionHooks {
  onStart(session: TerminalSession): void;
  onExit(session: TerminalSession): void;
}

/** Commands get a predictable, non-interactive environment (no pagers, colors, or credential prompts). */
const NON_INTERACTIVE_ENV: Record<string, string> = {
  NO_COLOR: "1",
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

/** The harness's own model-provider credentials never reach agent commands. */
const HARNESS_SECRET = /^(?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|DEEPSEEK|OPENROUTER|MISTRAL|OLLAMA|TAVILY)_(?:API_KEY|AUTH_TOKEN)$|^SOCRATES_/;

export function commandEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !HARNESS_SECRET.test(key)) env[key] = value;
  return { ...env, ...NON_INTERACTIVE_ENV, ...extra };
}

/** Output retained for cursor reads, addressed by absolute character offset. */
export class OutputBuffer {
  private text = "";
  /** Absolute offset of the first retained character. */
  private first = 0;

  constructor(private readonly retainChars: number) {}

  append(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.retainChars) {
      let drop = this.text.length - this.retainChars;
      if (/[\uDC00-\uDFFF]/.test(this.text[drop] ?? "")) drop++;
      this.text = this.text.slice(drop);
      this.first += drop;
    }
  }

  get start(): number {
    return this.first;
  }

  get end(): number {
    return this.first + this.text.length;
  }

  /** Retained text in [from, to); `lost` is true when part of the range was already dropped. */
  slice(from: number, to = this.end): { text: string; from: number; lost: boolean } {
    const lost = from < this.first;
    const start = Math.max(from, this.first);
    return { text: this.text.slice(start - this.first, Math.max(start, to) - this.first), from: start, lost };
  }
}

export class TerminalSession {
  status: "running" | "exited" = "running";
  exitCode: number | null = null;
  signal: string | null = null;
  exitReason: ExitReason | null = null;
  stateVersion = 1;
  ready: boolean | null;
  /** Output offset up to which the agent has received output. */
  observed = 0;
  stdinOpen = true;
  /** When the process last printed anything. */
  lastOutputAt = Date.now();
  readonly startedAt = new Date();
  exitedAt: Date | null = null;
  private listeners = new Set<() => void>();
  private timeoutTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    readonly spec: LaunchSpec,
    readonly proc: SessionProcess | null,
    readonly output: OutputBuffer,
  ) {
    this.ready = spec.ready ? false : null;
  }

  get selector(): string {
    return this.spec.name ?? this.id;
  }

  /**
   * Whether a terminal session waits for input: it is running, has printed
   * nothing for INPUT_IDLE_MS, and its last line is unfinished, as a prompt
   * is ("Password: ", "Continue? [y/N] "). Null over pipes, where programs
   * rarely prompt and an idle partial line is more often progress output.
   */
  inputRequired(now = Date.now()): boolean | null {
    if (!this.proc?.pty) return null;
    if (this.status !== "running" || now - this.lastOutputAt < INPUT_IDLE_MS) return false;
    const last = this.output.slice(Math.max(this.output.start, this.output.end - 1)).text;
    return last !== "" && last !== "\n";
  }

  /** Resolves on the next output or lifecycle change. */
  changed(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    return new Promise((done) => {
      let timer: NodeJS.Timeout | undefined;
      const listener = () => {
        this.listeners.delete(listener);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", listener);
        done();
      };
      this.listeners.add(listener);
      if (timeoutMs !== undefined) timer = setTimeout(listener, timeoutMs);
      signal?.addEventListener("abort", listener, { once: true });
      if (signal?.aborted) listener();
    });
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  bump(): void {
    this.stateVersion++;
    this.notify();
  }

  setTimer(timer: NodeJS.Timeout): void {
    this.timeoutTimer = timer;
  }

  clearTimer(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
  }
}

export interface SupervisorOptions {
  maxSessions?: number;
  /** Output retained per background session. */
  retainChars?: number;
  /** Output retained per foreground command, whose complete output is stored with its call. */
  foregroundRetainChars?: number;
  recentExited?: number;
  /** A file in the data folder listing live process groups, so a crashed server's are stopped at the next start. */
  registry?: string;
}

/** Grace period before leftover processes of a finished command are force-killed. */
const LINGER_GRACE_MS = 2000;

export class TerminalSupervisor {
  private readonly live = new Map<string, TerminalSession>();
  private readonly exited: TerminalSession[] = [];
  private counter = 0;
  private readonly maxSessions: number;
  private readonly retainChars: number;
  private readonly foregroundRetainChars: number;
  private readonly recentExited: number;
  private readonly registry: string | null;
  /** Process groups whose leader exited while other members were still running. */
  private readonly lingering = new Map<number, NodeJS.Timeout>();
  private readonly onProcessExit = () => this.killAllNow();

  constructor(options: SupervisorOptions = {}) {
    this.maxSessions = options.maxSessions ?? 16;
    this.retainChars = options.retainChars ?? 4_000_000;
    this.foregroundRetainChars = options.foregroundRetainChars ?? 16_000_000;
    this.recentExited = options.recentExited ?? 10;
    this.registry = options.registry ?? null;
    process.on("exit", this.onProcessExit);
  }

  /** Fail before launching when the name is taken or the session limit is reached. */
  assertCanLaunch(name: string | null): void {
    if (name && [...this.live.values()].some((s) => s.spec.name === name)) {
      throw new ToolError("name_in_use", `A live terminal is already named ${name}.`, `Use terminal_control on ${name}, stop it first, or choose another name.`);
    }
    if (this.live.size >= this.maxSessions) {
      const names = [...this.live.values()].map((s) => s.selector).join(", ");
      throw new ToolError("too_many_terminals", `${this.live.size} terminals are already running (${names}).`, "Stop terminals you no longer need with terminal_control terminate, then retry.");
    }
  }

  launch(spec: LaunchSpec, hooks: SessionHooks): TerminalSession {
    this.assertCanLaunch(spec.name);
    const id = `term-${++this.counter}`;
    const { file, args } = shellCommand(spec.command);
    const output = new OutputBuffer(spec.background ? this.retainChars : this.foregroundRetainChars);
    let session: TerminalSession;
    const onData = (chunk: string) => {
      session.lastOutputAt = Date.now();
      output.append(chunk);
      session.notify();
    };
    const finish = (code: number | null, signal: string | null, reason: ExitReason) => {
      if (session.status === "exited") return;
      session.clearTimer();
      // After a deliberate stop the group is already being torn down; only a normal exit is announced.
      session.status = "exited";
      session.exitCode = code;
      session.signal = signal;
      session.exitReason ??= reason;
      session.exitedAt = new Date();
      session.stdinOpen = false;
      this.live.delete(id);
      this.exited.unshift(session);
      this.exited.length = Math.min(this.exited.length, this.recentExited);
      if (this.registry && session.proc?.pid) forgetProcess(this.registry, session.proc.pid);
      session.bump();
      hooks.onExit(session);
    };
    // A command's own process group is reaped when its leader exits (see reapGroup).
    const exited = (pid: number | undefined) => {
      if (pid) this.reapGroup(pid, session.exitReason === null ? output : null);
    };

    if (spec.pty) {
      const pty = loadPty();
      if (!pty) throw new ToolError("pty_unavailable", "Pseudo-terminals are not available on this machine.", "Run the command without pty, passing input through terminal_control write.", false);
      let term: import("node-pty").IPty;
      try {
        term = pty.spawn(file, args, { name: "xterm-256color", cols: spec.pty.cols, rows: spec.pty.rows, cwd: spec.cwd, env: { ...spec.env, TERM: "xterm-256color" } });
      } catch (error) {
        throw new ToolError("spawn_failed", `The command could not be started in a terminal: ${(error as Error).message}`, "Check the command and working directory, or run it without pty.", false);
      }
      const text = new TerminalText();
      session = new TerminalSession(id, spec, {
        pid: term.pid,
        pty: true,
        write: (data) => term.write(data),
        closeInput: () => term.write("\x04"),
        resize: (cols, rows) => term.resize(cols, rows),
      }, output);
      this.live.set(id, session);
      if (this.registry) recordProcess(this.registry, term.pid, spec.command);
      hooks.onStart(session);
      term.onData((chunk) => {
        session.lastOutputAt = Date.now();
        const clean = text.push(chunk);
        if (clean) onData(clean);
      });
      term.onExit(({ exitCode, signal }) => {
        exited(term.pid);
        // The last output can arrive just after the exit.
        setTimeout(() => {
          const rest = text.flush();
          if (rest) onData(rest);
          const name = signal ? signalName(signal) : null;
          finish(name ? null : exitCode, name, "exited");
        }, PTY_DRAIN_MS);
      });
    } else {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
      } catch (error) {
        throw new ToolError("spawn_failed", `The command could not be started: ${(error as Error).message}`, "Check the command and working directory.", false);
      }
      const stdin = child.stdin!;
      session = new TerminalSession(id, spec, {
        pid: child.pid,
        pty: false,
        write: (data) => stdin.write(data),
        closeInput: () => stdin.end(),
        resize: () => {
          throw new ToolError("not_a_terminal", `${session.selector} runs over pipes, which have no size.`, "Start the command with pty: true to give it a terminal size.");
        },
      }, output);
      this.live.set(id, session);
      if (this.registry && child.pid) recordProcess(this.registry, child.pid, spec.command);
      hooks.onStart(session);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      stdin.on("error", () => {
        session.stdinOpen = false;
      });
      child.on("error", (error) => {
        output.append(`\n[failed to start: ${error.message}]\n`);
        finish(null, null, "failed");
      });
      // Descendants can inherit the pipes and prevent `close` after the shell
      // exits. Reap on `exit`, then let `close` drain the final output.
      child.once("exit", () => exited(child.pid));
      child.on("close", (code, signal) => finish(code, signal, "exited"));
    }

    if (spec.timeoutMs !== null) {
      session.setTimer(
        setTimeout(() => {
          session.exitReason = "timeout";
          void this.terminate(session);
        }, spec.timeoutMs),
      );
    }
    return session;
  }

  find(selector: string): TerminalSession {
    const all = [...this.live.values(), ...this.exited];
    const match = all.find((s) => s.spec.name === selector) ?? all.find((s) => s.id === selector);
    if (!match) {
      const known = [...this.live.values()].map((s) => s.selector);
      throw new ToolError(
        "terminal_not_found",
        `No terminal named ${selector}.${known.length ? ` Live terminals: ${known.join(", ")}.` : " No terminals are running."}`,
        "Use terminal_control list to see terminals, or start one with terminal.",
      );
    }
    return match;
  }

  /** Live sessions, then recently exited ones. */
  list(): TerminalSession[] {
    return [...this.live.values(), ...this.exited];
  }

  /** Remove a finished foreground command from listings; its output was already returned. */
  forget(session: TerminalSession): void {
    const i = this.exited.indexOf(session);
    if (i >= 0) this.exited.splice(i, 1);
  }

  /** Send a signal to the session's whole process group. */
  signal(session: TerminalSession, signal: NodeJS.Signals): void {
    if (session.status !== "running" || !session.proc?.pid) return;
    killGroup(session.proc.pid, signal);
  }

  /** Graceful process-tree shutdown followed by a bounded hard kill. */
  async terminate(session: TerminalSession): Promise<void> {
    if (session.status !== "running") return;
    session.exitReason ??= "terminated";
    this.signal(session, "SIGTERM");
    if (await settles(session, 3000)) return;
    this.signal(session, "SIGKILL");
    await settles(session, 2000);
  }

  async shutdown(): Promise<void> {
    process.off("exit", this.onProcessExit);
    await Promise.all([...this.live.values()].map((s) => this.terminate(s)));
    for (const [pid, timer] of this.lingering) {
      clearTimeout(timer);
      if (groupAlive(pid)) killGroup(pid, "SIGKILL");
    }
    this.lingering.clear();
  }

  /**
   * A command's lifetime is its shell's: background processes it started and
   * left in its process group are stopped when it exits, so nothing escapes
   * supervision. Use `background: true` for a long-running service instead.
   */
  private reapGroup(pid: number, output: OutputBuffer | null): void {
    if (!groupAlive(pid)) return;
    output?.append("\n[The command left background processes running; they were stopped.]\n");
    killGroup(pid, "SIGTERM");
    const timer = setTimeout(() => {
      if (groupAlive(pid)) killGroup(pid, "SIGKILL");
      this.lingering.delete(pid);
    }, LINGER_GRACE_MS);
    this.lingering.set(pid, timer);
    timer.unref();
  }

  private killAllNow(): void {
    for (const s of this.live.values()) if (s.proc?.pid) killGroup(s.proc.pid, "SIGKILL");
    for (const pid of this.lingering.keys()) killGroup(pid, "SIGKILL");
  }
}

function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  return { file: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", args: ["-c", command] };
}

/** The name of a signal number, such as 15 for SIGTERM. */
function signalName(signal: number): string | null {
  return Object.entries(constants.signals).find(([, n]) => n === signal)?.[0] ?? null;
}

/** Whether any process of a process group is still running. */
function groupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Wait until the session exits; false after `ms` without exiting. */
export async function settles(session: TerminalSession, ms: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (session.status === "running") {
    const left = deadline - Date.now();
    if (left <= 0 || signal?.aborted) return false;
    await session.changed(Math.min(left, 250), signal);
  }
  return true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Whether something accepts TCP connections on a local port. */
export function portOpen(port: number): Promise<boolean> {
  const attempt = (host: string) =>
    new Promise<boolean>((done) => {
      const socket = net.connect({ host, port });
      const end = (ok: boolean) => {
        socket.destroy();
        done(ok);
      };
      socket.once("connect", () => end(true));
      socket.once("error", () => end(false));
      socket.setTimeout(500, () => end(false));
    });
  return attempt("127.0.0.1").then((ok) => ok || attempt("::1"));
}

/**
 * Resolve readiness: every supplied condition (output pattern and/or port)
 * must pass. Returns false when the session exits or the timeout elapses.
 */
export async function awaitReady(session: TerminalSession, signal: AbortSignal, maxWaitMs = Infinity): Promise<boolean> {
  const ready = session.spec.ready;
  if (!ready) return true;
  const pattern = ready.pattern ? new RegExp(ready.pattern) : null;
  const deadline = Date.now() + Math.min(ready.timeoutMs, maxWaitMs);
  while (true) {
    if (session.status !== "running" || signal.aborted) return false;
    const patternOk = !pattern || pattern.test(session.output.slice(session.output.start).text);
    const portOk = ready.port === null || (await portOpen(ready.port));
    if (session.status !== "running" || signal.aborted) return false;
    if (patternOk && portOk) {
      if (!session.ready) {
        session.ready = true;
        session.bump();
      }
      return true;
    }
    const left = deadline - Date.now();
    if (session.status !== "running" || left <= 0 || signal.aborted) return false;
    await session.changed(Math.min(left, 250), signal);
  }
}
