import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { BashToolInput, BashToolOutput, TruncationMetadata } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { clampCharLimit, resolveWorkspacePath } from "./common"

type ShellKind = "posix" | "powershell" | "cmd"
type BashOperation = NonNullable<BashToolInput["operation"]>

type ShellRunContext = {
  abortSignal?: AbortSignal
  onOutput?: (output: { stream: "stdout" | "stderr" | "log"; text: string }) => void
}

type ShellAdapter = {
  kind: ShellKind
  platform: NodeJS.Platform
  executable: string
  interactiveArgs: string[]
  runArgs: (command: string) => string[]
  quotePath: (value: string) => string
  wrapCommand: (input: { command: string; cwd?: string; cwdMarker: string; doneMarker: string }) => string
}

type RunningProcess = {
  processId: string
  command: string
  cwd: string
  child: ChildProcessWithoutNullStreams
  adapter: ShellAdapter
  startedAt: string
  exitedAt?: string
  status: "running" | "exited" | "stopped"
  exitCode?: number | null
  signal?: string | null
  chunks: ProcessChunk[]
  nextSequence: number
}

type ProcessChunk = {
  sequence: number
  stream: "stdout" | "stderr"
  text: string
}

type ShellChild = {
  child: ChildProcessWithoutNullStreams
  adapter: ShellAdapter
}

const interactiveCommandPattern =
  /^\s*(vi|vim|nvim|nano|emacs|less|more|top|htop|ssh|scp|sftp|ftp|passwd)\b|\b(--interactive|-i)\b/

const markerHoldback = 256
const processOutputBufferLimit = 200_000

export class WorkspaceShellSession {
  private shellChild: ShellChild | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly processes = new Map<string, RunningProcess>()
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv

  constructor(
    private readonly workspacePath: string,
    options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
  }

  run(input: BashToolInput, context: ShellRunContext = {}): Promise<BashToolOutput> {
    const run = this.queue.then(() => this.runNow(input, context))
    this.queue = run.catch(() => undefined)
    return run
  }

  dispose(): void {
    this.disposed = true
    this.resetChild()
    for (const processInfo of this.processes.values()) {
      this.stopProcess(processInfo)
    }
    this.processes.clear()
  }

  writeProcessInput(processId: string, text: string): void {
    const processInfo = this.findProcess(processId)
    if (!processInfo || processInfo.status !== "running" || processInfo.child.killed) {
      throw new SocratesError("terminal_process_not_running", "Terminal input can only be sent to a running process.", {
        details: { processId },
        recoverable: true,
      })
    }
    processInfo.child.stdin.write(text)
  }

  private async runNow(input: BashToolInput, context: ShellRunContext): Promise<BashToolOutput> {
    if (this.disposed) {
      throw new SocratesError("shell_session_disposed", "The shell session has already ended.")
    }

    const operation = input.operation ?? "run"
    if (operation === "run") {
      return await this.runCommand(input, context)
    }
    if (operation === "start") {
      return await this.startProcess(input, context)
    }
    if (operation === "status") {
      return this.processStatus(input)
    }
    if (operation === "output") {
      return this.processOutput(input, context)
    }
    return this.processStop(input, context)
  }

  private async runCommand(input: BashToolInput, context: ShellRunContext): Promise<BashToolOutput> {
    const commandText = input.command
    if (!commandText) {
      throw new SocratesError("shell_command_required", "A shell command is required for run operations.")
    }
    rejectLeadingExternalCd(commandText, this.workspacePath)
    rejectInteractiveCommand(commandText)

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

    const shellChild = await this.ensureChild()
    const { child, adapter } = shellChild

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
        this.resetChild()
        reject(normalizeShellError(error, "shell_protocol_failed", adapter, finalCwd))
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
        operation: "run",
        command: commandText,
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
        shell: shellMetadata(adapter),
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
        this.shellChild = null
        if (!resolved) {
          if (timedOut) {
            finish(makeOutput(exitCode, signal))
            return
          }
          fail(
            new Error(
              `Shell closed before command completion marker was emitted.${exitCode === null ? "" : ` Exit code: ${exitCode}.`}${
                signal ? ` Signal: ${signal}.` : ""
              }`,
            ),
          )
          return
        }
        finish(makeOutput(exitCode, signal))
      }
      const onAbort = () => {
        forceReset = true
        timedOut = false
        this.resetChild()
      }
      const timeout = setTimeout(() => {
        timedOut = true
        forceReset = true
        this.resetChild()
      }, timeoutMs)
      const killTimeout = setTimeout(() => {
        if (forceReset && this.shellChild?.child && !this.shellChild.child.killed) {
          this.shellChild.child.kill("SIGKILL")
        }
      }, timeoutMs + 2_000)

