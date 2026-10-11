import { TerminalControlInput, TerminalInput } from "@socrates/contracts";
import type { z } from "zod";
import { countTokens, truncateToTokens, zonedParts } from "@socrates/shared";
import { RESULT_CEILING_TOKENS, headTail } from "../bounds";
import { canReadAutomatically } from "../access";
import { type HandlerContext, requireWorkspace, throwIfCancelled } from "../context";
import { ToolError } from "../errors";
import { statOrNull } from "../files";
import { type ToolHandler, type ToolOutput, json } from "../handler";
import { KEY_BYTES } from "../pty";
import type { OutputMeta, OutputOrigin } from "../output-archive";
import { renderScreen } from "../screen";
import { type LaunchSpec, type TerminalSession, type TerminalSupervisor, awaitReady, commandEnvironment, listeningPorts, portOpen, readyNow, settles } from "../terminals";

export const DEFAULT_YIELD_MS = 10_000;
export const MAX_YIELD_MS = 30_000;
/** Deadline for an ordinary foreground command when none is given. */
export const DEFAULT_FOREGROUND_TIMEOUT_MS = 600_000;
export const DEFAULT_READY_TIMEOUT_MS = 30_000;
/** Policy maximum for one terminal_control wait. */
export const MAX_WAIT_MS = 600_000;
const OUTPUT_TOKENS = RESULT_CEILING_TOKENS - 500;
const READ_DEFAULT_LINES = 200;
const READ_MAX_LINES = 2000;
/** A pseudo-terminal's size until it is resized. */
export const PTY_SIZE = { cols: 120, rows: 40 };
/** The agent does not write to a terminal the user has typed into this recently: the user may be answering it. */
export const USER_TYPING_MS = 8_000;
/** Keys that need a terminal: over pipes there is nothing to send them to. */
const PIPE_KEYS = new Set(["ENTER", "CTRL_C", "CTRL_D"]);

/** What a running call shows the user of its output: the newest end, at most every this often. */
const PROGRESS_CHARS = 4_000;
const PROGRESS_EVERY_MS = 200;

const TEST_COMMAND = /(^|[\s;&|/])(pytest|vitest|jest|mocha|ava|rspec|phpunit|ctest|tox|nox|playwright test|go test|cargo test|dotnet test|mvn test|gradle test|(npm|pnpm|yarn|bun)( run)? test\S*|make test\S*)(\s|$)/;

function supervisor(ctx: HandlerContext): TerminalSupervisor {
  requireWorkspace(ctx);
  if (!ctx.terminals) throw new Error("A workspace without a terminal supervisor.");
  return ctx.terminals;
}

function compilePattern(pattern: string, field: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new ToolError("invalid_pattern", `${field} is not a valid regular expression: ${(error as Error).message}`, "Fix the expression (JavaScript regex syntax).");
  }
}

/** Text within `limit` tokens, keeping its start and end. Results show a preview (the supervisor's preview budget); reads may fill a page. */
function bounded(text: string, hint: string, limit = OUTPUT_TOKENS) {
  let budget = limit;
  let out = headTail(text, budget, hint);
  while (countTokens(json(out.text)) > limit) {
    budget = Math.floor(budget * 0.8);
    out = headTail(text, budget, hint);
  }
  return out;
}

function exitFields(s: TerminalSession) {
  return { exit_code: s.exitCode, signal: s.signal };
}

export const terminalTool: ToolHandler<TerminalInput> = {
  name: "terminal",
  description: [
    "Run a bash command, non-interactively over pipes (no pagers, colors or credential prompts). For an interactive program (a prompt, REPL, installer question, editor or TUI) set pty: true and answer it with terminal_control.",
    `It waits up to yield_ms (default ${DEFAULT_YIELD_MS}, max ${MAX_YIELD_MS}): a finished command returns "completed" with exit_code and output; one still running stays alive as a session (status "running") for terminal_control. timeout_ms defaults to ${DEFAULT_FOREGROUND_TIMEOUT_MS / 60000} minutes in the foreground, none in the background.`,
    "For servers and watchers set background: true, a name and ready.",
    "Long output shows its start and end; all is saved as output_id: read it with terminal_control, not by redirecting to files or rerunning. Prefer read, glob, grep, edit and apply_patch over cat, find, grep, sed or echo redirection.",
  ].join(" "),
  schema: TerminalInput,
  concurrency: "serial",
  mutating: true,
  async execute(input, ctx) {
    const terminals = supervisor(ctx);
    const cwd = await ctx.path(input.cwd ?? ".", "run");
    const info = await statOrNull(cwd.abs);
    if (!info?.isDirectory()) throw new ToolError("directory_not_found", `cwd ${cwd.rel} is not an existing directory.`, "Use an existing directory, or omit cwd to run in the workspace root.");
    if (input.ready?.pattern) compilePattern(input.ready.pattern, "ready.pattern");
    if (input.timeout_ms === 0) await ctx.requireApproval({ kind: "no_deadline", tool: "terminal", detail: `Run without a deadline: ${input.command}` });
    terminals.assertCanLaunch(input.name ?? null);

    const spec: LaunchSpec = {
      command: input.command,
      cwd: cwd.abs,
      cwdRel: cwd.rel,
      env: commandEnvironment(input.env),
      timeoutMs: input.timeout_ms === 0 ? null : (input.timeout_ms ?? (input.background ? null : DEFAULT_FOREGROUND_TIMEOUT_MS)),
      background: input.background ?? false,
      name: input.name ?? null,
      ready: input.ready && (input.ready.pattern || input.ready.port)
        ? { pattern: input.ready.pattern ?? null, port: input.ready.port ?? null, timeoutMs: input.ready.timeout_ms ?? DEFAULT_READY_TIMEOUT_MS }
        : null,
      pty: input.pty ? { ...PTY_SIZE } : null,
      origin: originOf(ctx),
      owner: ownerOf(ctx),
    };
    const started = Date.now();
    throwIfCancelled(ctx.signal);
    const session = launch(ctx, terminals, spec);
    const unwatch = watchOutput(session, ctx);
    try {
      return await finishLaunch(ctx, terminals, session, spec, input.yield_ms, started);
    } finally {
      unwatch();
    }
  },
};

