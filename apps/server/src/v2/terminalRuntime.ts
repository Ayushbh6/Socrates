import type {
  BashToolInput,
  BashToolOutput,
  TerminalWaitWakeOn,
  V2ServerEvent,
  V2Terminal,
  WaitToolInput,
  WaitToolOutput,
} from "@socrates/contracts"
import type { ToolExecutorContext } from "@socrates/core"
import { normalizeError, nowIso, SocratesError } from "@socrates/shared"
import { runWorkspaceArgv } from "@socrates/workspace"
import type { V2FlowStore, V2ReadyTerminalTask, V2TerminalRuntimeRecord } from "../services/v2/flowStore"
import { TerminalSupervisorClient } from "../ws/terminalSupervisorClient"

type TerminalScope = {
  projectId: string
  flowId: string
  goalId?: string
  turnId: string
  workspacePath: string
}

type RuntimeTerminal = {
  record: V2TerminalRuntimeRecord
  pollTimer?: NodeJS.Timeout
  drainPromise?: Promise<BashToolOutput>
  inputDetectionTimer?: NodeJS.Timeout
  promptFrame: string
  consecutivePollFailures: number
  stopping: boolean
}

type TerminalRuntimeOptions = {
  autoDetachMs?: number
  supervisorScope?: string
}

export type V2TerminalEventEmitter = <T extends V2ServerEvent["type"]>(
  type: T,
  payload: Extract<V2ServerEvent, { type: T }>["payload"],
  scope: { projectId: string; flowId: string; goalId?: string; turnId?: string },
  source?: string,
) => void

const defaultAutoDetachMs = Number.parseInt(process.env.SOCRATES_TERMINAL_AUTO_DETACH_MS ?? "15000", 10)
const maxConsecutivePollFailures = 3
const maxPromptFrameChars = 2_000

/**
 * Seamless Terminal lifecycle. PTYs live in the shared low-level supervisor,
 * while every user-visible row, output chunk, wait, and continuation is kept
 * exclusively in V2 tables.
 */
export class V2TerminalRuntime {
  private readonly supervisor: TerminalSupervisorClient
  private readonly terminals = new Map<string, RuntimeTerminal>()
  private readonly inFlightStarts = new Set<Promise<BashToolOutput>>()
  private readonly autoDetachMs: number
  private lifecycle: "open" | "closing" | "closed" = "open"
  private onTaskReady: ((task: V2ReadyTerminalTask) => void) | undefined

  constructor(
    private readonly store: V2FlowStore,
    private readonly emit: V2TerminalEventEmitter,
    options: TerminalRuntimeOptions = {},
  ) {
    this.autoDetachMs = options.autoDetachMs ?? defaultAutoDetachMs
    this.supervisor = new TerminalSupervisorClient(options.supervisorScope)
  }

  setTaskWakeHandler(handler: (task: V2ReadyTerminalTask) => void): void {
    this.onTaskReady = handler
  }

  clearTaskWakeHandler(): void {
    this.onTaskReady = undefined
  }

  beginShutdown(): void {
    if (this.lifecycle !== "open") return
    this.lifecycle = "closing"
    this.clearTaskWakeHandler()
  }

