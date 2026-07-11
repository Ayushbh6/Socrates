import type { BashToolInput, BashToolOutput, ClientCommand, TerminalStatus } from "@socrates/contracts"
import { createId, normalizeError, nowIso, SocratesError } from "@socrates/shared"
import type { ToolExecutorContext } from "@socrates/core"
import { runWorkspaceArgv } from "@socrates/workspace"
import type { SocratesStore } from "../services/store"
import type { ActiveTurns } from "./activeTurns"
import type { ConversationSubscriptions } from "./conversationSubscriptions"
import { makeEvent } from "./eventSender"
import { TerminalSupervisorClient, type TerminalSupervisorHealth } from "./terminalSupervisorClient"

type RuntimeTerminal = {
  terminalId: string
  projectId: string
  conversationId: string
  workspacePath: string
  processId: string
  command: string
  name: string
  status: TerminalStatus
  pollTimer?: NodeJS.Timeout
  awaitingInput: boolean
  supervisorOutputSequence: number
  drainPromise?: Promise<BashToolOutput>
  consecutivePollFailures: number
}

type TerminalManagerOptions = {
  autoDetachMs?: number
  supervisorScope?: string
}

type ShellOutput = { stream: "stdout" | "stderr" | "log" | "result" | "pty"; text?: string; data?: unknown }
type TerminalSnapshot = ReturnType<SocratesStore["listConversationTerminals"]>[number]

const defaultAutoDetachMs = Number.parseInt(process.env.SOCRATES_TERMINAL_AUTO_DETACH_MS ?? "15000", 10)
const maxModelTerminalOutputChars = 16_000
const maxModelTerminalListRows = 12
const maxTerminalListTextChars = 12_000
const terminalInitialOutputDrainMs = 500
const terminalInitialOutputPollMs = 50
const maxConsecutiveSupervisorPollFailures = 3
const terminalAwaitingUserInputStopMessage = "Terminal is waiting for user input. Leave it running and ask the user to type in the Terminal panel."

export class ConversationTerminalManager {
  private readonly terminals = new Map<string, RuntimeTerminal>()
  private readonly supervisor: TerminalSupervisorClient
  private readonly autoDetachMs: number
  private onTaskReady: ((task: ReturnType<SocratesStore["claimTerminalTaskWake"]>[number]) => void) | undefined

  constructor(
    private readonly store: SocratesStore,
    private readonly subscriptions: ConversationSubscriptions,
    options: TerminalManagerOptions = {},
  ) {
    this.autoDetachMs = options.autoDetachMs ?? defaultAutoDetachMs
    this.supervisor = new TerminalSupervisorClient(options.supervisorScope)
  }

  setTaskWakeHandler(handler: (task: ReturnType<SocratesStore["claimTerminalTaskWake"]>[number]) => void): void {
    this.onTaskReady = handler
  }

  async reconcilePersistedTerminals(): Promise<void> {
    const health = await this.supervisor.inspectHealth()
    for (const terminal of this.store.listActiveTerminals()) {
      const owned = health ? await this.supervisor.has(terminal.terminalId).catch(() => false) : false
      if (!owned) {
        const checkedAt = nowIso()
        this.store.updateTerminal(terminal.terminalId, {
          status: terminal.processId ? "detached" : "missing",
          awaitingInput: false,
          completedAt: checkedAt,
          metadata: {
            supervisorRecovery: {
              state: health ? "process_missing" : "supervisor_unavailable",
              checkedAt,
              ...(health ? supervisorHealthMetadata(health) : {}),
            },
          },
        })
        const snapshot = this.store.listConversationTerminals(terminal.conversationId).find((item) => item.terminalId === terminal.terminalId)
        if (snapshot) {
          this.emitTerminalEvent("terminal.status", snapshot)
        }
        this.wakeWaitingTasks(terminal.terminalId, "failed")
        continue
      }
      const runtime = this.runtimeFromSnapshot(terminal)
      this.terminals.set(terminal.terminalId, runtime)
      this.store.updateTerminal(terminal.terminalId, {
        metadata: { supervisorRecovery: { state: "reconnected", checkedAt: nowIso(), ...supervisorHealthMetadata(health as TerminalSupervisorHealth) } },
      })
      await this.pollTerminal(runtime).catch((error) => this.handleSupervisorPollFailure(runtime, error))
      if (this.terminals.has(runtime.terminalId)) this.startPolling(runtime)
    }
  }

  async dispose(options: { preserveRunning?: boolean } = {}): Promise<void> {
    // A main-server restart must not own the lifetime of independently supervised
    // Terminals. Explicit conversation/project/user stops still terminate them.
    this.onTaskReady = undefined
    if (options.preserveRunning) {
      await Promise.allSettled([...this.terminals.values()].map((terminal) => this.waitForPendingDrain(terminal)))
      for (const terminal of this.terminals.values()) {
        clearInterval(terminal.pollTimer)
      }
      await this.supervisor.shutdownIfIdle()
    } else {
      await Promise.allSettled([...this.terminals.values()].map((terminal) => this.stopRuntimeTerminal(terminal, "Server shutdown.")))
      await this.supervisor.shutdown()
    }
    this.terminals.clear()
  }

  stopConversation(conversationId: string, reason?: string): void {
    for (const terminal of [...this.terminals.values()]) {
      if (terminal.conversationId === conversationId) {
        void this.stopRuntimeTerminal(terminal, reason)
      }
    }
    this.store.stopConversationTerminals(conversationId)
  }

  stopProject(projectId: string, reason?: string): void {
    for (const terminal of [...this.terminals.values()]) {
      if (terminal.projectId === projectId) {
        void this.stopRuntimeTerminal(terminal, reason)
      }
    }
    this.store.stopProjectTerminals(projectId)
  }

