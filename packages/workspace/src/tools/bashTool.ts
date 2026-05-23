import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { BashToolInput, BashToolOutput } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { clampCharLimit, resolveWorkspacePath } from "./common"

type ShellRunContext = {
  abortSignal?: AbortSignal
  onOutput?: (output: { stream: "stdout" | "stderr" | "log"; text: string }) => void
}

const interactiveCommandPattern =
  /^\s*(vi|vim|nvim|nano|emacs|less|more|top|htop|ssh|scp|sftp|ftp|passwd)\b|\b(--interactive|-i)\b/

const markerHoldback = 256

export class WorkspaceShellSession {
  private child: ChildProcessWithoutNullStreams | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(private readonly workspacePath: string) {}

  run(input: BashToolInput, context: ShellRunContext = {}): Promise<BashToolOutput> {
    const run = this.queue.then(() => this.runNow(input, context))
    this.queue = run.catch(() => undefined)
    return run
  }

  dispose(): void {
    this.disposed = true
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM")
    }
    this.child = null
  }

  private async runNow(input: BashToolInput, context: ShellRunContext): Promise<BashToolOutput> {
    if (this.disposed) {
      throw new SocratesError("shell_session_disposed", "The shell session has already ended.")
    }
    rejectLeadingExternalCd(input.command, this.workspacePath)
    if (interactiveCommandPattern.test(input.command)) {
      throw new SocratesError(
        "interactive_shell_command_unsupported",
        "Interactive shell commands are not supported yet. Run a non-interactive command instead.",
        { details: { command: input.command }, recoverable: true },
      )
    }

    const startedAt = Date.now()
    const requestedCwd = input.cwd ? resolveWorkspacePath(this.workspacePath, input.cwd) : undefined
    const timeoutMs = input.timeoutMs ?? 120_000
    const charLimit = clampCharLimit(input.charLimit)
    const id = randomUUID().replaceAll("-", "")
    const cwdMarker = `__SOCRATES_CWD_${id}__`
    const doneMarker = `__SOCRATES_DONE_${id}__`
    let stdout = ""
    let stderr = ""
    let stdoutPending = ""
    let returnedLength = 0
    let originalLength = 0
    let truncated = false
    let timedOut = false
    let finalCwd = requestedCwd ?? this.workspacePath
    let resolved = false
    let forceReset = false

    const child = this.ensureChild()

    const append = (stream: "stdout" | "stderr", text: string) => {
      if (!text) {
        return
      }
      originalLength += text.length
      const remaining = Math.max(charLimit - returnedLength, 0)
      if (remaining <= 0) {
        truncated = true
        return
      }
      const sliced = text.slice(0, remaining)
      returnedLength += sliced.length
      if (sliced.length < text.length) {
        truncated = true
      }
      if (stream === "stdout") {
        stdout += sliced
      } else {
        stderr += sliced
      }
      context.onOutput?.({ stream, text: sliced })
    }

    const drainStdout = () => {
      for (;;) {
        const cwdIndex = stdoutPending.indexOf(cwdMarker)
        const doneIndex = stdoutPending.indexOf(doneMarker)
        const indexes = [cwdIndex, doneIndex].filter((index) => index >= 0)
        if (indexes.length === 0) {
          const flushLength = stdoutPending.length - markerHoldback
          if (flushLength > 0) {
            append("stdout", stdoutPending.slice(0, flushLength))
            stdoutPending = stdoutPending.slice(flushLength)
          }
          return
        }

        const markerIndex = Math.min(...indexes)
        append("stdout", stdoutPending.slice(0, markerIndex))
        stdoutPending = stdoutPending.slice(markerIndex)

        if (stdoutPending.startsWith(cwdMarker)) {
          const newlineIndex = stdoutPending.indexOf("\n")
          if (newlineIndex < 0) {
            return
          }
          finalCwd = stdoutPending.slice(cwdMarker.length, newlineIndex).trim() || finalCwd
          stdoutPending = stdoutPending.slice(newlineIndex + 1)
          continue
        }

        if (stdoutPending.startsWith(doneMarker)) {
          const newlineIndex = stdoutPending.indexOf("\n")
          if (newlineIndex < 0) {
            return
          }
          const rawExitCode = stdoutPending.slice(doneMarker.length, newlineIndex).trim()
          stdoutPending = stdoutPending.slice(newlineIndex + 1)
          resolved = true
          return Number.parseInt(rawExitCode, 10)
        }
      }
    }

    return await new Promise<BashToolOutput>((resolve, reject) => {
      const finish = (output: BashToolOutput) => {
        cleanup()
        resolve(output)
      }
      const fail = (error: unknown) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        clearTimeout(timeout)
        clearTimeout(killTimeout)
        child.stdout.off("data", onStdout)
        child.stderr.off("data", onStderr)
        child.off("close", onClose)
        child.off("error", fail)
        context.abortSignal?.removeEventListener("abort", onAbort)
      }
      const makeOutput = (exitCode: number | null, signal?: string | null): BashToolOutput => ({
        command: input.command,
        cwd: finalCwd,
        exitCode,
        ...(signal ? { signal } : {}),
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        truncation: {
          truncated,
          charLimit,
          originalLength,
          returnedLength,
        },
      })

      const onStdout = (chunk: Buffer) => {
        stdoutPending += chunk.toString("utf8")
        const exitCode = drainStdout()
        if (typeof exitCode === "number") {
          append("stdout", stdoutPending)
          stdoutPending = ""
          finish(makeOutput(Number.isNaN(exitCode) ? null : exitCode))
        }
      }
      const onStderr = (chunk: Buffer) => append("stderr", chunk.toString("utf8"))
      const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        append("stdout", stdoutPending)
        stdoutPending = ""
        this.child = null
        finish(makeOutput(exitCode, signal))
      }
      const onAbort = () => {
        forceReset = true
        this.resetChild()
      }
      const timeout = setTimeout(() => {
        timedOut = true
        forceReset = true
        this.resetChild()
      }, timeoutMs)
      const killTimeout = setTimeout(() => {
        if (forceReset && this.child && !this.child.killed) {
          this.child.kill("SIGKILL")
        }
      }, timeoutMs + 2_000)

      child.stdout.on("data", onStdout)
      child.stderr.on("data", onStderr)
      child.once("close", onClose)
      child.once("error", fail)
      context.abortSignal?.addEventListener("abort", onAbort, { once: true })

      const command = [
        requestedCwd ? `cd ${shellQuote(requestedCwd)}` : undefined,
        input.command,
        "__socrates_exit=$?",
        `printf '${cwdMarker}%s\\n' "$PWD"`,
        `printf '${doneMarker}%s\\n' "$__socrates_exit"`,
      ]
        .filter(Boolean)
        .join("\n")

      child.stdin.write(`${command}\n`, (error) => {
        if (error && !resolved) {
          fail(error)
        }
      })
    })
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child
    }
    const shell = process.env.SHELL || "/bin/zsh"
    const child = spawn(shell, shellArgs(shell), {
      cwd: this.workspacePath,
      env: {
        ...process.env,
        CI: "1",
        PAGER: "cat",
        GIT_PAGER: "cat",
        PS1: "",
        PROMPT: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child
    return child
  }

  private resetChild(): void {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM")
    }
    this.child = null
  }
}

