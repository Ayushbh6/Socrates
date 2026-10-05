import { TerminalControlInput, TerminalInput } from "@socrates/contracts";
import { countTokens, truncateToTokens } from "@socrates/shared";
import { RESULT_CEILING_TOKENS, headTail } from "../bounds";
import { type HandlerContext, requireWorkspace, throwIfCancelled } from "../context";
import { ToolError } from "../errors";
import { statOrNull } from "../files";
import { type ToolHandler, type ToolOutput, json } from "../handler";
import { KEY_BYTES } from "../pty";
import { type LaunchSpec, type TerminalSession, type TerminalSupervisor, awaitReady, commandEnvironment, settles } from "../terminals";

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

function bounded(text: string, hint: string) {
  let budget = OUTPUT_TOKENS;
  let out = headTail(text, budget, hint);
  while (countTokens(json(out.text)) > OUTPUT_TOKENS) {
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
    "Run a shell command (bash) in the workspace. Commands run non-interactively over pipes: no pagers, colors, or credential prompts.",
    `For an interactive program (a prompt, REPL, installer question, editor, or TUI) set pty: true: it runs in a ${PTY_SIZE.cols}×${PTY_SIZE.rows} pseudo-terminal, its output is shown as plain text, and terminal_control can send it text and keys and tell when it waits for input.`,
    `The call waits up to yield_ms (default ${DEFAULT_YIELD_MS}, max ${MAX_YIELD_MS}). A command that finishes returns status "completed" with exit_code and output; one still running is kept alive as a terminal session (status "running") that terminal_control can read, wait on, write to, or stop.`,
    `timeout_ms is the real deadline (default ${DEFAULT_FOREGROUND_TIMEOUT_MS / 60000} minutes for foreground commands, none for background); 0 asks the user for no deadline.`,
    'For servers and watchers set background: true, a name such as "dev-server", and ready (an output pattern and/or a local port) to return once it is ready.',
    "Long output returns its beginning and end; retained output is available through terminal_control or the evidence handle. Retention is bounded (four million characters for background sessions, sixteen million for foreground), and any loss is reported. Prefer read, glob, grep, edit, and apply_patch over cat, find, grep, sed, or echo redirection.",
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
      terminals.forget(session);
      return completed(session, started);
    }
  }
  if (spec.ready) await awaitReady(session, ctx.signal);
  if (ctx.signal.aborted) {
    await terminals.terminate(session);
    throw new ToolError("cancelled", "The launch was cancelled and the process was stopped.", "No action needed.", false);
  }
  return running(session, started);
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