  async executeBash(input: BashToolInput, context: ToolExecutorContext, activeTurns: ActiveTurns): Promise<BashToolOutput> {
    const operation = input.operation ?? "run"
    if (input.argv) {
      return runWorkspaceArgv(input, context)
    }
    if (operation === "start") {
      return this.startTerminal(input, context, false)
    }
    if (operation === "status") {
      return this.terminalStatus(input, context)
    }
    if (operation === "output") {
      return this.terminalOutput(input, context)
    }
    if (operation === "stop") {
      return this.terminalStop(input, context)
    }
    if (operation === "list") {
      return this.terminalList(input, context)
    }
    if (input.command) {
      return this.runWithAutoDetach(input, context)
    }
    return activeTurns.getShellSession(context.turnId, context.workspacePath).run(input, context)
  }

  async handleStop(command: Extract<ClientCommand, { type: "terminal.stop" }>): Promise<void> {
    const scope = terminalCommandScope(command)
    const terminal = this.findRuntimeTerminal(command.conversationId, command.payload.terminalId)
    if (terminal) {
      assertTerminalScope(terminal, scope)
      await this.stopRuntimeTerminal(terminal, command.payload.reason)
      return
    }
    const row = command.conversationId ? this.store.findTerminal(command.conversationId, command.payload.terminalId) : undefined
    if (!row) {
      throw new SocratesError("terminal_not_found", "Terminal was not found.", { details: { terminalId: command.payload.terminalId }, recoverable: true })
    }
    assertTerminalScope(row, scope)
    this.store.updateTerminal(row.id, { status: "stopped", awaitingInput: false, signal: "SIGTERM", completedAt: nowIso() })
    const terminalSnapshot = this.store.listConversationTerminals(row.conversationId).find((item) => item.terminalId === row.id)
    if (terminalSnapshot) {
      this.emitTerminalEvent("terminal.stopped", terminalSnapshot)
    }
  }

  async handleInput(command: Extract<ClientCommand, { type: "terminal.input" }>): Promise<void> {
    const scope = terminalCommandScope(command)
    const terminal = this.findRuntimeTerminal(command.conversationId, command.payload.terminalId)
    if (!terminal) {
      throw new SocratesError("terminal_not_running", "Terminal input can only be sent to a running terminal.", {
        details: { terminalId: command.payload.terminalId },
        recoverable: true,
      })
    }
    assertTerminalScope(terminal, scope)
    const row = this.store.findTerminal(terminal.conversationId, terminal.terminalId)
    if (!row || (row.status !== "awaiting_input" && row.status !== "running")) {
      throw new SocratesError("terminal_not_accepting_input", "Terminal is not currently accepting user input.", {
        details: { terminalId: terminal.terminalId },
        recoverable: true,
      })
    }
    const inputText = terminalInputText(command.payload)
    await this.supervisor.input(terminal.terminalId, terminal.processId, inputText)
    terminal.awaitingInput = false
    terminal.status = "running"
    this.store.appendTerminalOutput({
      terminalId: terminal.terminalId,
      stream: "input",
      text: "[user input sent]\n",
      redacted: true,
    })
    this.store.updateTerminal(terminal.terminalId, { status: "running", awaitingInput: false, lastPrompt: null })
    this.emitTerminalStatus(terminal)
  }

  async handleResize(command: Extract<ClientCommand, { type: "terminal.resize" }>): Promise<void> {
    const scope = terminalCommandScope(command)
    const terminal = this.findRuntimeTerminal(command.conversationId, command.payload.terminalId)
    if (!terminal) {
      throw new SocratesError("terminal_not_running", "Terminal resize can only be sent to a running terminal.", {
        details: { terminalId: command.payload.terminalId },
        recoverable: true,
      })
    }
    assertTerminalScope(terminal, scope)
    await this.supervisor.resize(terminal.terminalId, terminal.processId, command.payload.cols, command.payload.rows)
  }

  handleRename(command: Extract<ClientCommand, { type: "terminal.rename" }>): void {
    const scope = terminalCommandScope(command)
    const row = command.conversationId ? this.store.findTerminal(command.conversationId, command.payload.terminalId) : undefined
    if (!row) {
      throw new SocratesError("terminal_not_found", "Terminal was not found.", { details: { terminalId: command.payload.terminalId }, recoverable: true })
    }
    assertTerminalScope(row, scope)
    this.store.updateTerminal(row.id, { name: command.payload.name })
    const runtime = this.terminals.get(row.id)
    if (runtime) {
      runtime.name = command.payload.name
    }
    const terminal = this.store.listConversationTerminals(row.conversationId).find((item) => item.terminalId === row.id)
    if (terminal) {
      this.emitTerminalEvent("terminal.status", terminal)
    }
  }