  async reconcilePersistedTerminals(): Promise<void> {
    const health = (await this.supervisor.inspectHealth()) ?? (await this.supervisor.health().catch(() => undefined))
    for (const record of this.store.listTerminalRuntimeRecords(undefined, true)) {
      const owned = health ? await this.supervisor.has(record.terminal.id).catch(() => false) : false
      if (!owned) {
        const terminal = this.store.updateTerminal(record.terminal.id, {
          status: "missing",
          awaitingInput: false,
          completedAt: nowIso(),
          metadata: {
            supervisorRecovery: {
              state: health ? "process_missing" : "supervisor_unavailable",
              checkedAt: nowIso(),
            },
          },
        })
        this.emitTerminal(terminal)
        this.wakeWaitingTasks(terminal.id, "failed")
        continue
      }
      const output = await this.supervisor.status(record.terminal.id, record.processId, {
        operation: "status",
        outputSequence: record.supervisorOutputSequence,
      }).catch(() => undefined)
      if (!output) {
        this.markMissing(record, new SocratesError("terminal_supervisor_unavailable", "Terminal supervisor could not restore this process.", { recoverable: true }))
        continue
      }
      let runtime = this.runtimeFromRecord(record)
      this.terminals.set(record.terminal.id, runtime)
      this.appendOutput(runtime, output)
      this.updateFromOutput(runtime, output)
      runtime = this.terminals.get(record.terminal.id) ?? runtime
      if (this.terminals.has(record.terminal.id)) this.startPolling(runtime)
    }

    // A crash can happen after the supervisor recorded completion but before
    // the waiting task was claimed. Replaying terminal truth makes that wake
    // idempotent during startup.
    for (const record of this.store.listTerminalRuntimeRecords()) {
      const wakeEvent = terminalWakeEvent(record.terminal)
      if (wakeEvent) this.wakeWaitingTasks(record.terminal.id, wakeEvent)
    }
  }

  async dispose(options: { preserveRunning?: boolean } = {}): Promise<void> {
    this.beginShutdown()
    await Promise.allSettled([...this.inFlightStarts])
    await Promise.allSettled([...this.terminals.values()].map((runtime) => runtime.drainPromise))
    for (const runtime of this.terminals.values()) {
      clearInterval(runtime.pollTimer)
      clearTimeout(runtime.inputDetectionTimer)
    }
    if (options.preserveRunning) {
      await this.supervisor.shutdownIfIdle()
    } else {
      await Promise.allSettled([...this.terminals.values()].map((runtime) => this.stopRuntime(runtime)))
      await this.supervisor.shutdown()
    }
    this.terminals.clear()
    this.lifecycle = "closed"
  }

  async execute(input: BashToolInput, scope: TerminalScope, context: ToolExecutorContext): Promise<BashToolOutput> {
    if (this.lifecycle !== "open" || context.abortSignal?.aborted) {
      throw new SocratesError("terminal_runtime_closing", "Terminal runtime is shutting down.", { recoverable: true })
    }
    if (input.argv) return runWorkspaceArgv(input, context)
    const operation = input.operation ?? "run"
    if (operation === "list") return this.list(scope, input.limit, input.charLimit)
    if (operation === "status") return this.status(input, scope, context)
    if (operation === "output") return this.output(input, scope, context)
    if (operation === "stop") return this.stopFromTool(input, scope, context)
    if (!input.command) throw new SocratesError("shell_command_required", "A command is required for this Terminal operation.")
    if (operation === "start") return this.startTracked(input, scope, context, false)
    return this.runWithAutoDetach(input, scope, context)
  }

  async wait(input: WaitToolInput, scope: Pick<TerminalScope, "projectId" | "flowId" | "goalId" | "turnId">): Promise<WaitToolOutput> {
    if (!scope.goalId) throw new SocratesError("v2_turn_goal_missing", "The Flow turn has no active goal.", { recoverable: true })
    const registered = this.store.registerTerminalWait({
      projectId: scope.projectId,
      flowId: scope.flowId,
      goalId: scope.goalId,
      turnId: scope.turnId,
      wait: input,
    })
    return {
      status: registered.status,
      terminalNames: input.terminalNames,
      wakeOn: input.wakeOn,
      reason: input.reason,
      message: registered.message,
    }
  }

  async writeInput(scope: { projectId: string; flowId: string }, terminalId: string, input: {
    data?: string
    text?: string
    key?: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Escape" | "Ctrl-C"
    submit?: boolean
  }): Promise<void> {
    const runtime = this.requireRuntime(scope, terminalId)
    const text = input.data ?? `${input.text ?? keyText(input.key)}${input.submit ? "\r" : ""}`
    const prompt = runtime.record.lastPrompt
    runtime.record.terminal = this.store.updateTerminal(terminalId, { status: "running", awaitingInput: false, lastPrompt: "" })
    this.emitTerminal(runtime.record.terminal)
    try {
      await this.supervisor.input(terminalId, runtime.record.processId, text)
    } catch (error) {
      runtime.record.terminal = this.store.updateTerminal(terminalId, {
        status: "awaiting_input",
        awaitingInput: true,
        ...(prompt ? { lastPrompt: prompt } : {}),
      })
      this.emitTerminal(runtime.record.terminal)
      throw error
    }
    const sequence = this.store.appendTerminalOutput(terminalId, "input", "[user input sent]\n", true)
    this.emit("v2.terminal.output", { terminalId, sequence, stream: "input", text: "", redacted: true }, terminalScope(runtime.record.terminal), "terminal")
  }