function launch(ctx: HandlerContext, terminals: TerminalSupervisor, spec: LaunchSpec): TerminalSession {
  const refs = { goal_id: ctx.binding.goalId, task_id: ctx.binding.taskId, chat_id: ctx.binding.chatId, turn_id: ctx.binding.turnId };
  return terminals.launch(spec, {
    onStart: (s) => ctx.store.recordTerminalStarted(refs, { session_id: s.id, name: spec.name, command: spec.command, cwd: spec.cwdRel, background: spec.background }),
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

function completed(session: TerminalSession, started: number): ToolOutput {
  const full = session.output.slice(0);
  const lostChars = full.from;
  const out = bounded(full.text, lostChars ? `the first ${lostChars} characters exceeded the retained limit; the rest is stored with this call` : "the complete output is stored with this call");
  const timedOut = session.exitReason === "timeout";
  const result = {
    status: timedOut ? "timed_out" : "completed",
    terminal: null,
    ...exitFields(session),
    output: out.text,
    truncated: out.truncated || full.lost,
    ...(full.lost ? { output_lost: true, lost_characters: lostChars } : {}),
    wall_time_ms: Date.now() - started,
  };
  return { content: json(result), result: { ...result, output_full: full.text, output_lost: full.lost, lost_characters: lostChars }, facts: commandFacts(session) };
}

function running(session: TerminalSession, started: number): ToolOutput {
  const from = session.observed;
  const seen = session.output.slice(from);
  const out = bounded(seen.text, `terminal_control read with cursor c${seen.from} pages through all of it`);
  session.observed = session.output.end;
  const result = {
    status: session.status === "running" ? "running" : "completed",
    terminal: session.selector,
    session_id: session.id,
    ready: session.ready,
    ...(session.proc?.pty ? { pty: true, input_required: session.inputRequired() } : {}),
    ...(session.status === "exited" ? exitFields(session) : {}),
    output: out.text,
    cursor: `c${session.observed}`,
    truncated: out.truncated || seen.lost,
    output_lost: seen.lost,
    wall_time_ms: Date.now() - started,
  };
  return { content: json(result), result, facts: commandFacts(session) };
}

function parseCursor(cursor: string | undefined, session: TerminalSession): number {
  if (cursor === undefined) return session.observed;
  const m = /^c(\d+)$/.exec(cursor);
  if (!m) throw new ToolError("invalid_cursor", `${cursor} is not a terminal cursor.`, "Pass a cursor returned by terminal or terminal_control, such as c120, or omit it.");
  return Math.min(Number(m[1]), session.output.end);
}

function identity(session: TerminalSession) {
  return { terminal: session.selector, session_id: session.id, status: session.status, state_version: session.stateVersion };
}

/** Unseen output since the agent's last observation, bounded to head and tail. */
function unseen(session: TerminalSession) {
  const seen = session.output.slice(session.observed);
  const out = bounded(seen.text, `terminal_control read with cursor c${seen.from} pages through all of it`);
  session.observed = session.output.end;
  return { output: out.text, cursor: `c${session.observed}`, truncated: out.truncated || seen.lost, output_lost: seen.lost };
}

export const terminalControlTool: ToolHandler<TerminalControlInput> = {
  name: "terminal_control",
  description: [
    "Manage terminal sessions started by terminal, selected by name or session id. Actions:",
    "list — all live sessions and recently exited ones;",
    `read — retained output after cursor (default: after what you last received), paged by limit_lines (default ${READ_DEFAULT_LINES}); filter keeps only lines matching a regex;`,
    `wait — block until event happens: ready, output (new output), exit, pattern (a regex in new output), or input_required (a pty session showing a prompt and waiting); returns event "timeout" after ${MAX_WAIT_MS / 60000} minutes;`,
    "write — send input text (submit adds Enter, default true) and/or keys: over pipes ENTER, CTRL_C and CTRL_D; in a pty also TAB, ESCAPE, BACKSPACE, DELETE, arrows, HOME, END, PAGE_UP, PAGE_DOWN, CTRL_L and CTRL_Z;",
    "signal — send SIGINT, SIGTERM, SIGHUP, SIGTSTP, or SIGKILL (asks the user) to the process group;",
    "terminate — stop the process tree gracefully, then forcibly; restart — stop it and run the same launch again under the same name; resize — set a pty session's columns and rows.",
  ].join(" "),
  schema: TerminalControlInput,
  concurrency: "serial",
  mutating: (input) => !["list", "read", "wait", "resize"].includes(input.action),
  async execute(input, ctx) {
    const terminals = supervisor(ctx);
    if (input.action === "list") {
      const rows = terminals.list().map((s) => ({
        terminal: s.selector,
        session_id: s.id,
        status: s.status,
        ready: s.ready,
        input_required: s.inputRequired(),
        cwd: s.spec.cwdRel,
        command: s.spec.command.slice(0, 200),
        started_at: s.startedAt.toISOString(),
        ...exitFields(s),
      }));
      const result = { action: "list", terminals: rows };
      return { content: json(result), result };
    }

    const session = terminals.find(input.terminal);
    switch (input.action) {
      case "read": {
        const from = parseCursor(input.cursor, session);
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
          event: null,
          ...(filter ? { filter: input.filter } : {}),
          output: shown,
          cursor: `c${end}`,
          truncated: end < session.output.end,
          output_lost: slice.lost,
          ...exitFields(session),
        };
        return { content: json(result), result };
      }

      case "wait": {
        if (input.event === "input_required" && !session.proc?.pty) {
          throw new ToolError("needs_pty", `${session.selector} runs over pipes, where a prompt cannot be told from other output.`, 'Wait for event "pattern" with the prompt text, or start interactive programs with pty: true.');
        }
        if (input.event === "pattern" && !input.pattern) throw new ToolError("invalid_parameters", "wait with event pattern needs pattern.", "Pass pattern, a regular expression to wait for in new output.");
        if (input.event === "ready" && !session.spec.ready) throw new ToolError("no_ready_condition", `${session.selector} was started without a ready condition.`, 'Wait for event "pattern" or "output" instead, or restart it with ready.');
        const pattern = input.event === "pattern" ? compilePattern(input.pattern!, "pattern") : null;
        const deadline = Date.now() + MAX_WAIT_MS;
        let event: string | null = null;
        const unwatch = watchOutput(session, ctx);
        try {
          while (event === null) {
            if (ctx.signal.aborted) throw new ToolError("cancelled", "The wait was cancelled.", "No action needed.", false);
            const fresh = session.output.slice(session.observed).text;
            if (input.event === "exit" && session.status === "exited") event = "exit";
            else if (input.event === "output" && fresh.length > 0) event = "output";
            else if (pattern && pattern.test(fresh)) event = "pattern";
            else if (input.event === "ready" && session.ready) event = "ready";
            // Whatever it waits for, a program that asks for input cannot go on until it gets some: say so now, not at the deadline.
            else if (session.inputRequired()) event = "input_required";
            else if (input.event === "ready" && session.status === "running" && (await awaitReady(session, ctx.signal, Math.max(1, deadline - Date.now())))) event = "ready";
            else if (session.status === "exited") event = "exit";
            else if (Date.now() >= deadline) event = "timeout";
            else await session.changed(Math.min(250, deadline - Date.now()), ctx.signal);
          }
        } finally {
          unwatch();
        }
        const result = { action: "wait", ...identity(session), event, ready: session.ready, ...(session.proc?.pty ? { input_required: session.inputRequired() } : {}), ...unseen(session), ...exitFields(session) };
        return { content: json(result), result };
      }

      case "write": {
        await ctx.path(session.spec.cwd, "run");
        if (input.input === undefined && !input.keys?.length) throw new ToolError("invalid_parameters", "write needs input or keys.", "Pass input text, keys, or both.");
        if (session.status !== "running") throw new ToolError("terminal_exited", `${session.selector} has exited (exit code ${session.exitCode}).`, "Restart it with terminal_control restart, or start a new command.");
        const proc = session.proc;
        if (!proc) throw new ToolError("stdin_closed", `${session.selector} no longer accepts input.`, "Restart it, or start a new command.");
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
        session.answeredAt = Date.now();
        session.bump();
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
        const replacement = launch(ctx, terminals, session.spec);
        if (replacement.spec.ready) await awaitReady(replacement, ctx.signal);
        else await settles(replacement, 1000, ctx.signal);
        if (ctx.signal.aborted) {
          await terminals.terminate(replacement);
          throwIfCancelled(ctx.signal);
        }
        const out = running(replacement, started);
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