  private async startTerminal(input: BashToolInput, context: ToolExecutorContext, autoDetached: boolean): Promise<BashToolOutput> {
    const command = input.command
    if (!command) {
      throw new SocratesError("shell_command_required", "A shell command is required for terminal start.")
    }
    const name = input.name ?? inferTerminalName(command)
    const reusable = await this.findReusableTerminal(context.conversationId, name, command, context)
    if (reusable) {
      return storedTerminalOutput(this.store, "start", reusable, {
        message: `Reused existing Terminal "${reusable.name}" instead of starting a duplicate. Use output/status with this name to inspect it, or stop it before starting a different command.`,
        reusedTerminal: true,
        charLimit: input.charLimit,
      })
    }

    const terminalId = createId("term")
    this.store.createTerminal({
      terminalId,
      projectId: context.projectId,
      conversationId: context.conversationId,
      workspacePath: context.workspacePath,
      name,
      command,
      cwd: input.cwd ?? context.workspacePath,
      status: "running",
      autoDetached,
    })
    let output: BashToolOutput
    try {
      output = await this.supervisor.start(terminalId, context.workspacePath, { ...input, operation: "start" })
    } catch (error) {
      const normalized = normalizeError(error)
      this.store.updateTerminal(terminalId, {
        status: "missing",
        awaitingInput: false,
        completedAt: nowIso(),
        metadata: { startError: { code: normalized.code, message: normalized.message, details: normalized.details } },
      })
      const failedTerminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === terminalId)
      if (failedTerminal) {
        this.emitTerminalEvent("terminal.status", failedTerminal)
      }
      throw error
    }
    const processId = output.process?.processId
    if (!processId) {
      this.store.updateTerminal(terminalId, { status: "missing", awaitingInput: false, completedAt: nowIso() })
      throw new SocratesError("terminal_start_failed", "Terminal process did not return a process id.", { recoverable: true })
    }
    const supervisorHealth = await this.supervisor.health().catch(() => undefined)
    const runtime: RuntimeTerminal = {
      terminalId,
      projectId: context.projectId,
      conversationId: context.conversationId,
      workspacePath: context.workspacePath,
      processId,
      command,
      name,
      status: "running",
      awaitingInput: false,
      supervisorOutputSequence: output.process?.nextOutputSequence ?? 0,
      consecutivePollFailures: 0,
    }
    this.terminals.set(terminalId, runtime)
    this.store.updateTerminal(terminalId, {
      cwd: output.cwd,
      platform: output.shell.platform,
      ...(output.shell.kind === "direct" ? {} : { shellKind: output.shell.kind }),
      shellExecutable: output.shell.executable,
      processId,
      status: "running",
      autoDetached,
      metadata: {
        toolCallId: context.toolCallId,
        startToolCallId: context.toolCallId,
        lastToolCallId: context.toolCallId,
        lastTurnId: context.turnId,
        systemPid: output.process?.systemPid,
        ...(supervisorHealth ? { supervisor: supervisorHealthMetadata(supervisorHealth) } : {}),
      },
    })
    this.appendOutputSnapshot(terminalId, context, output)
    if (!hasShellOutput(output)) {
      await this.drainInitialTerminalOutput(runtime, context)
    }
    const initialTerminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === terminalId)
    if (!this.terminals.has(terminalId) || !isActiveTerminalStatus(runtime.status)) {
      return initialTerminal ? storedTerminalOutput(this.store, "start", initialTerminal, { autoDetached, charLimit: input.charLimit }) : withTerminalMetadata(output, initialTerminal, autoDetached)
    }
    this.emitTerminalStatus(runtime, "terminal.started")
    this.startPolling(runtime)
    const terminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === terminalId)
    return terminal ? storedTerminalOutput(this.store, "start", terminal, { autoDetached, charLimit: input.charLimit }) : withTerminalMetadata(output, terminal, autoDetached)
  }

  private async runWithAutoDetach(input: BashToolInput, context: ToolExecutorContext): Promise<BashToolOutput> {
    const started = await this.startTerminal(input, context, true)
    const terminalId = started.terminal?.terminalId
    const processId = started.process?.processId
    if (!terminalId || !processId) {
      return started
    }
    const deadline = Date.now() + this.autoDetachMs
    for (;;) {
      const runtime = this.terminals.get(terminalId)
      if (!runtime || runtime.status !== "running") {
        const completed = await this.terminalOutput({ operation: "output", terminalId, processId }, context)
        return { ...completed, operation: "run" }
      }
      if (Date.now() >= deadline) {
        return {
          ...started,
          operation: "run",
          message: `Command continues in background Terminal \"${started.terminal?.name ?? "terminal"}\" after the foreground window.`,
        }
      }
      await wait(Math.min(100, deadline - Date.now()))
    }
  }

  private async terminalStatus(input: BashToolInput, context: ToolExecutorContext): Promise<BashToolOutput> {
    const runtime = this.resolveTerminal(input, context)
    if (isRuntimeTerminal(runtime)) {
      await this.waitForPendingDrain(runtime)
      const output = await this.supervisor.status(runtime.terminalId, runtime.processId, { ...input, operation: "status", processId: runtime.processId })
      this.updateFromOutput(runtime, output)
      await this.drainRuntimeTerminal(runtime, context)
      const terminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === runtime.terminalId)
      return terminal ? storedTerminalOutput(this.store, "status", terminal, { charLimit: input.charLimit }) : withTerminalMetadata(output, terminal)
    }
    return storedTerminalOutput(this.store, "status", runtime, { charLimit: input.charLimit })
  }

  private async terminalList(input: BashToolInput, context: ToolExecutorContext): Promise<BashToolOutput> {
    const all = this.store.listConversationTerminals(context.conversationId)
    const requestedLimit = Math.min(input.limit ?? 8, maxModelTerminalListRows)
    const rows = all.slice(0, requestedLimit)
    const terminals = rows.map((terminal) => ({
      name: clipText(terminal.name, 96),
      command: clipText(terminal.command, 320),
      cwd: clipText(terminal.cwd, 320),
      status: terminal.status,
      awaitingInput: terminal.awaitingInput,
      autoDetached: terminal.autoDetached,
      ...(terminal.startedAt ? { startedAt: terminal.startedAt } : {}),
      ...(terminal.updatedAt ? { updatedAt: terminal.updatedAt } : {}),
      ...(terminal.completedAt ? { completedAt: terminal.completedAt } : {}),
      ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
      ...(terminal.signal ? { signal: clipText(terminal.signal, 80) } : {}),
      hasNewOutput: terminal.output.nextOutputSequence > this.store.getModelVisibleTerminalOutputSequence(terminal.terminalId),
    }))
    const full = terminals
      .map((terminal) => `${terminal.name}: ${terminal.status}${terminal.awaitingInput ? " (awaiting user input)" : ""}\n  command: ${terminal.command}\n  cwd: ${terminal.cwd}`)
      .join("\n")
    const charLimit = Math.min(input.charLimit ?? maxTerminalListTextChars, maxTerminalListTextChars)
    const stdout = clipText(full, charLimit)
    return {
      operation: "list",
      cwd: context.workspacePath,
      exitCode: null,
      stdout,
      stderr: "",
      ...(rows.length === 0 ? { message: "No conversation Terminals exist." } : {}),
      durationMs: 0,
      timedOut: false,
      truncation: {
        truncated: stdout.length < full.length,
        charLimit,
        originalLength: full.length,
        returnedLength: stdout.length,
      },
      shell: { platform: process.platform, kind: process.platform === "win32" ? "powershell" : "posix", executable: "terminal-manager" },
      terminals,
      totalMatches: all.length,
    }
  }

  private async terminalOutput(input: BashToolInput, context: ToolExecutorContext): Promise<BashToolOutput> {
    const runtime = this.resolveTerminal(input, context)
    if (isRuntimeTerminal(runtime)) {
      await this.drainRuntimeTerminal(runtime, context)
      const terminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === runtime.terminalId)
      if (!terminal) {
        throw new SocratesError("terminal_not_found", "Terminal was not found.", { details: { name: runtime.name }, recoverable: true })
      }
      return storedTerminalOutput(this.store, "output", terminal, { charLimit: input.charLimit })
    }
    return storedTerminalOutput(this.store, "output", runtime, { charLimit: input.charLimit })
  }

  private async terminalStop(input: BashToolInput, context: ToolExecutorContext): Promise<BashToolOutput> {
    const runtime = this.resolveTerminal(input, context)
    if (isRuntimeTerminal(runtime)) {
      const terminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === runtime.terminalId)
      assertModelCanStopTerminal(terminal ?? runtime)
      await this.waitForPendingDrain(runtime)
      const output = await this.supervisor.stop(runtime.terminalId, runtime.processId, {
        ...input,
        operation: "stop",
        processId: runtime.processId,
        outputSequence: runtime.supervisorOutputSequence,
      })
      this.appendOutputSnapshot(runtime.terminalId, context, output)
      this.markRuntimeTerminalStopped(runtime)
      const stoppedTerminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === runtime.terminalId)
      return stoppedTerminal ? storedTerminalOutput(this.store, "stop", stoppedTerminal, { charLimit: input.charLimit }) : withTerminalMetadata(output, stoppedTerminal)
    }
    assertModelCanStopTerminal(runtime)
    this.store.updateTerminal(runtime.terminalId, { status: "stopped", awaitingInput: false, signal: "SIGTERM", completedAt: nowIso() })
    return storedTerminalOutput(this.store, "stop", { ...runtime, status: "stopped" }, { charLimit: input.charLimit })
  }

  private resolveTerminal(input: BashToolInput, context: ToolExecutorContext): RuntimeTerminal | ReturnType<typeof storedTerminalFromRow> {
    const identifier = input.terminalId ?? input.processId ?? input.name ?? input.target
    if (identifier) {
      const runtime = this.findRuntimeTerminal(context.conversationId, identifier)
      if (runtime) {
        return runtime
      }
      const row = this.store.findTerminal(context.conversationId, identifier)
      if (!row) {
        throw new SocratesError("terminal_not_found", `No Terminal matched "${identifier}".`, { details: { target: identifier }, recoverable: true })
      }
      return storedTerminalFromRow(this.store, row.conversationId, row.id)
    }

    const activeRuntime = [...this.terminals.values()].filter(
      (terminal) => terminal.conversationId === context.conversationId && isActiveTerminalStatus(terminal.status),
    )
    if (activeRuntime.length === 1) {
      const terminal = activeRuntime[0]
      if (terminal) {
        return terminal
      }
    }
    if (activeRuntime.length > 1) {
      throw ambiguousTerminalError(activeRuntime.map(runtimeTerminalCandidate))
    }

    const activeStored = this.store.listConversationTerminals(context.conversationId).filter((terminal) => isActiveTerminalStatus(terminal.status))
    if (activeStored.length === 1) {
      const terminal = activeStored[0]
      if (terminal) {
        return terminal
      }
    }
    if (activeStored.length > 1) {
      throw ambiguousTerminalError(activeStored.map(storedTerminalCandidate))
    }
    throw new SocratesError("terminal_not_found", "No active Terminal is available. Start a Terminal first or provide a Terminal name.", {
      recoverable: true,
    })
  }

  private handleRuntimeOutput(terminalId: string, context: ToolExecutorContext | undefined, chunk: { stream: "stdout" | "stderr" | "log" | "pty"; text: string }): void {
    const sequence = this.store.appendTerminalOutput({ terminalId, stream: chunk.stream, text: chunk.text })
    if (chunk.stream === "pty") {
      context?.onOutput?.({ stream: "stdout", text: normalizePtyForModel(chunk.text) })
    } else {
      context?.onOutput?.({ stream: chunk.stream, text: chunk.text })
    }
    const runtime = this.terminals.get(terminalId)
    const conversationId = context?.conversationId ?? runtime?.conversationId
    const terminal = conversationId ? this.store.listConversationTerminals(conversationId).find((item) => item.terminalId === terminalId) : undefined
    if (terminal) {
      this.emitTerminalEvent("terminal.data", terminal, { stream: chunk.stream, text: chunk.text, sequence })
    }
    const prompt = detectPrompt(chunk.text)
    if (prompt && runtime && !runtime.awaitingInput) {
      runtime.awaitingInput = true
      runtime.status = "awaiting_input"
      this.store.updateTerminal(terminalId, { status: "awaiting_input", awaitingInput: true, lastPrompt: prompt })
      const prompted = conversationId ? this.store.listConversationTerminals(conversationId).find((item) => item.terminalId === terminalId) : undefined
      if (prompted) {
        this.emitTerminalEvent("terminal.input.requested", prompted, { prompt, secret: isSecretPrompt(prompt) })
        this.wakeWaitingTasks(terminalId, "input_required")
      }
    }
  }

  private startPolling(terminal: RuntimeTerminal): void {
    terminal.pollTimer = setInterval(() => {
      void this.pollTerminal(terminal).catch((error) => this.handleSupervisorPollFailure(terminal, error))
    }, 500)
    terminal.pollTimer.unref?.()
    setTimeout(() => {
      if (this.terminals.get(terminal.terminalId) === terminal) {
        void this.pollTerminal(terminal).catch((error) => this.handleSupervisorPollFailure(terminal, error))
      }
    }, 100).unref?.()
  }

  private async pollTerminal(terminal: RuntimeTerminal): Promise<void> {
    if (terminal.drainPromise) {
      return
    }
    await this.drainRuntimeTerminal(terminal, undefined)
  }

  private async drainRuntimeTerminal(terminal: RuntimeTerminal, context: ToolExecutorContext | undefined): Promise<BashToolOutput> {
    const previousDrain = terminal.drainPromise?.catch(() => undefined)
    const drain = (async () => {
      await previousDrain
      const output = await this.supervisor.output(terminal.terminalId, terminal.processId, {
        operation: "output",
        processId: terminal.processId,
        outputSequence: terminal.supervisorOutputSequence,
      })
      this.appendOutputSnapshot(terminal.terminalId, context, output)
      this.updateFromOutput(terminal, output)
      if (terminal.consecutivePollFailures > 0 && this.terminals.has(terminal.terminalId)) {
        terminal.consecutivePollFailures = 0
        this.store.updateTerminal(terminal.terminalId, {
          metadata: { supervisorHealth: { state: "healthy", recoveredAt: nowIso() } },
        })
      }
      return output
    })()
    const trackedDrain = drain.finally(() => {
      if (terminal.drainPromise === trackedDrain) {
        delete terminal.drainPromise
      }
    })
    terminal.drainPromise = trackedDrain
    return trackedDrain
  }

  private async waitForPendingDrain(terminal: RuntimeTerminal): Promise<void> {
    await terminal.drainPromise?.catch(() => undefined)
  }

  private async drainInitialTerminalOutput(terminal: RuntimeTerminal, context: ToolExecutorContext): Promise<void> {
    const deadline = Date.now() + terminalInitialOutputDrainMs
    for (;;) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0 || !this.terminals.has(terminal.terminalId)) {
        return
      }
      await wait(Math.min(terminalInitialOutputPollMs, remainingMs))
      const output = await this.drainRuntimeTerminal(terminal, context).catch(() => undefined)
      if (!output || hasShellOutput(output) || !isActiveTerminalStatus(terminal.status)) {
        return
      }
    }
  }

  private updateFromOutput(terminal: RuntimeTerminal, output: BashToolOutput): void {
    const status = terminal.awaitingInput && output.process?.status === "running" ? "awaiting_input" : processStatusToTerminalStatus(output.process?.status)
    if (status === "missing") {
      this.markRuntimeTerminalDetached(terminal, {
        code: "terminal_supervisor_lost_process",
        message: "The Terminal supervisor no longer owns this PTY process.",
      })
      return
    }
    terminal.status = status
    this.store.updateTerminal(terminal.terminalId, {
      status,
      cwd: output.cwd,
      exitCode: output.exitCode,
      signal: output.signal ?? null,
      awaitingInput: status === "awaiting_input",
      ...(status === "exited" || status === "stopped" ? { completedAt: nowIso() } : {}),
    })
    if (status === "exited" || status === "stopped") {
      this.clearRuntimeTerminal(terminal)
      this.emitTerminalStatus(terminal, status === "stopped" ? "terminal.stopped" : "terminal.completed")
      this.wakeWaitingTasks(terminal.terminalId, status === "exited" && output.exitCode === 0 ? "completed" : "failed")
    } else {
      this.emitTerminalStatus(terminal)
    }
  }

  private async stopRuntimeTerminal(terminal: RuntimeTerminal, reason?: string): Promise<void> {
    await this.waitForPendingDrain(terminal)
    const output = await this.supervisor
      .stop(terminal.terminalId, terminal.processId, {
        operation: "stop",
        processId: terminal.processId,
        outputSequence: terminal.supervisorOutputSequence,
      })
      .catch(() => undefined)
    if (output) {
      this.appendOutputSnapshot(terminal.terminalId, undefined, output)
    }
    this.markRuntimeTerminalStopped(terminal, reason)
  }

  private markRuntimeTerminalStopped(terminal: RuntimeTerminal, reason?: string): void {
    terminal.status = "stopped"
    this.store.updateTerminal(terminal.terminalId, {
      status: "stopped",
      awaitingInput: false,
      signal: "SIGTERM",
      completedAt: nowIso(),
      ...(reason ? { metadata: { stopReason: reason } } : {}),
    })
    this.clearRuntimeTerminal(terminal)
    this.emitTerminalStatus(terminal, "terminal.stopped")
    this.wakeWaitingTasks(terminal.terminalId, "failed")
  }

  private markRuntimeTerminalMissing(terminal: RuntimeTerminal, error: unknown): void {
    if (!this.terminals.has(terminal.terminalId)) {
      return
    }
    const normalized = normalizeError(error)
    terminal.status = "missing"
    this.store.updateTerminal(terminal.terminalId, {
      status: "missing",
      awaitingInput: false,
      completedAt: nowIso(),
      metadata: { runtimeError: { code: normalized.code, message: normalized.message, details: normalized.details } },
    })
    this.clearRuntimeTerminal(terminal)
    this.emitTerminalStatus(terminal)
    this.wakeWaitingTasks(terminal.terminalId, "failed")
  }

  private handleSupervisorPollFailure(terminal: RuntimeTerminal, error: unknown): void {
    if (!this.terminals.has(terminal.terminalId)) return
    terminal.consecutivePollFailures += 1
    const normalized = normalizeError(error)
    this.store.updateTerminal(terminal.terminalId, {
      metadata: {
        supervisorHealth: {
          state: "degraded",
          failures: terminal.consecutivePollFailures,
          checkedAt: nowIso(),
          error: { code: normalized.code, message: normalized.message },
        },
      },
    })
    if (terminal.consecutivePollFailures >= maxConsecutiveSupervisorPollFailures) {
      this.markRuntimeTerminalMissing(terminal, error)
    }
  }

  private markRuntimeTerminalDetached(terminal: RuntimeTerminal, error: { code: string; message: string; details?: unknown }): void {
    if (!this.terminals.has(terminal.terminalId)) {
      return
    }
    terminal.status = "detached"
    this.store.updateTerminal(terminal.terminalId, {
      status: "detached",
      awaitingInput: false,
      completedAt: nowIso(),
      metadata: { runtimeError: error },
    })
    this.clearRuntimeTerminal(terminal)
    this.emitTerminalStatus(terminal)
    this.wakeWaitingTasks(terminal.terminalId, "failed")
  }

  private clearRuntimeTerminal(terminal: RuntimeTerminal): void {
    if (terminal.pollTimer) {
      clearInterval(terminal.pollTimer)
    }
    this.terminals.delete(terminal.terminalId)
  }

  private runtimeFromSnapshot(terminal: TerminalSnapshot): RuntimeTerminal {
    return {
      terminalId: terminal.terminalId,
      projectId: terminal.projectId,
      conversationId: terminal.conversationId,
      workspacePath: terminal.workspacePath,
      processId: terminal.processId ?? terminal.terminalId,
      command: terminal.command,
      name: terminal.name,
      status: terminal.status,
      awaitingInput: terminal.awaitingInput,
      supervisorOutputSequence: terminal.output.nextOutputSequence,
      consecutivePollFailures: 0,
    }
  }

  private appendOutputSnapshot(terminalId: string, context: ToolExecutorContext | undefined, output: BashToolOutput): void {
    if (context) {
      this.store.updateTerminal(terminalId, { metadata: { lastToolCallId: context.toolCallId, lastTurnId: context.turnId } })
    }
    if (output.stdout) {
      this.handleRuntimeOutput(terminalId, context, { stream: "pty", text: output.stdout })
    }
    if (output.stderr) {
      this.handleRuntimeOutput(terminalId, context, { stream: "stderr", text: output.stderr })
    }
    const runtime = this.terminals.get(terminalId)
    if (runtime && typeof output.process?.nextOutputSequence === "number") {
      runtime.supervisorOutputSequence = output.process.nextOutputSequence
    }
  }

  private async findReusableTerminal(
    conversationId: string,
    name: string,
    command: string,
    context: ToolExecutorContext,
  ): Promise<ReturnType<SocratesStore["listConversationTerminals"]>[number] | undefined> {
    const activeRuntime = [...this.terminals.values()].find(
      (terminal) => terminal.conversationId === conversationId && terminal.name === name && isActiveTerminalStatus(terminal.status),
    )
    if (activeRuntime) {
      await this.drainRuntimeTerminal(activeRuntime, context).catch(() => undefined)
      return this.store.listConversationTerminals(conversationId).find((terminal) => terminal.terminalId === activeRuntime.terminalId)
    }

    return this.store
      .listConversationTerminals(conversationId)
      .find((terminal) => terminal.name === name && isActiveTerminalStatus(terminal.status) && terminal.command === command)
  }

  private findRuntimeTerminal(conversationId: string | undefined, identifier: string): RuntimeTerminal | undefined {
    const exact = [...this.terminals.values()].find(
      (terminal) =>
        (!conversationId || terminal.conversationId === conversationId) && (terminal.terminalId === identifier || terminal.processId === identifier),
    )
    if (exact) {
      return exact
    }
    const byName = [...this.terminals.values()].filter((terminal) => (!conversationId || terminal.conversationId === conversationId) && terminal.name === identifier)
    const activeByName = byName.filter((terminal) => isActiveTerminalStatus(terminal.status))
    if (activeByName.length === 1) {
      return activeByName[0]
    }
    return byName.length === 1 ? byName[0] : undefined
  }

  private emitTerminalStatus(
    terminal: RuntimeTerminal,
    type: "terminal.started" | "terminal.status" | "terminal.completed" | "terminal.stopped" = "terminal.status",
  ): void {
    const terminalSnapshot = this.store.listConversationTerminals(terminal.conversationId).find((item) => item.terminalId === terminal.terminalId)
    if (terminalSnapshot) {
      this.emitTerminalEvent(type, terminalSnapshot)
    }
  }

  private emitTerminalEvent(
    type:
      | "terminal.started"
      | "terminal.data"
      | "terminal.output"
      | "terminal.status"
      | "terminal.input.requested"
      | "terminal.completed"
      | "terminal.stopped"
      | "terminal.stale",
    terminal: TerminalSnapshot,
    extra: Record<string, unknown> = {},
  ): void {
    const event = makeEvent(
      type,
      {
        terminalId: terminal.terminalId,
        name: terminal.name,
        command: terminal.command,
        cwd: terminal.cwd,
        workspacePath: terminal.workspacePath,
        status: terminal.status,
        ...(terminal.platform ? { platform: terminal.platform } : {}),
        ...(terminal.shellKind ? { shellKind: terminal.shellKind } : {}),
        ...(terminal.shellExecutable ? { shellExecutable: terminal.shellExecutable } : {}),
        ...(terminal.processId ? { processId: terminal.processId } : {}),
        ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
        ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
        autoDetached: terminal.autoDetached,
        awaitingInput: terminal.awaitingInput,
        ...(terminal.lastPrompt ? { lastPrompt: terminal.lastPrompt } : {}),
        nextOutputSequence: terminal.output.nextOutputSequence,
        startedAt: terminal.startedAt,
        updatedAt: terminal.updatedAt,
        ...(terminal.completedAt ? { completedAt: terminal.completedAt } : {}),
        ...extra,
      } as never,
      {
        projectId: terminal.projectId,
        conversationId: terminal.conversationId,
        actor: { type: "tool", id: terminal.terminalId, label: "Terminal" },
      },
    )
    this.store.appendEvent({
      projectId: terminal.projectId,
      conversationId: terminal.conversationId,
      type: event.type,
      source: "terminal",
      payload: event.payload,
    })
    this.subscriptions.emit(event)
  }

  private wakeWaitingTasks(terminalId: string, event: "completed" | "failed" | "input_required"): void {
    const tasks = this.store.claimTerminalTaskWake(terminalId, event)
    for (const task of tasks) {
      this.onTaskReady?.(task)
    }
  }
}