/** Wait for a foreground command up to its yield, or for a ready condition; a command still running stays a session. */
async function finishLaunch(ctx: HandlerContext, terminals: TerminalSupervisor, session: TerminalSession, spec: LaunchSpec, yieldInput: number | undefined, started: number): Promise<ToolOutput> {
  if (!spec.background) {
    const yieldMs = Math.min(yieldInput ?? DEFAULT_YIELD_MS, MAX_YIELD_MS);
    await settles(session, yieldMs, ctx.signal);
    if (ctx.signal.aborted) {
      await terminals.terminate(session);
      throw new ToolError("cancelled", "The command was cancelled and stopped.", "No action needed.", false);
    }
    if (session.status === "exited") {
      terminals.finishForeground(session);
      return withFinalScreen(session, completed(session, started, terminals.previewTokens));
    }
  }
  if (spec.ready) await awaitReady(session, ctx.signal);
  if (ctx.signal.aborted) {
    await terminals.terminate(session);
    throw new ToolError("cancelled", "The launch was cancelled and the process was stopped.", "No action needed.", false);
  }
  return withScreen(session, running(session, started, terminals.previewTokens));
}

/**
 * While a call waits on a session, show the user what it prints that the
 * agent has not seen yet: the newest end of it, a few times a second.
 */
function watchOutput(session: TerminalSession, ctx: HandlerContext): () => void {
  const progress = ctx.progress;
  if (!progress) return () => {};
  const from = session.observed;
  const stop = new AbortController();
  void (async () => {
    let sent = from;
    while (!stop.signal.aborted) {
      await session.changed(undefined, stop.signal);
      // Gather a burst into one update.
      await new Promise((done) => setTimeout(done, PROGRESS_EVERY_MS));
      const end = session.output.end;
      if (stop.signal.aborted || end === sent) continue;
      sent = end;
      progress(session.output.slice(Math.max(from, end - PROGRESS_CHARS)).text);
    }
  })();
  return () => stop.abort();
}

/** A result with the program's screen added when it waits for input or has taken over the whole terminal. */
async function withScreen(session: TerminalSession, out: ToolOutput): Promise<ToolOutput> {
  if (!session.screen || !(session.inputRequired() || session.fullscreen)) return out;
  const result = { ...(out.result as object), screen: await screenOf(session) };
  return { ...out, content: json(result), result };
}

/** What a terminal program left on its screen when it ended: a summary where the stream is a pile of redraws. */
async function withFinalScreen(session: TerminalSession, out: ToolOutput): Promise<ToolOutput> {
  const screen = await screenOf(session);
  if (!screen?.text) return out;
  const result = { ...(out.result as object), screen };
  return { ...out, content: json({ ...JSON.parse(out.content as string), screen }), result };
}

/** Which goal and task a session belongs to, such as "g2/t3". */
function originOf(ctx: HandlerContext): string | null {
  try {
    return `g${ctx.store.requireGoal(ctx.binding.goalId).number}/t${ctx.store.requireTask(ctx.binding.taskId).number}`;
  } catch {
    return null;
  }
}

/** Who a session belongs to, by id. */
function ownerOf(ctx: HandlerContext): NonNullable<LaunchSpec["owner"]> {
  return { goalId: ctx.binding.goalId, taskId: ctx.binding.taskId, chatId: ctx.binding.chatId, turnId: ctx.binding.turnId };
}

function originOfSession(session: TerminalSession): OutputOrigin {
  const o = session.spec.owner;
  return { by: session.spec.shell ? "user" : "agent", goalId: o?.goalId ?? null, taskId: o?.taskId ?? null, chatId: o?.chatId ?? null, turnId: o?.turnId ?? null, label: session.spec.origin ?? null };
}