      child.stdout.on("data", onStdout)
      child.stderr.on("data", onStderr)
      child.once("close", onClose)
      child.once("error", fail)
      context.abortSignal?.addEventListener("abort", onAbort, { once: true })

      const wrappedCommand = adapter.wrapCommand({
        command: commandText,
        ...(requestedCwd ? { cwd: requestedCwd } : {}),
        cwdMarker,
        doneMarker,
      })

      child.stdin.write(`${wrappedCommand}\n`, (error) => {
        if (error && !resolved) {
          cleanup()
          this.resetChild()
          reject(normalizeShellError(error, "shell_write_failed", adapter, finalCwd))
        }
      })
    })
  }

  private async startProcess(input: BashToolInput, context: ShellRunContext): Promise<BashToolOutput> {
    const commandText = input.command
    if (!commandText) {
      throw new SocratesError("shell_command_required", "A shell command is required for start operations.")
    }
    rejectLeadingExternalCd(commandText, this.workspacePath)
    rejectInteractiveCommand(commandText)

    const startedAt = Date.now()
    const cwd = input.cwd ? resolveWorkspacePath(this.workspacePath, input.cwd) : this.workspacePath
    const { child, adapter } = await this.spawnProcessShell(commandText, cwd)
    const processId = `proc_${randomUUID().replaceAll("-", "")}`
    const processInfo: RunningProcess = {
      processId,
      command: commandText,
      cwd,
      child,
      adapter,
      startedAt: new Date(startedAt).toISOString(),
      status: "running",
      chunks: [],
      nextSequence: 0,
    }
    this.processes.set(processId, processInfo)

    child.stdout.on("data", (chunk: Buffer) => this.appendProcessOutput(processInfo, "stdout", chunk.toString("utf8"), context))
    child.stderr.on("data", (chunk: Buffer) => this.appendProcessOutput(processInfo, "stderr", chunk.toString("utf8"), context))
    child.once("error", (error) => {
      processInfo.status = "exited"
      processInfo.exitedAt = new Date().toISOString()
      this.appendProcessOutput(processInfo, "stderr", `${error.message}\n`, context)
    })
    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (processInfo.status !== "stopped") {
        processInfo.status = "exited"
      }
      processInfo.exitCode = exitCode
      processInfo.signal = signal
      processInfo.exitedAt = new Date().toISOString()
    })

    const snapshot = processSnapshot(processInfo, input.outputSequence, clampCharLimit(input.charLimit))
    return {
      operation: "start",
      command: commandText,
      cwd,
      exitCode: null,
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      truncation: snapshot.truncation,
      shell: shellMetadata(adapter),
      process: processMetadata(processInfo),
    }
  }

  private processStatus(input: BashToolInput): BashToolOutput {
    const startedAt = Date.now()
    const processInfo = this.findProcess(input.processId)
    return {
      operation: "status",
      cwd: processInfo?.cwd ?? this.workspacePath,
      exitCode: processInfo?.exitCode ?? null,
      ...(processInfo?.signal ? { signal: processInfo.signal } : {}),
      stdout: "",
      stderr: "",
      durationMs: Date.now() - startedAt,
      timedOut: false,
      truncation: emptyTruncation(clampCharLimit(input.charLimit)),
      shell: shellMetadata(processInfo?.adapter ?? this.defaultAdapter()),
      process: processInfo ? processMetadata(processInfo) : missingProcessMetadata(input.processId),
    }
  }

  private processOutput(input: BashToolInput, context: ShellRunContext): BashToolOutput {
    const startedAt = Date.now()
    const processInfo = this.findProcess(input.processId)
    if (!processInfo) {
      return {
        operation: "output",
        cwd: this.workspacePath,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - startedAt,
        timedOut: false,
        truncation: emptyTruncation(clampCharLimit(input.charLimit)),
        shell: shellMetadata(this.defaultAdapter()),
        process: missingProcessMetadata(input.processId),
      }
    }
    const snapshot = processSnapshot(processInfo, input.outputSequence, clampCharLimit(input.charLimit))
    if (snapshot.stdout) {
      context.onOutput?.({ stream: "stdout", text: snapshot.stdout })
    }
    if (snapshot.stderr) {
      context.onOutput?.({ stream: "stderr", text: snapshot.stderr })
    }
    return {
      operation: "output",
      command: processInfo.command,
      cwd: processInfo.cwd,
      exitCode: processInfo.exitCode ?? null,
      ...(processInfo.signal ? { signal: processInfo.signal } : {}),
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      truncation: snapshot.truncation,
      shell: shellMetadata(processInfo.adapter),
      process: processMetadata(processInfo),
    }
  }

  private processStop(input: BashToolInput, context: ShellRunContext): BashToolOutput {
    const startedAt = Date.now()
    const processInfo = this.findProcess(input.processId)
    if (!processInfo) {
      return {
        operation: "stop",
        cwd: this.workspacePath,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - startedAt,
        timedOut: false,
        truncation: emptyTruncation(clampCharLimit(input.charLimit)),
        shell: shellMetadata(this.defaultAdapter()),
        process: missingProcessMetadata(input.processId),
      }
    }

    this.stopProcess(processInfo)
    const snapshot = processSnapshot(processInfo, input.outputSequence, clampCharLimit(input.charLimit))
    if (snapshot.stdout) {
      context.onOutput?.({ stream: "stdout", text: snapshot.stdout })
    }
    if (snapshot.stderr) {
      context.onOutput?.({ stream: "stderr", text: snapshot.stderr })
    }
    return {
      operation: "stop",
      command: processInfo.command,
      cwd: processInfo.cwd,
      exitCode: processInfo.exitCode ?? null,
      ...(processInfo.signal ? { signal: processInfo.signal } : {}),
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      truncation: snapshot.truncation,
      shell: shellMetadata(processInfo.adapter),
      process: processMetadata(processInfo),
    }
  }

  private async ensureChild(): Promise<ShellChild> {
    if (this.shellChild?.child && !this.shellChild.child.killed) {
      return this.shellChild
    }

    let lastError: unknown
    for (const adapter of candidateAdapters(this.platform, this.env)) {
      try {
        const child = await spawnChecked(adapter, adapter.interactiveArgs, this.workspacePath, this.env)
        this.shellChild = { child, adapter }
        return this.shellChild
      } catch (error) {
        lastError = error
      }
    }

    throw normalizeShellError(lastError, "shell_start_failed", this.defaultAdapter(), this.workspacePath)
  }

  private async spawnProcessShell(command: string, cwd: string): Promise<ShellChild> {
    let lastError: unknown
    for (const adapter of candidateAdapters(this.platform, this.env)) {
      try {
        const child = await spawnChecked(adapter, adapter.runArgs(command), cwd, this.env)
        return { child, adapter }
      } catch (error) {
        lastError = error
      }
    }
    throw normalizeShellError(lastError, "shell_start_failed", this.defaultAdapter(), cwd)
  }

  private resetChild(): void {
    if (this.shellChild?.child && !this.shellChild.child.killed) {
      this.shellChild.child.kill("SIGTERM")
    }
    this.shellChild = null
  }

  private appendProcessOutput(processInfo: RunningProcess, stream: "stdout" | "stderr", text: string, context?: ShellRunContext): void {
    if (!text) {
      return
    }
    processInfo.chunks.push({ sequence: processInfo.nextSequence, stream, text })
    processInfo.nextSequence += 1
    trimProcessChunks(processInfo)
    context?.onOutput?.({ stream, text })
  }

  private stopProcess(processInfo: RunningProcess): void {
    if (processInfo.status === "running" && !processInfo.child.killed) {
      processInfo.status = "stopped"
      processInfo.child.kill("SIGTERM")
      setTimeout(() => {
        if (!processInfo.child.killed && processInfo.status === "stopped") {
          processInfo.child.kill("SIGKILL")
        }
      }, 2_000).unref?.()
    }
    processInfo.exitedAt ??= new Date().toISOString()
  }

  private findProcess(processId: string | undefined): RunningProcess | undefined {
    return processId ? this.processes.get(processId) : undefined
  }

  private defaultAdapter(): ShellAdapter {
    return candidateAdapters(this.platform, this.env)[0] ?? makePosixAdapter(this.platform, "/bin/sh")
  }
}