const terminalCommandScope = (command: Pick<ClientCommand, "projectId" | "conversationId">): { projectId: string; conversationId: string } => {
  if (!command.projectId || !command.conversationId) {
    throw new SocratesError("missing_command_scope", "projectId and conversationId are required for Terminal controls.", { recoverable: true })
  }
  return { projectId: command.projectId, conversationId: command.conversationId }
}

const assertTerminalScope = (
  terminal: Pick<RuntimeTerminal, "projectId" | "conversationId">,
  scope: { projectId: string; conversationId: string },
): void => {
  if (terminal.projectId === scope.projectId && terminal.conversationId === scope.conversationId) {
    return
  }
  throw new SocratesError("terminal_scope_mismatch", "Terminal does not belong to this project conversation.", { recoverable: true })
}

const withTerminalMetadata = (output: BashToolOutput, terminal: ReturnType<SocratesStore["listConversationTerminals"]>[number] | undefined, autoDetached?: boolean): BashToolOutput => {
  if (!terminal) {
    return output
  }
  return {
    ...output,
    terminal: {
      terminalId: terminal.terminalId,
      name: terminal.name,
      status: terminal.status,
      autoDetached: autoDetached ?? terminal.autoDetached,
      awaitingInput: terminal.awaitingInput,
      ...(terminal.lastPrompt ? { lastPrompt: terminal.lastPrompt } : {}),
      nextOutputSequence: terminal.output.nextOutputSequence,
      startedAt: terminal.startedAt,
      updatedAt: terminal.updatedAt,
    },
  }
}