/**
 * Whose run an output is, as the agent reads it (docs/terminal-output-and-memory.md,
 * "Scoping"): this turn, earlier in this chat, another chat by its title, or
 * the user, so another run's output is never taken for its own.
 */
function startedBy(ctx: HandlerContext, origin: OutputOrigin): string {
  if (origin.by === "user") return "the user, in the terminal panel";
  const mine = originOf(ctx);
  if (origin.turnId) {
    if (origin.turnId === ctx.binding.turnId) return "you, in this turn";
    const sameChat = origin.chatId && ctx.binding.chatId ? origin.chatId === ctx.binding.chatId : origin.taskId === ctx.binding.taskId;
    if (sameChat) return "you, earlier in this chat";
  } else if (origin.label && origin.label === mine) return "you, earlier in this chat";
  let title: string | null = null;
  try { title = origin.taskId ? ctx.store.requireTask(origin.taskId).title : null; } catch {}
  const where = [title && `"${title}"`, origin.label].filter(Boolean).join(", ");
  return where ? `another chat (${where})` : "an earlier run (owner unknown)";
}

function statusText(status: string, exitCode: number | null, signal: string | null, reason: string | null): string {
  if (status === "running") return "running";
  if (reason === "timeout") return "timed out";
  if (reason === "terminated") return "stopped";
  if (reason === "interrupted") return "interrupted when Socrates stopped";
  return signal ? `ended by ${signal}` : `exited ${exitCode}`;
}

/** One line saying what an output is: the command, whose run, when, and how it stands. */
function sourceLine(ctx: HandlerContext, command: string, origin: OutputOrigin, startedAt: Date, status: string): string {
  const p = zonedParts(startedAt, ctx.timeZone);
  const cmd = command.length > 80 ? `${command.slice(0, 79)}…` : command;
  return `${cmd} · started by ${startedBy(ctx, origin)} · ${p.weekday.slice(0, 3)} ${p.date} ${p.time} · ${status}`;
}

function sessionSource(ctx: HandlerContext, s: TerminalSession): string {
  return sourceLine(ctx, s.spec.command, originOfSession(s), s.startedAt, statusText(s.status, s.exitCode, s.signal, s.exitReason));
}

/** A cursor names its run: `term-5:c120`. A restarted tab is a new run, so an old cursor cannot read the new one by mistake. */
function cursorOf(session: TerminalSession, offset: number): string {
  return `${session.id}:c${offset}`;
}

/** What a program has drawn on its terminal, for a pseudo-terminal session; nothing over pipes. */
async function screenOf(session: TerminalSession) {
  return session.screen ? renderScreen(await session.screen.snapshot()) : null;
}

function launch(ctx: HandlerContext, terminals: TerminalSupervisor, spec: LaunchSpec): TerminalSession {
  const refs = { goal_id: ctx.binding.goalId, task_id: ctx.binding.taskId, chat_id: ctx.binding.chatId, turn_id: ctx.binding.turnId };
  return terminals.launch(spec, {
    onStart: (s) => ctx.store.recordTerminalStarted(refs, { session_id: s.id, name: spec.name, command: spec.command, cwd: spec.cwdRel, background: spec.background, ...(s.outputId ? { output_id: s.outputId } : {}) }),
    onExit: (s) => {
      try {
        ctx.store.recordTerminalExited(refs, { session_id: s.id, exit_code: s.exitCode, signal: s.signal, reason: s.exitReason ?? "exited", facts: testFacts(s) });
      } catch {
        // The store may already be closed when a session outlives it.
      }
    },
  });
}

/** The command fact belongs to the launching call; a test outcome is derived once, from the session's exit. */
function commandFacts(session: TerminalSession): ToolOutput["facts"] {
  return [{ kind: "command", value: session.spec.command.slice(0, 300) }];
}

function testFacts(session: TerminalSession): { kind: "test"; value: string }[] {
  if (!TEST_COMMAND.test(session.spec.command)) return [];
  const outcome = session.exitReason === "timeout" ? "timed out" : session.exitReason === "terminated" ? "stopped" : `exit ${session.exitCode ?? session.signal}`;
  return [{ kind: "test", value: `${session.spec.command.slice(0, 300)} → ${outcome}` }];
}

/**
 * A finished command. Its output is saved by id (T1): the result keeps a
 * preview and the id, never the whole text. Only when nothing could be saved
 * does the whole retained text go with the call, as before.
 */