export const createWorkspaceShellSession = (
  workspacePath: string,
  options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv },
): WorkspaceShellSession => new WorkspaceShellSession(resolveWorkspacePath(workspacePath), options)

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

export const isShellSessionResetError = (error: unknown): boolean =>
  error instanceof SocratesError && ["shell_start_failed", "shell_write_failed", "shell_protocol_failed"].includes(error.code)

const rejectInteractiveCommand = (command: string): void => {
  if (interactiveCommandPattern.test(command)) {
    throw new SocratesError(
      "interactive_shell_command_unsupported",
      "Interactive shell commands are not supported yet. Run a non-interactive command instead.",
      { details: { command }, recoverable: true },
    )
  }
}

const spawnChecked = (
  adapter: ShellAdapter,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildProcessWithoutNullStreams> =>
  new Promise((resolve, reject) => {
    const child = spawn(adapter.executable, args, {
      cwd,
      env: buildWorkspaceCommandEnv(env, adapter.platform),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.off("error", onError)
      child.off("close", onEarlyClose)
      resolve(child)
    }, 25)
    const onError = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.off("close", onEarlyClose)
      reject(normalizeShellError(error, "shell_start_failed", adapter, cwd))
    }
    const onEarlyClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.off("error", onError)
      reject(
        new SocratesError("shell_start_failed", "Shell process exited before it was ready.", {
          details: { ...shellMetadata(adapter), cwd, code, signal },
          recoverable: true,
        }),
      )
    }
    child.once("error", onError)
    child.once("close", onEarlyClose)
  })