const storedTerminalFromRow = (store: SocratesStore, conversationId: string, terminalId: string) => {
  const terminal = store.listConversationTerminals(conversationId).find((item) => item.terminalId === terminalId)
  if (!terminal) {
    throw new SocratesError("terminal_not_found", "Terminal was not found.", { details: { terminalId }, recoverable: true })
  }
  return terminal
}

const storedTerminalOutput = (
  store: SocratesStore,
  operation: "run" | "start" | "status" | "output" | "stop",
  terminal: ReturnType<typeof storedTerminalFromRow>,
  options: { message?: string; reusedTerminal?: boolean; autoDetached?: boolean; charLimit?: number | undefined } = {},
): BashToolOutput => {
  const fromSequence = store.getModelVisibleTerminalOutputSequence(terminal.terminalId)
  const charLimit = Math.min(options.charLimit ?? maxModelTerminalOutputChars, maxModelTerminalOutputChars)
  const output = store.terminalOutputSnapshot(terminal.terminalId, fromSequence, charLimit)
  store.setModelVisibleTerminalOutputSequence(terminal.terminalId, output.modelVisibleNextSequence)
  const message =
    options.message ??
    (fromSequence > 0 && output.returnedLength === 0
      ? "No new Terminal output since the last model-visible check. Full Terminal history remains available in the backend and UI."
      : undefined)
  return {
    operation,
    command: terminal.command,
    cwd: terminal.cwd,
    exitCode: terminal.exitCode ?? null,
    ...(terminal.signal ? { signal: terminal.signal } : {}),
    stdout: output.stdout,
    stderr: output.stderr,
    ...(message ? { message } : {}),
    ...(options.reusedTerminal !== undefined ? { reusedTerminal: options.reusedTerminal } : {}),
    durationMs: 0,
    timedOut: false,
    truncation: {
      truncated: output.truncated,
      charLimit,
      originalLength: output.originalLength,
      returnedLength: output.returnedLength,
    },
    shell: {
      platform: terminal.platform ?? process.platform,
      kind: terminal.shellKind ?? (process.platform === "win32" ? "powershell" : "posix"),
      executable: terminal.shellExecutable ?? "unknown",
    },
    process: {
      processId: terminal.processId ?? terminal.terminalId,
      status: terminal.status === "running" || terminal.status === "awaiting_input" ? "running" : terminal.status === "stopped" ? "stopped" : "exited",
      exitCode: terminal.exitCode ?? null,
      ...(terminal.signal ? { signal: terminal.signal } : {}),
      startedAt: terminal.startedAt,
      ...(terminal.completedAt ? { exitedAt: terminal.completedAt } : {}),
      nextOutputSequence: terminal.output.nextOutputSequence,
    },
    terminal: {
      terminalId: terminal.terminalId,
      name: terminal.name,
      status: terminal.status,
      autoDetached: options.autoDetached ?? terminal.autoDetached,
      awaitingInput: terminal.awaitingInput,
      ...(terminal.lastPrompt ? { lastPrompt: terminal.lastPrompt } : {}),
      nextOutputSequence: terminal.output.nextOutputSequence,
      startedAt: terminal.startedAt,
      updatedAt: terminal.updatedAt,
    },
  }
}