  async resize(scope: { projectId: string; flowId: string }, terminalId: string, cols: number, rows: number): Promise<void> {
    const runtime = this.requireRuntime(scope, terminalId)
    await this.supervisor.resize(terminalId, runtime.record.processId, cols, rows).catch(() => undefined)
  }

  async stop(scope: { projectId: string; flowId: string }, terminalId: string): Promise<V2Terminal> {
    const runtime = this.terminals.get(terminalId)
    if (runtime) {
      if (runtime.record.terminal.projectId !== scope.projectId || runtime.record.terminal.flowId !== scope.flowId) {
        throw new SocratesError("v2_terminal_scope_mismatch", "This Terminal belongs to another Flow.", { recoverable: true })
      }
      await this.stopRuntime(runtime)
      return this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, terminalId)!.terminal
    }
    const stored = this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, terminalId)
    if (!stored) throw new SocratesError("v2_terminal_not_found", "Flow Terminal not found.", { recoverable: true })
    if (isActiveTerminal(stored.terminal.status)) {
      const output = await this.supervisor.stop(stored.terminal.id, stored.processId, { operation: "stop", outputSequence: stored.supervisorOutputSequence }).catch(() => undefined)
      if (output) {
        const transient = this.runtimeFromRecord(stored)
        this.appendOutput(transient, output)
      }
    }
    const terminal = this.store.updateTerminal(stored.terminal.id, { status: "stopped", awaitingInput: false, signal: "SIGTERM", completedAt: nowIso() })
    this.emitTerminal(terminal)
    this.wakeWaitingTasks(terminal.id, "failed")
    return terminal
  }

  rename(scope: { projectId: string; flowId: string }, terminalId: string, name: string): V2Terminal {
    const stored = this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, terminalId)
    if (!stored) throw new SocratesError("v2_terminal_not_found", "Flow Terminal not found.", { recoverable: true })
    const terminal = this.store.updateTerminal(stored.terminal.id, { name })
    const runtime = this.terminals.get(terminal.id)
    if (runtime) runtime.record.terminal = terminal
    this.emitTerminal(terminal)
    return terminal
  }

  // A V2 Terminal is task/Flow scoped, not turn-process scoped. Completion of
  // one agent invocation must never terminate its independently supervised PTY.
  endTurn(_turnId: string): void {}

  private startTracked(input: BashToolInput, scope: TerminalScope, context: ToolExecutorContext, autoDetached: boolean): Promise<BashToolOutput> {
    const start = this.start(input, scope, context, autoDetached)
    this.inFlightStarts.add(start)
    return start.finally(() => this.inFlightStarts.delete(start))
  }

  private async start(input: BashToolInput, scope: TerminalScope, context: ToolExecutorContext, autoDetached: boolean): Promise<BashToolOutput> {
    if (!input.command) throw new SocratesError("shell_command_required", "A command is required for Terminal start.")
    const terminal = this.store.createTerminal({
      projectId: scope.projectId,
      flowId: scope.flowId,
      ...(scope.goalId ? { goalId: scope.goalId } : {}),
      turnId: scope.turnId,
      name: this.uniqueName(scope.flowId, input.name ?? inferTerminalName(input.command)),
      command: input.command,
      cwd: input.cwd ?? scope.workspacePath,
      autoDetached,
      metadata: {
        inputMode: input.inputMode ?? "none",
        supervisorOutputSequence: 0,
        modelVisibleOutputSequence: 0,
        ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      },
    })
    this.emitTerminal(terminal)
    let output: BashToolOutput
    try {
      output = await this.supervisor.start(terminal.id, scope.workspacePath, { ...input, operation: "start" })
    } catch (error) {
      const failed = this.store.updateTerminal(terminal.id, {
        status: "missing",
        awaitingInput: false,
        completedAt: nowIso(),
        metadata: { startError: normalizeError(error) },
      })
      this.emitTerminal(failed)
      throw error
    }
    const processId = output.process?.processId
    if (!processId) {
      this.store.updateTerminal(terminal.id, { status: "missing", awaitingInput: false, completedAt: nowIso() })
      throw new SocratesError("terminal_start_failed", "Terminal process did not return a process id.", { recoverable: true })
    }
    const status = processStatus(output)
    const updated = this.store.updateTerminal(terminal.id, {
      status,
      processId,
      platform: output.shell.platform,
      shellKind: output.shell.kind,
      shellExecutable: output.shell.executable,
      ...(output.exitCode === null ? {} : { exitCode: output.exitCode }),
      awaitingInput: false,
      ...(isFinishedStatus(status) ? { completedAt: nowIso() } : {}),
      metadata: { systemPid: output.process?.systemPid },
    })
    const record = this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, updated.id)
    if (!record) throw new SocratesError("v2_terminal_not_found", "Flow Terminal was not persisted.")
    const runtime = this.runtimeFromRecord(record)
    this.terminals.set(updated.id, runtime)
    this.appendOutput(runtime, output, context)
    runtime.record = this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, updated.id) ?? runtime.record
    if (status === "running") {
      if (record.inputMode === "user") this.markAwaitingInput(runtime, promptFrom(runtime.promptFrame) || "Terminal is ready for user input.")
      this.startPolling(runtime)
    } else {
      this.clearRuntime(runtime)
      this.wakeWaitingTasks(updated.id, status === "exited" && output.exitCode === 0 ? "completed" : "failed")
    }
    this.emitTerminal(runtime.record.terminal)
    return this.storedOutput(runtime.record, "start", input.charLimit)
  }

  private async runWithAutoDetach(input: BashToolInput, scope: TerminalScope, context: ToolExecutorContext): Promise<BashToolOutput> {
    const started = await this.startTracked(input, scope, context, true)
    const terminalId = started.terminal?.terminalId
    if (!terminalId || started.process?.status !== "running") return { ...started, operation: "run" }
    const deadline = Date.now() + this.autoDetachMs
    while (Date.now() < deadline) {
      const runtime = this.terminals.get(terminalId)
      if (!runtime || isFinishedStatus(runtime.record.terminal.status)) {
        const record = this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, terminalId)
        return record ? { ...this.storedOutput(record, "run", input.charLimit), operation: "run" } : { ...started, operation: "run" }
      }
      await wait(Math.min(100, deadline - Date.now()))
    }
    const record = this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, terminalId)
    return {
      ...(record ? this.storedOutput(record, "run", input.charLimit) : started),
      operation: "run",
      message: `Command continues in background Terminal "${record?.terminal.name ?? started.terminal?.name ?? "Terminal"}".`,
    }
  }

  private async status(input: BashToolInput, scope: TerminalScope, context: ToolExecutorContext): Promise<BashToolOutput> {
    const record = this.resolveRecord(input, scope)
    const runtime = this.terminals.get(record.terminal.id)
    if (runtime) await this.drain(runtime, context)
    return this.storedOutput(this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, record.terminal.id) ?? record, "status", input.charLimit)
  }

  private async output(input: BashToolInput, scope: TerminalScope, context: ToolExecutorContext): Promise<BashToolOutput> {
    const record = this.resolveRecord(input, scope)
    const runtime = this.terminals.get(record.terminal.id)
    if (runtime) await this.drain(runtime, context)
    return this.storedOutput(this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, record.terminal.id) ?? record, "output", input.charLimit)
  }

  private async stopFromTool(input: BashToolInput, scope: TerminalScope, context: ToolExecutorContext): Promise<BashToolOutput> {
    const record = this.resolveRecord(input, scope)
    const runtime = this.terminals.get(record.terminal.id)
    if (runtime) await this.drain(runtime, context).catch(() => undefined)
    await this.stop(scope, record.terminal.id)
    const stopped = this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, record.terminal.id) ?? record
    return this.storedOutput(stopped, "stop", input.charLimit)
  }

  private list(scope: TerminalScope, limit = 8, charLimit = 12_000): BashToolOutput {
    const all = this.store.listTerminalRuntimeRecords(scope.flowId)
    const rows = all.slice(-Math.max(1, Math.min(12, limit))).reverse()
    const terminals = rows.map((record) => ({
      name: clip(record.terminal.name, 96),
      command: clip(record.terminal.command, 320),
      cwd: clip(record.terminal.cwd, 320),
      status: bashTerminalStatus(record.terminal.status),
      awaitingInput: record.terminal.awaitingInput,
      autoDetached: record.autoDetached,
      startedAt: record.terminal.startedAt,
      updatedAt: record.terminal.updatedAt,
      ...(record.terminal.completedAt ? { completedAt: record.terminal.completedAt } : {}),
      ...(record.terminal.exitCode === undefined ? {} : { exitCode: record.terminal.exitCode }),
      ...(record.signal ? { signal: clip(record.signal, 80) } : {}),
      hasNewOutput: this.store.terminalOutputSnapshot(record.terminal.id, record.modelVisibleOutputSequence, 1).originalLength > 0,
    }))
    const full = terminals.map((row) => `${row.name}: ${row.status}${row.awaitingInput ? " (awaiting input)" : ""}\n  command: ${row.command}\n  cwd: ${row.cwd}`).join("\n")
    const stdout = clip(full, Math.min(12_000, charLimit))
    return {
      operation: "list",
      cwd: scope.workspacePath,
      exitCode: null,
      stdout,
      stderr: "",
      ...(rows.length === 0 ? { message: "No Flow Terminals exist." } : {}),
      durationMs: 0,
      timedOut: false,
      truncation: truncation(full, stdout, Math.min(12_000, charLimit)),
      shell: shellFor(rows[0]),
      terminals,
      totalMatches: all.length,
    }
  }

  private resolveRecord(input: BashToolInput, scope: TerminalScope): V2TerminalRuntimeRecord {
    const identifier = input.terminalId ?? input.processId ?? input.name ?? input.target
    if (identifier) {
      const found = this.store.findTerminalRuntimeRecord(scope.projectId, scope.flowId, identifier)
      if (found) return found
      throw new SocratesError("v2_terminal_not_found", `No Flow Terminal matched "${identifier}".`, { recoverable: true })
    }
    const active = this.store.listTerminalRuntimeRecords(scope.flowId, true)
    if (active.length === 1 && active[0]) return active[0]
    throw new SocratesError(active.length === 0 ? "v2_terminal_not_found" : "v2_terminal_target_required", active.length === 0 ? "This Flow has no active Terminal." : "Name the Flow Terminal to control.", { recoverable: true })
  }

  private requireRuntime(scope: { projectId: string; flowId: string }, terminalId: string): RuntimeTerminal {
    const runtime = this.terminals.get(terminalId)
    if (!runtime || runtime.record.terminal.projectId !== scope.projectId || runtime.record.terminal.flowId !== scope.flowId) {
      throw new SocratesError("v2_terminal_not_running", "This Flow Terminal is not currently accepting process control.", { recoverable: true })
    }
    return runtime
  }

  private runtimeFromRecord(record: V2TerminalRuntimeRecord): RuntimeTerminal {
    return { record, promptFrame: "", consecutivePollFailures: 0, stopping: false }
  }

  private startPolling(runtime: RuntimeTerminal): void {
    if (runtime.pollTimer) return
    runtime.pollTimer = setInterval(() => {
      void this.poll(runtime).catch((error) => this.handlePollFailure(runtime, error))
    }, 500)
    runtime.pollTimer.unref?.()
  }

  private async poll(runtime: RuntimeTerminal): Promise<void> {
    if (runtime.stopping || runtime.drainPromise) return
    await this.drain(runtime)
  }

  private async drain(runtime: RuntimeTerminal, context?: ToolExecutorContext): Promise<BashToolOutput> {
    if (runtime.drainPromise) return runtime.drainPromise
    const drain = (async () => {
      const output = await this.supervisor.output(runtime.record.terminal.id, runtime.record.processId, {
        operation: "output",
        outputSequence: runtime.record.supervisorOutputSequence,
      })
      this.appendOutput(runtime, output, context)
      this.updateFromOutput(runtime, output)
      runtime.consecutivePollFailures = 0
      return output
    })()
    const tracked = drain.finally(() => {
      if (runtime.drainPromise === tracked) delete runtime.drainPromise
    })
    runtime.drainPromise = tracked
    return tracked
  }

  private appendOutput(runtime: RuntimeTerminal, output: BashToolOutput, context?: ToolExecutorContext): void {
    if (output.stdout) this.persistOutput(runtime, "pty", output.stdout, context)
    if (output.stderr) this.persistOutput(runtime, "stderr", output.stderr, context)
    const next = output.process?.nextOutputSequence
    if (typeof next === "number") {
      runtime.record.supervisorOutputSequence = Math.max(runtime.record.supervisorOutputSequence, next)
      this.store.setTerminalRuntimeCursors(runtime.record.terminal.id, { supervisorOutputSequence: runtime.record.supervisorOutputSequence })
    }
    runtime.record = this.store.findTerminalRuntimeRecord(runtime.record.terminal.projectId, runtime.record.terminal.flowId, runtime.record.terminal.id) ?? runtime.record
  }

  private persistOutput(runtime: RuntimeTerminal, stream: "pty" | "stderr", text: string, context?: ToolExecutorContext): void {
    if (!text) return
    const sequence = this.store.appendTerminalOutput(runtime.record.terminal.id, stream, text)
    context?.onOutput?.({ stream: stream === "pty" ? "stdout" : "stderr", text })
    this.emit("v2.terminal.output", { terminalId: runtime.record.terminal.id, sequence, stream, text, redacted: false }, terminalScope(runtime.record.terminal), "terminal")
    if (!runtime.record.terminal.awaitingInput) {
      runtime.promptFrame = `${runtime.promptFrame}${text}`.slice(-maxPromptFrameChars)
      if (runtime.record.inputMode === "user") {
        clearTimeout(runtime.inputDetectionTimer)
        runtime.inputDetectionTimer = setTimeout(() => {
          if (this.terminals.get(runtime.record.terminal.id) !== runtime || runtime.record.terminal.status !== "running") return
          this.markAwaitingInput(runtime, promptFrom(runtime.promptFrame) || "Terminal is ready for user input.")
        }, 180)
        runtime.inputDetectionTimer.unref?.()
      }
    }
  }

  private updateFromOutput(runtime: RuntimeTerminal, output: BashToolOutput): void {
    const status = runtime.record.terminal.awaitingInput && output.process?.status === "running" ? "awaiting_input" : processStatus(output)
    if (status === runtime.record.terminal.status && !isFinishedStatus(status)) return
    runtime.record.terminal = this.store.updateTerminal(runtime.record.terminal.id, {
      status,
      ...(output.exitCode === null ? {} : { exitCode: output.exitCode }),
      awaitingInput: status === "awaiting_input",
      ...(isFinishedStatus(status) ? { completedAt: nowIso() } : {}),
    })
    this.emitTerminal(runtime.record.terminal)
    if (isFinishedStatus(status)) {
      this.clearRuntime(runtime)
      this.wakeWaitingTasks(runtime.record.terminal.id, status === "exited" && output.exitCode === 0 ? "completed" : "failed")
    }
  }

  private markAwaitingInput(runtime: RuntimeTerminal, prompt: string): void {
    if (runtime.record.terminal.status !== "running") return
    runtime.record.terminal = this.store.updateTerminal(runtime.record.terminal.id, {
      status: "awaiting_input",
      awaitingInput: true,
      lastPrompt: clip(prompt, 500),
    })
    this.emitTerminal(runtime.record.terminal)
    this.wakeWaitingTasks(runtime.record.terminal.id, "input_required")
  }

  private async stopRuntime(runtime: RuntimeTerminal): Promise<void> {
    runtime.stopping = true
    await runtime.drainPromise?.catch(() => undefined)
    const output = await this.supervisor.stop(runtime.record.terminal.id, runtime.record.processId, {
      operation: "stop",
      outputSequence: runtime.record.supervisorOutputSequence,
    }).catch(() => undefined)
    if (output) this.appendOutput(runtime, output)
    runtime.record.terminal = this.store.updateTerminal(runtime.record.terminal.id, {
      status: "stopped",
      awaitingInput: false,
      signal: "SIGTERM",
      completedAt: nowIso(),
    })
    this.clearRuntime(runtime)
    this.emitTerminal(runtime.record.terminal)
    this.wakeWaitingTasks(runtime.record.terminal.id, "failed")
  }

  private markMissing(record: V2TerminalRuntimeRecord, error: unknown): void {
    const runtime = this.terminals.get(record.terminal.id)
    if (runtime) this.clearRuntime(runtime)
    const normalized = normalizeError(error)
    const terminal = this.store.updateTerminal(record.terminal.id, {
      status: "missing",
      awaitingInput: false,
      completedAt: nowIso(),
      metadata: { runtimeError: { code: normalized.code, message: normalized.message } },
    })
    this.emitTerminal(terminal)
    this.wakeWaitingTasks(terminal.id, "failed")
  }

  private handlePollFailure(runtime: RuntimeTerminal, error: unknown): void {
    if (!this.terminals.has(runtime.record.terminal.id)) return
    runtime.consecutivePollFailures += 1
    if (runtime.consecutivePollFailures >= maxConsecutivePollFailures) this.markMissing(runtime.record, error)
  }

  private clearRuntime(runtime: RuntimeTerminal): void {
    clearInterval(runtime.pollTimer)
    clearTimeout(runtime.inputDetectionTimer)
    this.terminals.delete(runtime.record.terminal.id)
  }

  private wakeWaitingTasks(terminalId: string, wakeEvent: TerminalWaitWakeOn): void {
    for (const task of this.store.claimTerminalTaskWake(terminalId, wakeEvent)) this.onTaskReady?.(task)
  }

  private emitTerminal(terminal: V2Terminal): void {
    this.emit("v2.terminal.updated", { terminal }, terminalScope(terminal), "terminal")
  }

  private storedOutput(record: V2TerminalRuntimeRecord, operation: NonNullable<BashToolInput["operation"]>, charLimit = 16_000): BashToolOutput {
    const output = this.store.terminalOutputSnapshot(record.terminal.id, record.modelVisibleOutputSequence, Math.min(16_000, charLimit))
    this.store.setTerminalRuntimeCursors(record.terminal.id, { modelVisibleOutputSequence: output.nextSequence })
    return {
      operation,
      command: record.terminal.command,
      cwd: record.terminal.cwd,
      exitCode: record.terminal.exitCode ?? null,
      ...(record.signal ? { signal: record.signal } : {}),
      stdout: output.stdout,
      stderr: output.stderr,
      durationMs: Math.max(0, Date.now() - Date.parse(record.terminal.startedAt)),
      timedOut: false,
      truncation: {
        truncated: output.truncated,
        charLimit: Math.min(16_000, charLimit),
        originalLength: output.originalLength,
        returnedLength: output.returnedLength,
      },
      shell: shellFor(record),
      ...(record.processId ? {
        process: {
          processId: record.processId,
          status: processStatusForBash(record.terminal.status),
          exitCode: record.terminal.exitCode ?? null,
          ...(record.signal ? { signal: record.signal } : {}),
          startedAt: record.terminal.startedAt,
          ...(record.terminal.completedAt ? { exitedAt: record.terminal.completedAt } : {}),
          nextOutputSequence: record.supervisorOutputSequence,
        },
      } : {}),
      terminal: {
        terminalId: record.terminal.id,
        name: record.terminal.name,
        status: bashTerminalStatus(record.terminal.status),
        awaitingInput: record.terminal.awaitingInput,
        stateVersion: record.terminal.stateVersion,
        startedAt: record.terminal.startedAt,
        updatedAt: record.terminal.updatedAt,
      },
    }
  }

  private uniqueName(flowId: string, requested: string): string {
    const base = requested.trim().slice(0, 96) || "Terminal"
    const names = new Set(this.store.listTerminalRuntimeRecords(flowId).map((record) => record.terminal.name.toLowerCase()))
    if (!names.has(base.toLowerCase())) return base
    for (let index = 2; index < 1_000; index += 1) {
      const candidate = `${base.slice(0, 90)} ${index}`
      if (!names.has(candidate.toLowerCase())) return candidate
    }
    return `${base.slice(0, 70)} ${Date.now()}`
  }
}