function completed(session: TerminalSession, started: number, preview: number): ToolOutput {
  const full = session.output.slice(0);
  const lostChars = full.from;
  const capture = session.capture;
  const saved = capture !== null && capture.meta.gap === null;
  const id = session.outputId;
  const hint = saved
    ? `all ${capture.meta.lines} lines are saved as ${id}; terminal_control read with output ${id} and from_line or search shows the rest`
    : lostChars ? `the first ${lostChars} characters exceeded the retained limit; the rest is stored with this call` : "the complete output is stored with this call";
  const out = bounded(full.text, hint, preview);
  const timedOut = session.exitReason === "timeout";
  const result = {
    status: timedOut ? "timed_out" : "completed",
    terminal: null,
    ...exitFields(session),
    output: out.text,
    truncated: out.truncated || full.lost,
    ...(capture ? { output_id: id, output_lines: capture.meta.lines, ...(saved ? {} : { output_saved: gapText(capture.meta) }) } : {}),
    ...(full.lost && !saved ? { output_lost: true, lost_characters: lostChars } : {}),
    ...(full.lost && saved ? { note: `The start shown is from memory; from_line 1 of ${id} is the true start.` } : {}),
    wall_time_ms: Date.now() - started,
  };
  // Past the per-output cap nothing more is kept either: the event log never takes a huge text.
  const keepFull = !capture || capture.meta.gap === "write_failed";
  return { content: json(result), result: keepFull ? { ...result, output_full: full.text, output_lost: full.lost, lost_characters: lostChars } : result, facts: commandFacts(session) };
}

/** Why a saved output is not complete. */
function gapText(meta: Pick<OutputMeta, "gap" | "complete" | "ended_at">): string {
  if (meta.gap === "cap") return "partly: saving stopped at the size limit for one output";
  if (meta.gap === "write_failed") return "partly: the disk refused a write";
  if (meta.gap === "interrupted") return "partly: Socrates stopped while it was running, so its end may be missing";
  return meta.ended_at ? "complete" : "still saving";
}

function running(session: TerminalSession, started: number, preview: number): ToolOutput {
  const from = session.observed;
  const seen = session.output.slice(from);
  const out = bounded(seen.text, `terminal_control read with cursor ${cursorOf(session, seen.from)} pages through all of it`, preview);
  session.observed = session.output.end;
  const result = {
    status: session.status === "running" ? "running" : "completed",
    terminal: session.selector,
    session_id: session.id,
    ...(session.outputId ? { output_id: session.outputId } : {}),
    ready: session.ready,
    ...(session.proc?.pty ? { pty: true, input_required: session.inputRequired() } : {}),
    ...(session.status === "exited" ? exitFields(session) : {}),
    output: out.text,
    cursor: cursorOf(session, session.observed),
    truncated: out.truncated || seen.lost,
    output_lost: seen.lost,
    wall_time_ms: Date.now() - started,
  };
  return { content: json(result), result, facts: commandFacts(session) };
}

function parseCursor(cursor: string | undefined, session: TerminalSession, terminals: TerminalSupervisor): number {
  if (cursor === undefined) return session.observed;
  const m = /^(?:(term-\d+):)?c(\d+)$/.exec(cursor);
  if (!m) throw new ToolError("invalid_cursor", `${cursor} is not a terminal cursor.`, "Pass a cursor returned by terminal or terminal_control, such as term-3:c120, or omit it.");
  if (m[1] && m[1] !== session.id) {
    const earlier = terminals.outputOf(m[1]);
    throw new ToolError(
      "cursor_other_run",
      `Cursor ${cursor} belongs to ${m[1]}, not to ${session.selector} (${session.id}).`,
      earlier ? `That was another run; its output is saved: read it with terminal_control read output ${earlier}. Omit cursor to read ${session.selector}.` : `Omit cursor to read ${session.selector} from what you last saw.`,
    );
  }
  return Math.min(Number(m[2]), session.output.end);
}

/** Typing from the page more than this long ago is no longer news to the agent. */
const USER_TYPED_NEWS_MS = 300_000;

function identity(session: TerminalSession) {
  const typed = Date.now() - session.userInputAt;
  return {
    terminal: session.selector,
    session_id: session.id,
    status: session.status,
    state_version: session.stateVersion,
    // What the user typed shows in the output as the program echoes it; this says it was the user, not the agent.
    ...(session.userInputAt && typed < USER_TYPED_NEWS_MS ? { user_typed_s_ago: Math.round(typed / 1000) } : {}),
  };
}

/** Unseen output since the agent's last observation, bounded to head and tail. */
function unseen(session: TerminalSession, preview: number) {
  const seen = session.output.slice(session.observed);
  const out = bounded(seen.text, `terminal_control read with cursor ${cursorOf(session, seen.from)} pages through all of it`, preview);
  session.observed = session.output.end;
  return { output: out.text, cursor: cursorOf(session, session.observed), truncated: out.truncated || seen.lost, output_lost: seen.lost };
}

type WaitInput = Extract<z.infer<typeof TerminalControlInput>, { action: "wait" }>;

/** How long a pseudo-terminal is given to draw its answer to a keystroke. */
const SETTLE_DEFAULT_MS = 400;
/** A terminal that has printed nothing for this long has finished drawing, whatever the settle time. */
const SETTLE_QUIET_MS = 120;