const isActiveTerminalStatus = (status: TerminalStatus): boolean => status === "running" || status === "awaiting_input"

const isRuntimeTerminal = (terminal: RuntimeTerminal | ReturnType<typeof storedTerminalFromRow>): terminal is RuntimeTerminal => !("output" in terminal)

const assertModelCanStopTerminal = (
  terminal: Pick<RuntimeTerminal, "terminalId" | "name" | "status" | "awaitingInput"> & { lastPrompt?: string | undefined },
): void => {
  if (terminal.status !== "awaiting_input" && !terminal.awaitingInput) {
    return
  }
  throw new SocratesError("terminal_awaiting_user_input", terminalAwaitingUserInputStopMessage, {
    recoverable: true,
    details: {
      terminalId: terminal.terminalId,
      name: terminal.name,
      ...(terminal.lastPrompt ? { prompt: terminal.lastPrompt } : {}),
    },
  })
}

const hasShellOutput = (output: BashToolOutput): boolean => Boolean(output.stdout || output.stderr)

const runtimeTerminalCandidate = (terminal: RuntimeTerminal) => ({
  name: terminal.name,
  status: terminal.status,
  command: terminal.command,
  cwd: terminal.workspacePath,
})

const storedTerminalCandidate = (terminal: ReturnType<SocratesStore["listConversationTerminals"]>[number]) => ({
  name: terminal.name,
  status: terminal.status,
  command: terminal.command,
  cwd: terminal.cwd,
})