const isActiveTerminal = (status: V2Terminal["status"]): boolean => ["starting", "running", "awaiting_input", "detached"].includes(status)
const isFinishedStatus = (status: V2Terminal["status"]): boolean => ["exited", "stopped", "stale", "missing"].includes(status)
const terminalWakeEvent = (terminal: V2Terminal): TerminalWaitWakeOn | undefined =>
  terminal.status === "awaiting_input" ? "input_required"
    : terminal.status === "exited" ? terminal.exitCode === 0 ? "completed" : "failed"
      : ["stopped", "detached", "stale", "missing"].includes(terminal.status) ? "failed" : undefined

const processStatus = (output: BashToolOutput): V2Terminal["status"] => {
  if (output.process?.status === "running") return "running"
  if (output.process?.status === "stopped") return "stopped"
  if (output.process?.status === "missing") return "missing"
  return "exited"
}

const processStatusForBash = (status: V2Terminal["status"]): "running" | "exited" | "stopped" | "missing" =>
  status === "running" || status === "awaiting_input" || status === "starting" || status === "detached" ? "running"
    : status === "exited" ? "exited" : status === "stopped" ? "stopped" : "missing"

const bashTerminalStatus = (status: V2Terminal["status"]): "starting" | "running" | "awaiting_input" | "exited" | "stopped" | "stale" | "missing" =>
  status === "detached" ? "stale" : status