/** Wait for one session, or the first of several, to have an event: ready, output, a prompt, exit, a pattern, quiet, or a port. */
async function waitFor(input: WaitInput, ctx: HandlerContext, terminals: TerminalSupervisor): Promise<ToolOutput> {
  if (input.terminal && input.terminals) throw new ToolError("invalid_parameters", "wait takes terminal or terminals, not both.", "Pass one session in terminal, or several in terminals.");
  const names = input.terminals ?? (input.terminal ? [input.terminal] : []);
  if (!names.length) throw new ToolError("invalid_parameters", "wait needs terminal or terminals.", "Pass the session to wait on in terminal, or several in terminals.");
  const sessions = names.map((name) => terminals.find(name));
  const many = sessions.length > 1;
  const pty = sessions.filter((s) => !!s.proc?.pty);
  if (input.event === "input_required" && pty.length < sessions.length) {
    const piped = sessions.find((s) => !s.proc?.pty)!;
    throw new ToolError("needs_pty", `${piped.selector} runs over pipes, where a prompt cannot be told from other output.`, 'Wait for event "pattern" with the prompt text, or start interactive programs with pty: true.');
  }
  if (input.event === "pattern" && !input.pattern) throw new ToolError("invalid_parameters", "wait with event pattern needs pattern.", "Pass pattern, a regular expression to wait for in new output.");
  if ((input.event === "port_open" || input.event === "port_closed") && input.port === undefined) throw new ToolError("invalid_parameters", `wait with event ${input.event} needs port.`, "Pass port, a local TCP port number.");
  if (input.event === "ready") {
    const without = sessions.find((s) => !s.spec.ready);
    if (without) throw new ToolError("no_ready_condition", `${without.selector} was started without a ready condition.`, 'Wait for event "pattern" or "output" instead, or restart it with ready.');
  }
  const pattern = input.event === "pattern" ? compilePattern(input.pattern!, "pattern") : null;
  const idleMs = input.idle_ms ?? 2000;
  const deadline = Date.now() + (input.timeout_ms ?? MAX_WAIT_MS);

  /** The event a session has now, if any. Whatever is waited for, a program that asks for input cannot go on without it, and an exit ends every wait. */
  const happened = async (s: TerminalSession): Promise<string | null> => {
    const fresh = s.output.slice(s.observed).text;
    if (input.event === "exit" && s.status === "exited") return "exit";
    if (input.event === "output" && fresh.length > 0) return "output";
    if (pattern && pattern.test(fresh)) return "pattern";
    if (input.event === "ready" && (s.ready || (s.status === "running" && (await readyNow(s))))) return "ready";
    if (input.event === "idle" && s.status === "running" && Date.now() - s.lastOutputAt >= idleMs) return "idle";
    if (input.event === "port_open" && s.status === "running" && (await portOpen(input.port!))) return "port_open";
    if (input.event === "port_closed" && !(await portOpen(input.port!))) return "port_closed";
    if (s.inputRequired()) return "input_required";
    if (s.status === "exited") return "exit";
    return null;
  };

  const unwatch = many ? () => {} : watchOutput(sessions[0]!, ctx);
  let won: { session: TerminalSession; event: string } | null = null;
  try {
    while (!won) {
      if (ctx.signal.aborted) throw new ToolError("cancelled", "The wait was cancelled.", "No action needed.", false);
      for (const session of sessions) {
        const event = await happened(session);
        if (event) { won = { session, event }; break; }
      }
      if (won) break;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await Promise.race(sessions.map((s) => s.changed(Math.min(250, left), ctx.signal)));
    }
  } finally {
    unwatch();
  }
  if (!won) {
    const summary = sessions.map((s) => ({ terminal: s.selector, status: s.status, ready: s.ready, input_required: s.inputRequired() }));
    if (many) {
      const result = { action: "wait", event: "timeout", terminals: summary };
      return { content: json(result), result };
    }
    won = { session: sessions[0]!, event: "timeout" };
  }
  const { session, event } = won;
  const screen = session.screen && (event === "input_required" || event === "idle" || event === "exit" || session.fullscreen) ? await screenOf(session) : null;
  const result = {
    action: "wait",
    ...identity(session),
    source: sessionSource(ctx, session),
    event,
    ready: session.ready,
    ...(session.proc?.pty ? { input_required: session.inputRequired() } : {}),
    ...unseen(session, terminals.previewTokens),
    ...(screen ? { screen } : {}),
    ...exitFields(session),
    ...(many ? { others: sessions.filter((s) => s !== session).map((s) => ({ terminal: s.selector, status: s.status, ready: s.ready, input_required: s.inputRequired() })) } : {}),
  };
  return { content: json(result), result };
}

type ReadInput = Extract<z.infer<typeof TerminalControlInput>, { action: "read" }>;

/** Matching lines one search returns at most. */
const SEARCH_MAX_HITS = 50;

/**
 * A saved output by its id (T1): lines from `from_line`, or the lines that
 * match `search`. Only outputs of folders this work may read; every result
 * says whose run it is and whether everything it printed was saved.
 */