const ambiguousTerminalError = (candidates: Array<{ name: string; status: string; command: string; cwd: string }>): SocratesError =>
  new SocratesError("terminal_ambiguous", "Multiple active Terminals are available. Provide the Terminal name to target one.", {
    details: { candidates },
    recoverable: true,
  })

const processStatusToTerminalStatus = (status: string | undefined): TerminalStatus => {
  if (status === "running") {
    return "running"
  }
  if (status === "stopped") {
    return "stopped"
  }
  if (status === "missing") {
    return "missing"
  }
  return "exited"
}

const inferTerminalName = (command: string): string => {
  if (/\b(test|vitest|jest|watch)\b/i.test(command)) {
    return "test-watch"
  }
  if (/\b(frontend|vite|next|web)\b/i.test(command)) {
    return "frontend"
  }
  if (/\b(backend|server|uvicorn|fastapi|flask|django)\b/i.test(command)) {
    return "backend"
  }
  if (/\b(dev|serve|start)\b/i.test(command)) {
    return "dev-server"
  }
  return "terminal"
}

const terminalInputText = (payload: Extract<ClientCommand, { type: "terminal.input" }>["payload"]): string => {
  if (payload.data !== undefined) {
    return payload.data
  }
  if (payload.key) {
    return terminalKeySequence(payload.key)
  }
  return `${payload.text ?? ""}${payload.submit === false ? "" : "\n"}`
}

