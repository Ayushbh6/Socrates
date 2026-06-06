import path from "node:path"
import { randomUUID } from "node:crypto"
import type { IPty } from "@homebridge/node-pty-prebuilt-multiarch"
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
  systemPid?: number
  command: string
  cwd: string
  pty: IPty
  adapter: ShellAdapter
  startedAt: string
  exitedAt?: string
  status: "running" | "exited" | "stopped"
  exitCode?: number | null
  signal?: string | null
  chunks: ProcessChunk[]
  nextSequence: number
  cols: number
  rows: number
}

type ProcessChunk = {
  sequence: number
  stream: "pty"
  text: string
}

type PtyExit = {
  exitCode: number
  signal?: number | string
}

const interactiveCommandPattern =
  /^\s*(vi|vim|nvim|nano|emacs|less|more|top|htop|ssh|scp|sftp|ftp|passwd|python(?:3)?\s+-i|node\s+-i)\b|\b(--interactive|-i)\b/

const markerHoldback = 256
const processOutputBufferLimit = 200_000
const defaultCols = 100
const defaultRows = 30

let ptyModulePromise: Promise<typeof import("@homebridge/node-pty-prebuilt-multiarch")> | undefined

export class WorkspaceShellSession {
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
    for (const processInfo of this.processes.values()) {
      this.stopProcess(processInfo)
    }
    this.processes.clear()
  }

  writeProcessInput(processId: string, text: string): void {
    const processInfo = this.findProcess(processId)
    if (!processInfo || processInfo.status !== "running") {
      throw new SocratesError("terminal_process_not_running", "Terminal input can only be sent to a running process.", {
        details: { processId },
        recoverable: true,
      })
    }
    processInfo.pty.write(text)
  }

  resizeProcess(processId: string, cols: number, rows: number): void {
    const processInfo = this.findProcess(processId)
    if (!processInfo || processInfo.status !== "running") {
      throw new SocratesError("terminal_process_not_running", "Terminal resize can only target a running process.", {
        details: { processId },
        recoverable: true,
      })
    }
    const nextCols = clampDimension(cols, defaultCols)
    const nextRows = clampDimension(rows, defaultRows)
    processInfo.cols = nextCols
    processInfo.rows = nextRows
    processInfo.pty.resize(nextCols, nextRows)
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

    const startedAt = Date.now()
    const cwd = input.cwd ? resolveWorkspacePath(this.workspacePath, input.cwd) : this.workspacePath
    const timeoutMs = input.timeoutMs ?? 120_000
    const charLimit = clampCharLimit(input.charLimit)
    const id = randomUUID().replaceAll("-", "")
    const cwdMarker = `__SOCRATES_CWD_${id}__`
    const doneMarker = `__SOCRATES_DONE_${id}__`
    let stdout = ""
    let pending = ""
    let returnedLength = 0
    let originalLength = 0
    let truncated = false
    let timedOut = false
    let finalCwd = cwd
    let markerExitCode: number | undefined

    const adapter = await this.resolveAdapter(cwd)
    const wrappedCommand = adapter.wrapCommand({ command: commandText, cwd, cwdMarker, doneMarker })
    const pty = await spawnPtyChecked(adapter, adapter.runArgs(wrappedCommand), cwd, this.env, defaultCols, defaultRows)

    const append = (text: string) => {
      const normalized = normalizePtyTranscript(text)
      if (!normalized) {
        return
      }
      originalLength += normalized.length
      const remaining = Math.max(charLimit - returnedLength, 0)
      if (remaining <= 0) {
        truncated = true
        return
      }
      const sliced = normalized.slice(0, remaining)
      returnedLength += sliced.length
      if (sliced.length < normalized.length) {
        truncated = true
      }
      stdout += sliced
      context.onOutput?.({ stream: "stdout", text: sliced })
    }

    const drainPending = (final = false) => {
      for (;;) {
        const cwdIndex = pending.indexOf(cwdMarker)
        const doneIndex = pending.indexOf(doneMarker)
        const indexes = [cwdIndex, doneIndex].filter((index) => index >= 0)
        if (indexes.length === 0) {
          const flushLength = final ? pending.length : pending.length - markerHoldback
          if (flushLength > 0) {
            append(pending.slice(0, flushLength))
            pending = pending.slice(flushLength)
          }
          return
        }

        const markerIndex = Math.min(...indexes)
        append(pending.slice(0, markerIndex))
        pending = pending.slice(markerIndex)

        if (pending.startsWith(cwdMarker)) {
          const line = takeMarkerLine(pending, cwdMarker)
          if (!line) {
            return
          }
          finalCwd = line.value.trim() || finalCwd
          pending = line.rest
          continue
        }

        if (pending.startsWith(doneMarker)) {
          const line = takeMarkerLine(pending, doneMarker)
          if (!line) {
            return
          }
          const parsed = Number.parseInt(line.value.trim(), 10)
          markerExitCode = Number.isNaN(parsed) ? undefined : parsed
          pending = line.rest
          continue
        }
      }
    }

    return await new Promise<BashToolOutput>((resolve) => {
      let settled = false
      let forceFinishTimer: NodeJS.Timeout | undefined
      const cleanup = () => {
        dataDisposable.dispose()
        exitDisposable.dispose()
        clearTimeout(timeout)
        clearTimeout(forceFinishTimer)
        context.abortSignal?.removeEventListener("abort", onAbort)
      }
      const finish = (exit: PtyExit) => {
        if (settled) {
          return
        }
        settled = true
        drainPending(true)
        cleanup()
        const exitCode = timedOut ? exit.exitCode : (markerExitCode ?? exit.exitCode)
        resolve({
          operation: "run",
          command: commandText,
          cwd: finalCwd,
          exitCode,
          ...(exit.signal === undefined ? {} : { signal: String(exit.signal) }),
          stdout,
          stderr: "",
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
      }
      const kill = () => {
        try {
          pty.kill()
          forceFinishTimer = setTimeout(() => finish({ exitCode: 1, signal: "SIGTERM" }), 1_000)
        } catch {
          finish({ exitCode: 1, signal: "SIGTERM" })
        }
      }
      const onAbort = () => {
        timedOut = false
        kill()
      }
      const timeout = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)
      const dataDisposable = pty.onData((text) => {
        pending += text
        drainPending(false)
      })
      const exitDisposable = pty.onExit((event) => finish({ exitCode: event.exitCode, ...(event.signal === undefined ? {} : { signal: event.signal }) }))
      context.abortSignal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private async startProcess(input: BashToolInput, context: ShellRunContext): Promise<BashToolOutput> {
    const commandText = input.command
    if (!commandText) {
      throw new SocratesError("shell_command_required", "A shell command is required for start operations.")
    }
    rejectLeadingExternalCd(commandText, this.workspacePath)

    const startedAt = Date.now()
    const cwd = input.cwd ? resolveWorkspacePath(this.workspacePath, input.cwd) : this.workspacePath
    const adapter = await this.resolveAdapter(cwd)
    const cols = defaultCols
    const rows = defaultRows
    const pty = await spawnPtyChecked(adapter, adapter.runArgs(commandText), cwd, this.env, cols, rows)
    const processId = `proc_${randomUUID().replaceAll("-", "")}`
    const processInfo: RunningProcess = {
      processId,
      systemPid: pty.pid,
      command: commandText,
      cwd,
      pty,
      adapter,
      startedAt: new Date(startedAt).toISOString(),
      status: "running",
      chunks: [],
      nextSequence: 0,
      cols,
      rows,
    }
    this.processes.set(processId, processInfo)

    pty.onData((text) => this.appendProcessOutput(processInfo, text, context))
    pty.onExit((event) => {
      if (processInfo.status !== "stopped") {
        processInfo.status = "exited"
      }
      processInfo.exitCode = event.exitCode
      processInfo.signal = event.signal === undefined ? null : String(event.signal)
      processInfo.exitedAt = new Date().toISOString()
    })

    const snapshot = processSnapshot(processInfo, input.outputSequence, clampCharLimit(input.charLimit))
    return {
      operation: "start",
      command: commandText,
      cwd,
      exitCode: null,
      stdout: snapshot.stdout,
      stderr: "",
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
      context.onOutput?.({ stream: "stdout", text: normalizePtyTranscript(snapshot.stdout) })
    }
    return {
      operation: "output",
      command: processInfo.command,
      cwd: processInfo.cwd,
      exitCode: processInfo.exitCode ?? null,
      ...(processInfo.signal ? { signal: processInfo.signal } : {}),
      stdout: snapshot.stdout,
      stderr: "",
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
      context.onOutput?.({ stream: "stdout", text: normalizePtyTranscript(snapshot.stdout) })
    }
    return {
      operation: "stop",
      command: processInfo.command,
      cwd: processInfo.cwd,
      exitCode: processInfo.exitCode ?? null,
      ...(processInfo.signal ? { signal: processInfo.signal } : {}),
      stdout: snapshot.stdout,
      stderr: "",
      durationMs: Date.now() - startedAt,
      timedOut: false,
      truncation: snapshot.truncation,
      shell: shellMetadata(processInfo.adapter),
      process: processMetadata(processInfo),
    }
  }

  private async resolveAdapter(cwd: string): Promise<ShellAdapter> {
    let lastError: unknown
    for (const adapter of candidateAdapters(this.platform, this.env)) {
      try {
        await probeAdapter(adapter, cwd, this.env)
        return adapter
      } catch (error) {
        lastError = error
      }
    }
    throw normalizeShellError(lastError, "shell_start_failed", this.defaultAdapter(), cwd)
  }

  private appendProcessOutput(processInfo: RunningProcess, text: string, context?: ShellRunContext): void {
    if (!text) {
      return
    }
    processInfo.chunks.push({ sequence: processInfo.nextSequence, stream: "pty", text })
    processInfo.nextSequence += 1
    trimProcessChunks(processInfo)
    context?.onOutput?.({ stream: "stdout", text: normalizePtyTranscript(text) })
  }

  private stopProcess(processInfo: RunningProcess): void {
    if (processInfo.status === "running") {
      processInfo.status = "stopped"
      try {
        processInfo.pty.kill()
      } catch {
        // The PTY may already have exited between status polling and stop.
      }
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

export const isInteractiveShellCommand = (command: string): boolean => interactiveCommandPattern.test(command)

const loadPty = (): Promise<typeof import("@homebridge/node-pty-prebuilt-multiarch")> => {
  ptyModulePromise ??= import("@homebridge/node-pty-prebuilt-multiarch")
  return ptyModulePromise
}

const probeAdapter = async (adapter: ShellAdapter, cwd: string, env: NodeJS.ProcessEnv): Promise<void> => {
  const pty = await spawnPtyChecked(adapter, adapter.runArgs("exit 0"), cwd, env, defaultCols, defaultRows)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      try {
        pty.kill()
      } catch {
        // Ignore failed cleanup while reporting the probe timeout.
      }
      reject(new SocratesError("shell_start_failed", "Shell probe timed out.", { details: shellMetadata(adapter), recoverable: true }))
    }, 500)
    const disposable = pty.onExit((event) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      disposable.dispose()
      if (event.exitCode === 0) {
        resolve()
        return
      }
      reject(
        new SocratesError("shell_start_failed", "Shell probe exited before it was ready.", {
          details: { ...shellMetadata(adapter), exitCode: event.exitCode, signal: event.signal },
          recoverable: true,
        }),
      )
    })
  })
}

const spawnPtyChecked = async (
  adapter: ShellAdapter,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  cols: number,
  rows: number,
): Promise<IPty> => {
  try {
    const pty = await loadPty()
    return pty.spawn(adapter.executable, args, {
      cwd,
      env: buildWorkspaceCommandEnv(env, adapter.platform),
      name: "xterm-256color",
      cols,
      rows,
    })
  } catch (error) {
    throw normalizeShellError(error, "shell_start_failed", adapter, cwd)
  }
}

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
    TERM: sanitized.TERM ?? "xterm-256color",
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
  normalizePtyTranscript,
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
  ...(processInfo.systemPid ? { systemPid: processInfo.systemPid } : {}),
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
    stdout += sliced
  }
  return {
    stdout,
    stderr: "",
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

const takeMarkerLine = (text: string, marker: string): { value: string; rest: string } | undefined => {
  const afterMarker = text.slice(marker.length)
  const newlineMatch = afterMarker.match(/\r?\n/)
  if (!newlineMatch || newlineMatch.index === undefined) {
    return undefined
  }
  const end = newlineMatch.index
  return {
    value: afterMarker.slice(0, end).replaceAll("\r", ""),
    rest: afterMarker.slice(end + newlineMatch[0].length),
  }
}

function normalizePtyTranscript(text: string): string {
  return stripAnsi(text)
    .replaceAll("\r\n", "\n")
    .replaceAll(/\r(?!\n)/g, "\n")
    .replaceAll(/\u0007/g, "")
}

const clampDimension = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(Math.max(Math.floor(value), 2), 500)
}

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

const stripAnsi = (text: string): string => text.replaceAll(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