function readSaved(input: ReadInput, ctx: HandlerContext, terminals: TerminalSupervisor): ToolOutput {
  const archive = terminals.archive;
  const id = input.output!;
  if (!archive) throw new ToolError("output_unavailable", "Terminal output is not saved here.", "Read the session with terminal and cursor instead.", false);
  if ([input.search, input.filter, input.from_line, input.cursor].filter((v) => v !== undefined).length > 1) throw new ToolError("invalid_parameters", "read takes one of cursor, from_line, search and filter.", "Search or filter first; then read from_line near a match.");
  const cursor = input.cursor?.match(/^(out_[0-9a-f]{12}):l([1-9][0-9]*):c([0-9]+)$/);
  if (input.cursor && (!cursor || !Number.isSafeInteger(Number(cursor[2])) || !Number.isSafeInteger(Number(cursor[3])))) {
    throw new ToolError("invalid_parameters", "Invalid saved-output cursor.", "Use next_cursor from a read of this output.");
  }
  if (cursor && cursor[1] !== id) throw new ToolError("cursor_other_run", "This cursor belongs to another saved output.", `Read output ${cursor[1]} with this cursor.`);
  // A regular expression without a global flag tests each line on its own.
  const pattern = input.filter !== undefined ? compilePattern(input.filter, "filter") : null;
  const meta = archive.meta(id);
  if (!meta) throw new ToolError("output_not_found", `${id} is not a saved terminal output.`, "Use an output_id from a terminal result or terminal_control list.");
  const workspace = requireWorkspace(ctx);
  if (meta.workspace !== workspace.root && !canReadAutomatically(ctx.access, meta.workspace)) {
    throw new ToolError("output_out_of_scope", `${id} was saved by a terminal in ${meta.workspace}, a folder this work may not read.`, "Read output of terminals in this project.", false);
  }
  const status = meta.ended_at ? statusText("exited", meta.exit_code, meta.signal, meta.reason) : "running";
  const header = {
    action: "read",
    output_id: id,
    source: sourceLine(ctx, meta.command, meta.origin, new Date(meta.started_at), status),
    saved: gapText(meta),
    total_lines: meta.lines,
  };
  if (meta.removed_at) {
    const when = zonedParts(new Date(meta.removed_at), ctx.timeZone);
    throw new ToolError("output_removed", `${id} (${meta.command.slice(0, 80)}) was removed on ${when.weekday.slice(0, 3)} ${when.date}, ${meta.removed_reason === "age" ? "when it reached the age limit" : "to stay within the space limit"}.`, "Run the command again if its output is still needed.", false);
  }
  const page = OUTPUT_TOKENS - 300;
  if (input.search !== undefined || pattern) {
    const found = archive.search(id, pattern ?? input.search!, Math.min(input.limit_lines ?? SEARCH_MAX_HITS, SEARCH_MAX_HITS), page);
    const result = {
      ...header,
      ...(pattern ? { filter: input.filter } : { search: input.search }),
      matches: found.hits,
      more_matches: found.more,
      scanned_lines: found.scanned_lines,
      search_complete: !found.more && found.skipped_lines === 0,
      ...(found.skipped_lines ? { skipped_lines: found.skipped_lines, coverage: "Regex skipped lines over 2 Mi characters; use literal search or page with next_cursor." } : {}),
      ...(found.more ? { note: "More lines match: narrow the search, or read from_line after the last match." } : {}),
      ...(meta.ended_at ? {} : { still_running: "lines printed after this search were not searched" }),
    };
    return { content: json(result), result };
  }
  const from = cursor ? Number(cursor[2]) : input.from_line ?? 1;
  const lines = archive.readLines(id, from, Math.min(input.limit_lines ?? READ_DEFAULT_LINES, READ_MAX_LINES), page, cursor ? Number(cursor[3]) : 0);
  const { text: output, ...position } = lines;
  const result = { ...header, ...position, output };
  return { content: json(result), result };
}