const terminalKeySequence = (key: NonNullable<Extract<ClientCommand, { type: "terminal.input" }>["payload"]["key"]>): string => {
  switch (key) {
    case "ArrowUp":
      return "\u001b[A"
    case "ArrowDown":
      return "\u001b[B"
    case "ArrowLeft":
      return "\u001b[D"
    case "ArrowRight":
      return "\u001b[C"
    case "Enter":
      return "\r"
    case "Escape":
      return "\u001b"
    case "Ctrl-C":
      return "\u0003"
  }
}

const detectPrompt = (text: string): string | undefined => {
  const lines = text.split(/\r?\n/).map((line) => stripAnsi(line).trim()).filter(Boolean)
  const joined = lines.join(" ")
  const inquirerLine = [...lines].reverse().find((line) => /\b(select|choose|use arrow-keys|return to submit|press enter)\b|[›❯❯]/i.test(line))
  const candidate = inquirerLine ?? lines.at(-1)
  if (!candidate) {
    return undefined
  }
  if (/\b(select|choose|use arrow-keys|return to submit)\b|[›❯]/i.test(joined)) {
    return joined.slice(-300)
  }
  if (/(password|token|api\s*key|secret|passphrase)\s*[:?]?$/i.test(candidate)) {
    return candidate
  }
  if (/(\[[YyNn]\/[YyNn]\]|\([YyNn]\/[YyNn]\)|press enter|select|choose|continue\?|overwrite\?|install\?|proceed\?|:\s*$|\?\s*$|[›❯]\s*)/i.test(candidate)) {
    return candidate
  }
  return undefined
}

const isSecretPrompt = (prompt: string): boolean => /(password|token|api\s*key|secret|passphrase)/i.test(prompt)
const stripAnsi = (text: string): string => text.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
const normalizePtyForModel = (text: string): string => stripAnsi(text).replaceAll("\r\n", "\n").replaceAll(/\r(?!\n)/g, "\n")
const clipText = (value: string, limit: number): string => (value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`)

const supervisorHealthMetadata = (health: TerminalSupervisorHealth) => ({
  instanceId: health.instanceId,
  processId: health.processId,
  startedAt: health.startedAt,
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