const safeEnvNames = new Set([
  "PATH",
  "Path",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
])

const safeWindowsEnvNames = new Set([
  "SystemRoot",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
])

const isSafeWorkspaceEnvName = (name: string, platform: NodeJS.Platform): boolean =>
  safeEnvNames.has(name) || name.startsWith("LC_") || (platform === "win32" && safeWindowsEnvNames.has(name))

const buildWorkspaceCommandEnv = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv => {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isSafeWorkspaceEnvName(name, platform)) {
      sanitized[name] = value
    }
  }
  return {
    ...sanitized,
    PAGER: "cat",
    GIT_PAGER: "cat",
    PS1: "",
    PROMPT: "",
  }
}

const candidateAdapters = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ShellAdapter[] => {
  if (platform === "win32") {
    return [makePowerShellAdapter(platform, "powershell.exe"), makePowerShellAdapter(platform, "pwsh"), makeCmdAdapter(platform, env.COMSPEC || "cmd.exe")]
  }

  const candidates = [env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter((item): item is string => Boolean(item))
  return [...new Set(candidates)].map((shell) => makePosixAdapter(platform, shell))
}

export const __bashToolTest = {
  buildWorkspaceCommandEnv,
  candidateAdapters,
}

const makePosixAdapter = (platform: NodeJS.Platform, executable: string): ShellAdapter => {
  const base = path.basename(executable)
  const interactiveArgs = base.includes("zsh") ? ["-f"] : base.includes("bash") ? ["--noprofile", "--norc"] : []
  return {
    kind: "posix",
    platform,
    executable,
    interactiveArgs,
    runArgs: (command) => [...interactiveArgs, "-c", command || "exit 0"],
    quotePath: posixQuote,
    wrapCommand: ({ command, cwd, cwdMarker, doneMarker }) =>
      [
        cwd ? `cd ${posixQuote(cwd)}` : undefined,
        command,
        "__socrates_exit=$?",
        `printf '${cwdMarker}%s\\n' "$PWD"`,
        `printf '${doneMarker}%s\\n' "$__socrates_exit"`,
      ]
        .filter(Boolean)
        .join("\n"),
  }
}

const makePowerShellAdapter = (platform: NodeJS.Platform, executable: string): ShellAdapter => ({
  kind: "powershell",
  platform,
  executable,
  interactiveArgs: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"],
  runArgs: (command) => ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command || "exit 0"],
  quotePath: powerShellQuote,
  wrapCommand: ({ command, cwd, cwdMarker, doneMarker }) =>
    [
      cwd ? `Set-Location -LiteralPath ${powerShellQuote(cwd)}` : undefined,
      "$global:LASTEXITCODE = 0",
      command,
      "$__socrates_success = $?",
      "$__socrates_exit = if (-not $__socrates_success -and $global:LASTEXITCODE -is [int] -and $global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } elseif ($__socrates_success) { 0 } else { 1 }",
      `[Console]::Out.WriteLine(${powerShellQuote(cwdMarker)} + (Get-Location).ProviderPath)`,
      `[Console]::Out.WriteLine(${powerShellQuote(doneMarker)} + $__socrates_exit)`,
    ]
      .filter(Boolean)
      .join("\n"),
})