export const terminalControlTool: ToolHandler<TerminalControlInput> = {
  name: "terminal_control",
  description: [
    "Manage this workspace's agent and user terminals; terminal is a name or session id.",
    "list: live and recently exited sessions, with ports, age and quiet time.",
    "screen: a pty session's screen as drawn (cursor, selected lines); read menus and TUIs this way.",
    `read: session output after cursor, limit_lines (default ${READ_DEFAULT_LINES}), filter (regex); saved output id: from_line (default 1), search (text), filter, or next_cursor as cursor to continue long lines.`,
    `wait: until event: ready, output, exit, pattern (regex in new output), input_required (a pty prompt is waiting), idle (quiet for idle_ms, default 2000), port_open or port_closed (port). terminals waits on several; the first wins. timeout_ms (default and max ${MAX_WAIT_MS / 60000} minutes) ends it with event timeout.`,
    "write: input (submit adds Enter, default true) and/or keys; over pipes only ENTER, CTRL_C, CTRL_D. A pty answers with its screen after settle_ms (default 400): choose the next key from it. Refused for a few seconds after the user types in that terminal.",
    "signal: to the process group (SIGKILL asks the user). terminate: gracefully, then forcibly. restart: the same launch again. resize: a pty's cols and rows.",
  ].join(" "),
  schema: TerminalControlInput,
  concurrency: "serial",
  mutating: (input) => !["list", "read", "wait", "resize", "screen"].includes(input.action),
  async execute(input, ctx) {
    const terminals = supervisor(ctx);
    if (input.action === "list") {
      const now = Date.now();
      const rows = await Promise.all(terminals.list().map(async (s) => ({
        terminal: s.selector,
        session_id: s.id,
        status: s.status,
        ready: s.ready,
        input_required: s.inputRequired(),
        ...(s.status === "running" && s.proc?.pid ? { listening_ports: await listeningPorts(s.proc.pid) } : {}),
        cwd: s.spec.cwdRel,
        cwd_absolute: s.spec.cwd,
        command: s.spec.command.slice(0, 200),
        started_by: startedBy(ctx, originOfSession(s)),
        ...(s.spec.origin ? { started_in: s.spec.origin } : {}),
        ...(s.outputId ? { output_id: s.outputId } : {}),
        started_at: s.startedAt.toISOString(),
        running_for_s: Math.round(((s.exitedAt?.getTime() ?? now) - s.startedAt.getTime()) / 1000),
        ...(s.status === "running" ? { quiet_for_s: Math.round((now - s.lastOutputAt) / 1000) } : {}),
        ...(s.userInputAt ? { user_typed_s_ago: Math.round((now - s.userInputAt) / 1000) } : {}),
        ...exitFields(s),
      })));
      const result = { action: "list", terminals: rows };
      return { content: json(result), result };
    }

    if (input.action === "wait") return waitFor(input, ctx, terminals);
    if (input.action === "read" && input.output) return readSaved(input, ctx, terminals);
    if (input.action === "read" && (input.from_line !== undefined || input.search !== undefined)) {
      throw new ToolError("invalid_parameters", "from_line and search read a saved output.", "Pass output (an output_id) with them, or read the session with cursor and filter.");
    }
    if (!input.terminal) throw new ToolError("invalid_parameters", "read needs terminal or output.", "Pass a session in terminal, or a saved output's output_id in output.");
    const session = terminals.find(input.terminal);
    switch (input.action) {
      case "screen": {
        if (!session.screen) throw new ToolError("needs_pty", `${session.selector} runs over pipes, which have no screen.`, "Start the program with pty: true, or use read for its output.");
        const result = { action: "screen", ...identity(session), source: sessionSource(ctx, session), input_required: session.inputRequired(), screen: await screenOf(session), ...exitFields(session) };
        return { content: json(result), result };
      }

      case "read": {
        const from = parseCursor(input.cursor, session, terminals);
        const slice = session.output.slice(from);
        const maxLines = Math.min(input.limit_lines ?? READ_DEFAULT_LINES, READ_MAX_LINES);
        const filter = input.filter ? compilePattern(input.filter, "filter") : null;
        let shown = "";
        let scanned = 0;
        let count = 0;
        let tokens = 0;
        let rest = slice.text;
        while (rest && count < maxLines) {
          const newline = rest.indexOf("\n");
          const piece = newline < 0 ? rest : rest.slice(0, newline + 1);
          // A filtered read skips lines that do not match, and still moves past them.
          if (filter && !filter.test(piece)) {
            rest = rest.slice(piece.length);
            scanned += piece.length;
            continue;
          }
          const cost = countTokens(json(piece));
          if (tokens + cost > OUTPUT_TOKENS) {
            // A line larger than what is left of the page is paged through, never skipped.
            if (count === 0) {
              let budget = OUTPUT_TOKENS;
              shown = truncateToTokens(piece, budget).text;
              while (countTokens(json(shown)) > OUTPUT_TOKENS) {
                budget = Math.floor(budget * 0.8);
                shown = truncateToTokens(piece, budget).text;
              }
              scanned += shown.length;
            }
            break;
          }
          shown += piece;
          scanned += piece.length;
          tokens += cost;
          rest = rest.slice(piece.length);
          count++;
        }
        const next = slice.from + scanned;
        const end = Math.min(next, session.output.end);
        session.observed = Math.max(session.observed, end);
        const result = {
          action: "read",
          ...identity(session),
          source: sessionSource(ctx, session),
          ...(session.outputId ? { output_id: session.outputId } : {}),
          event: null,
          ...(filter ? { filter: input.filter } : {}),
          output: shown,
          cursor: cursorOf(session, end),
          truncated: end < session.output.end,
          output_lost: slice.lost,
          ...exitFields(session),
        };
        return { content: json(result), result };
      }

      case "write": {
        await ctx.path(session.spec.cwd, "run");
        if (input.input === undefined && !input.keys?.length) throw new ToolError("invalid_parameters", "write needs input or keys.", "Pass input text, keys, or both.");
        if (session.status !== "running") throw new ToolError("terminal_exited", `${session.selector} has exited (exit code ${session.exitCode}).`, "Restart it with terminal_control restart, or start a new command.");
        const proc = session.proc;
        if (!proc) throw new ToolError("stdin_closed", `${session.selector} no longer accepts input.`, "Restart it, or start a new command.");
        const typed = Date.now() - session.userInputAt;
        if (typed < USER_TYPING_MS) {
          throw new ToolError("user_typing", `The user typed into ${session.selector} ${Math.max(1, Math.round(typed / 1000))}s ago, in the terminal panel.`, "The user may be answering it themselves: wait a few seconds, look at its screen, and write only what is still needed.");
        }
        if (proc.pty) {
          // A terminal receives keys as the bytes a keyboard sends; Enter is a carriage return.
          if (input.input !== undefined) proc.write(input.input + ((input.submit ?? true) ? "\r" : ""));
          for (const key of input.keys ?? []) proc.write(KEY_BYTES[key]!);
        } else {
          const unsupported = input.keys?.filter((k) => !PIPE_KEYS.has(k)) ?? [];
          if (unsupported.length) throw new ToolError("needs_pty", `Keys ${unsupported.join(", ")} need a terminal, and ${session.selector} runs over pipes.`, "Use input text, ENTER, CTRL_C or CTRL_D, or restart the program with pty: true.");
          if (!session.stdinOpen) throw new ToolError("stdin_closed", `${session.selector} no longer accepts input.`, "Restart it, or start a new command.");
          if (input.input !== undefined) proc.write(input.input + ((input.submit ?? true) ? "\n" : ""));
          for (const key of input.keys ?? []) {
            if (key === "ENTER") proc.write("\n");
            else if (key === "CTRL_C") terminals.signal(session, "SIGINT");
            else if (key === "CTRL_D") {
              proc.closeInput();
              session.stdinOpen = false;
            }
          }
        }
        const wrote = Date.now();
        session.answeredAt = wrote;
        session.bump();
        // A terminal redraws in answer to a key; show the result, so the next key is chosen from what the screen shows.
        if (session.screen) {
          const limit = wrote + (input.settle_ms ?? SETTLE_DEFAULT_MS);
          while (Date.now() < limit && !ctx.signal.aborted && !(session.lastOutputAt > wrote && Date.now() - session.lastOutputAt >= SETTLE_QUIET_MS)) await session.changed(50, ctx.signal);
          const result = { action: "write", ...identity(session), accepted: true, input_required: session.inputRequired(), screen: await screenOf(session) };
          return { content: json(result), result };
        }
        const result = { action: "write", ...identity(session), accepted: true };
        return { content: json(result), result };
      }

      case "signal": {
        if (session.status !== "running") throw new ToolError("terminal_exited", `${session.selector} has already exited.`, "No signal is needed.");
        if (input.signal === "SIGKILL") await ctx.requireApproval({ kind: "sigkill", tool: "terminal_control", detail: `Force-kill ${session.selector}: ${session.spec.command}` });
        terminals.signal(session, input.signal);
        await settles(session, 500);
        session.bump();
        const result = { action: "signal", ...identity(session), accepted: true, ...exitFields(session) };
        return { content: json(result), result };
      }

      case "terminate": {
        await terminals.terminate(session);
        const result = { action: "terminate", ...identity(session), accepted: true, ...exitFields(session) };
        return { content: json(result), result };
      }

      case "restart": {
        await ctx.path(session.spec.cwd, "run");
        const started = Date.now();
        await terminals.terminate(session);
        throwIfCancelled(ctx.signal);
        // The new run is this turn's.
        const replacement = launch(ctx, terminals, { ...session.spec, origin: session.spec.shell ? session.spec.origin : originOf(ctx), owner: session.spec.shell ? session.spec.owner : ownerOf(ctx) });
        terminals.forget(session);
        if (replacement.spec.ready) await awaitReady(replacement, ctx.signal);
        else await settles(replacement, 1000, ctx.signal);
        if (ctx.signal.aborted) {
          await terminals.terminate(replacement);
          throwIfCancelled(ctx.signal);
        }
        const out = running(replacement, started, terminals.previewTokens);
        const result = { action: "restart", previous_session_id: session.id, ...(out.result as object), state_version: replacement.stateVersion };
        return { content: json(result), result, facts: out.facts ?? [] };
      }

      case "resize": {
        if (session.status !== "running") throw new ToolError("terminal_exited", `${session.selector} has already exited.`, "No resize is needed.");
        if (!session.proc?.pty) throw new ToolError("needs_pty", `${session.selector} runs over pipes, which have no size.`, "Start the program with pty: true to give it a terminal size.");
        session.proc.resize(input.cols, input.rows);
        session.bump();
        const result = { action: "resize", ...identity(session), accepted: true, cols: input.cols, rows: input.rows };
        return { content: json(result), result };
      }
    }
  },
};