export const createWorkspaceShellSession = (workspacePath: string): WorkspaceShellSession =>
  new WorkspaceShellSession(resolveWorkspacePath(workspacePath))

export const runWorkspaceBash = async (
  input: BashToolInput,
  context: {
    workspacePath: string
    abortSignal?: AbortSignal
    onOutput?: (output: { stream: "stdout" | "stderr" | "log"; text: string }) => void
  },
): Promise<BashToolOutput> => {
  const session = createWorkspaceShellSession(context.workspacePath)
  try {
    return await session.run(input, context)
  } finally {
    session.dispose()
  }
}

const shellArgs = (shell: string): string[] => {
  const base = path.basename(shell)
  if (base.includes("zsh")) {
    return ["-f"]
  }
  if (base.includes("bash")) {
    return ["--noprofile", "--norc"]
  }
  return []
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const leadingCdPattern = /^\s*cd\s+((?:"[^"]+")|(?:'[^']+')|(?:\S+))(?:\s*(?:&&|;|\n|$))/

const rejectLeadingExternalCd = (command: string, workspacePath: string): void => {
  const match = command.match(leadingCdPattern)
  if (!match?.[1]) {
    return
  }
  const rawTarget = match[1]
  const target = unquoteShellToken(rawTarget)
  if (!isExternalAbsoluteCdTarget(target, workspacePath)) {
    return
  }

  throw new SocratesError(
    "external_workspace_cd_rejected",
    `Bash command rejected: Socrates already runs inside the active workspace. Do not cd into a guessed absolute workspace path; run the command relative to the active workspace instead.`,
    {
      details: {
        workspacePath,
        cdTarget: target,
        example: "Run `python3 -m venv venv` instead of `cd /some/other/path && python3 -m venv venv`.",
      },
      recoverable: true,
    },
  )
}

const isExternalAbsoluteCdTarget = (target: string, workspacePath: string): boolean => {
  if (target.startsWith("~")) {
    return true
  }
  const isAbsolute = path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target)
  if (!isAbsolute) {
    return false
  }
  const workspaceRoot = path.resolve(workspacePath)
  const resolvedTarget = path.resolve(target)
  return resolvedTarget !== workspaceRoot && !resolvedTarget.startsWith(`${workspaceRoot}${path.sep}`)
}

const unquoteShellToken = (token: string): string => {
  if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
    return token.slice(1, -1)
  }
  return token
}