const shellFor = (record?: V2TerminalRuntimeRecord): BashToolOutput["shell"] => {
  const kind: BashToolOutput["shell"]["kind"] =
    record?.shellKind === "powershell" || record?.shellKind === "cmd" || record?.shellKind === "direct"
      ? record.shellKind
      : "posix"
  return {
    platform: record?.platform ?? process.platform,
    kind,
    executable: record?.shellExecutable ?? process.env.SHELL ?? "terminal-supervisor",
  }
}

const terminalScope = (terminal: V2Terminal): { projectId: string; flowId: string; goalId?: string; turnId?: string } => ({
  projectId: terminal.projectId,
  flowId: terminal.flowId,
  ...(terminal.goalId ? { goalId: terminal.goalId } : {}),
  ...(terminal.turnId ? { turnId: terminal.turnId } : {}),
})

const inferTerminalName = (command: string): string => clip(command.trim().split(/\s+/)[0] || "Terminal", 96)
const clip = (value: string, limit: number): string => value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
const truncation = (full: string, returned: string, charLimit: number) => ({ truncated: returned.length < full.length, charLimit, originalLength: full.length, returnedLength: returned.length })
const promptFrom = (frame: string): string => clip(frame.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim().split(/\r?\n/).at(-1) ?? "", 500)
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const keyText = (key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Escape" | "Ctrl-C" | undefined): string => {
  switch (key) {
    case "ArrowUp": return "\u001b[A"
    case "ArrowDown": return "\u001b[B"
    case "ArrowLeft": return "\u001b[D"
    case "ArrowRight": return "\u001b[C"
    case "Enter": return "\r"
    case "Escape": return "\u001b"
    case "Ctrl-C": return "\u0003"
    default: return ""
  }
}