const makeCmdAdapter = (platform: NodeJS.Platform, executable: string): ShellAdapter => ({
  kind: "cmd",
  platform,
  executable,
  interactiveArgs: ["/d", "/q", "/k"],
  runArgs: (command) => ["/d", "/s", "/c", command || "exit /b 0"],
  quotePath: cmdQuote,
  wrapCommand: ({ command, cwd, cwdMarker, doneMarker }) =>
    [
      cwd ? `cd /d ${cmdQuote(cwd)}` : undefined,
      command,
      "set __socrates_exit=%ERRORLEVEL%",
      `echo ${cwdMarker}%CD%`,
      `echo ${doneMarker}%__socrates_exit%`,
    ]
      .filter(Boolean)
      .join("\r\n"),
})

const normalizeShellError = (error: unknown, code: "shell_start_failed" | "shell_write_failed" | "shell_protocol_failed", adapter: ShellAdapter, cwd: string): SocratesError => {
  if (error instanceof SocratesError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  const nodeError = error as NodeJS.ErrnoException
  return new SocratesError(code, message || "Shell command failed.", {
    details: {
      ...shellMetadata(adapter),
      cwd,
      errorCode: nodeError.code,
      errno: nodeError.errno,
      syscall: nodeError.syscall,
    },
    recoverable: true,
  })
}

const shellMetadata = (adapter: ShellAdapter): BashToolOutput["shell"] => ({
  platform: adapter.platform,
  kind: adapter.kind,
  executable: adapter.executable,
})

const processMetadata = (processInfo: RunningProcess): NonNullable<BashToolOutput["process"]> => ({
  processId: processInfo.processId,
  status: processInfo.status,
  exitCode: processInfo.exitCode,
  signal: processInfo.signal,
  startedAt: processInfo.startedAt,
  exitedAt: processInfo.exitedAt,
  nextOutputSequence: processInfo.nextSequence,
})

const missingProcessMetadata = (processId: string | undefined): NonNullable<BashToolOutput["process"]> => ({
  processId: processId ?? "missing",
  status: "missing",
  nextOutputSequence: 0,
})

const processSnapshot = (
  processInfo: RunningProcess,
  outputSequence = 0,
  charLimit = clampCharLimit(),
): { stdout: string; stderr: string; truncation: TruncationMetadata } => {
  let stdout = ""
  let stderr = ""
  let returnedLength = 0
  let originalLength = 0
  let truncated = false
  for (const chunk of processInfo.chunks.filter((item) => item.sequence >= outputSequence)) {
    originalLength += chunk.text.length
    const remaining = Math.max(charLimit - returnedLength, 0)
    if (remaining <= 0) {
      truncated = true
      continue
    }
    const sliced = chunk.text.slice(0, remaining)
    returnedLength += sliced.length
    if (sliced.length < chunk.text.length) {
      truncated = true
    }
    if (chunk.stream === "stdout") {
      stdout += sliced
    } else {
      stderr += sliced
    }
  }
  return {
    stdout,
    stderr,
    truncation: { truncated, charLimit, originalLength, returnedLength, nextOffset: processInfo.nextSequence },
  }
}

const trimProcessChunks = (processInfo: RunningProcess): void => {
  let total = processInfo.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
  while (total > processOutputBufferLimit && processInfo.chunks.length > 0) {
    const removed = processInfo.chunks.shift()
    total -= removed?.text.length ?? 0
  }
}

const emptyTruncation = (charLimit: number): TruncationMetadata => ({
  truncated: false,
  charLimit,
  originalLength: 0,
  returnedLength: 0,
})

const posixQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const powerShellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`
const cmdQuote = (value: string): string => `"${value.replaceAll('"', '""')}"`

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
    `Terminal command rejected: Socrates already runs inside the active workspace. Do not cd into a guessed absolute workspace path; run the command relative to the active workspace instead.`,
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
