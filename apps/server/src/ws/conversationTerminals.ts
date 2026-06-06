import type { WebSocket } from "ws"
import type { BashToolInput, BashToolOutput, ClientCommand, TerminalStatus } from "@socrates/contracts"
import { createId, normalizeError, nowIso, SocratesError } from "@socrates/shared"
import type { ToolExecutorContext } from "@socrates/core"
import type { SocratesStore } from "../services/store"
import type { ActiveTurns } from "./activeTurns"
import { makeEvent, sendEvent } from "./eventSender"
import { TerminalSupervisorClient } from "./terminalSupervisorClient"

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
}

type TerminalManagerOptions = {
  autoDetachMs?: number
  idleTtlMs?: number
}

type ShellOutput = { stream: "stdout" | "stderr" | "log" | "result"; text?: string; data?: unknown }
type TerminalSnapshot = ReturnType<SocratesStore["listConversationTerminals"]>[number]

const defaultAutoDetachMs = Number.parseInt(process.env.SOCRATES_TERMINAL_AUTO_DETACH_MS ?? "60000", 10)
const defaultIdleTtlMs = Number.parseInt(process.env.SOCRATES_TERMINAL_IDLE_TTL_MS ?? "7200000", 10)
const terminalInitialOutputDrainMs = 500
const terminalInitialOutputPollMs = 50

export class ConversationTerminalManager {
  private readonly terminals = new Map<string, RuntimeTerminal>()
  private readonly sockets = new Set<WebSocket>()
  private readonly supervisor = new TerminalSupervisorClient()
  private readonly autoDetachMs: number
  private readonly idleTtlMs: number

  constructor(
    private readonly store: SocratesStore,
    options: TerminalManagerOptions = {},
  ) {
    this.autoDetachMs = options.autoDetachMs ?? defaultAutoDetachMs
    this.idleTtlMs = options.idleTtlMs ?? defaultIdleTtlMs
  }

  subscribe(socket: WebSocket): void {
    this.sockets.add(socket)
    socket.on("close", () => this.sockets.delete(socket))
  }

  async reconcilePersistedTerminals(): Promise<void> {
    for (const terminal of this.store.listActiveTerminals()) {
      const owned = await this.supervisor.has(terminal.terminalId).catch(() => false)
      if (!owned) {
        this.store.updateTerminal(terminal.terminalId, {
          status: terminal.processId ? "detached" : "missing",
          awaitingInput: false,
          completedAt: nowIso(),
        })
        const snapshot = this.store.listConversationTerminals(terminal.conversationId).find((item) => item.terminalId === terminal.terminalId)
        if (snapshot) {
          this.emitTerminalEvent("terminal.status", snapshot)
        }
        continue
      }
      const runtime = this.runtimeFromSnapshot(terminal)
      this.terminals.set(terminal.terminalId, runtime)
      this.startPolling(runtime)
    }
  }

  dispose(): void {
    for (const terminal of this.terminals.values()) {
      this.clearRuntimeTerminal(terminal)
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
    if (shouldAutoDetachRun(input.command ?? "")) {
      return this.runWithAutoDetach(input, context)
    }
    return activeTurns.getShellSession(context.turnId, context.workspacePath).run(input, context)
  }

  async handleStop(command: Extract<ClientCommand, { type: "terminal.stop" }>): Promise<void> {
    const terminal = this.findRuntimeTerminal(command.conversationId, command.payload.terminalId)
    if (terminal) {
      await this.stopRuntimeTerminal(terminal, command.payload.reason)
      return
    }
    const row = command.conversationId ? this.store.findTerminal(command.conversationId, command.payload.terminalId) : undefined
    if (!row) {
      throw new SocratesError("terminal_not_found", "Terminal was not found.", { details: { terminalId: command.payload.terminalId }, recoverable: true })
    }
    this.store.updateTerminal(row.id, { status: "stopped", awaitingInput: false, signal: "SIGTERM", completedAt: nowIso() })
    const terminalSnapshot = this.store.listConversationTerminals(row.conversationId).find((item) => item.terminalId === row.id)
    if (terminalSnapshot) {
      this.emitTerminalEvent("terminal.stopped", terminalSnapshot)
    }
  }

  async handleInput(command: Extract<ClientCommand, { type: "terminal.input" }>): Promise<void> {
    const terminal = this.findRuntimeTerminal(command.conversationId, command.payload.terminalId)
    if (!terminal) {
      throw new SocratesError("terminal_not_running", "Terminal input can only be sent to a running terminal.", {
        details: { terminalId: command.payload.terminalId },
        recoverable: true,
      })
    }
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

  handleRename(command: Extract<ClientCommand, { type: "terminal.rename" }>): void {
    const row = command.conversationId ? this.store.findTerminal(command.conversationId, command.payload.terminalId) : undefined
    if (!row) {
      throw new SocratesError("terminal_not_found", "Terminal was not found.", { details: { terminalId: command.payload.terminalId }, recoverable: true })
    }
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
      return storedTerminalOutput("start", reusable, {
        message: `Reused existing Terminal "${reusable.name}" instead of starting a duplicate. Use output/status with this name to inspect it, or stop it before starting a different command.`,
        reusedTerminal: true,
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
    }
    this.terminals.set(terminalId, runtime)
    this.store.updateTerminal(terminalId, {
      cwd: output.cwd,
      platform: output.shell.platform,
      shellKind: output.shell.kind,
      shellExecutable: output.shell.executable,
      processId,
      status: "running",
      autoDetached,
      metadata: { toolCallId: context.toolCallId, systemPid: output.process?.systemPid },
    })
    this.appendOutputSnapshot(terminalId, context, output)
    if (!hasShellOutput(output)) {
      await this.drainInitialTerminalOutput(runtime, context)
    }
    this.emitTerminalStatus(runtime, "terminal.started")
    this.startPolling(runtime)
    const terminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === terminalId)
    return terminal ? storedTerminalOutput("start", terminal, { autoDetached }) : withTerminalMetadata(output, terminal, autoDetached)
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
        return this.terminalOutput({ operation: "output", terminalId, processId }, context)
      }
      if (Date.now() >= deadline) {
        return started
      }
      await wait(Math.min(100, deadline - Date.now()))
    }
  }

  private async terminalStatus(input: BashToolInput, context: ToolExecutorContext): Promise<BashToolOutput> {
    const runtime = this.resolveTerminal(input, context)
    if (isRuntimeTerminal(runtime)) {
      const output = await this.supervisor.status(runtime.terminalId, runtime.processId, { ...input, operation: "status", processId: runtime.processId })
      this.updateFromOutput(runtime, output)
      await this.drainRuntimeTerminal(runtime, context)
      const terminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === runtime.terminalId)
      return terminal ? storedTerminalOutput("status", terminal) : withTerminalMetadata(output, terminal)
    }
    return storedTerminalOutput("status", runtime)
  }

  private async terminalOutput(input: BashToolInput, context: ToolExecutorContext): Promise<BashToolOutput> {
    const runtime = this.resolveTerminal(input, context)
    if (isRuntimeTerminal(runtime)) {
      await this.drainRuntimeTerminal(runtime, context)
      const terminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === runtime.terminalId)
      if (!terminal) {
        throw new SocratesError("terminal_not_found", "Terminal was not found.", { details: { name: runtime.name }, recoverable: true })
      }
      return storedTerminalOutput("output", terminal)
    }
    return storedTerminalOutput("output", runtime)
  }

  private async terminalStop(input: BashToolInput, context: ToolExecutorContext): Promise<BashToolOutput> {
    const runtime = this.resolveTerminal(input, context)
    if (isRuntimeTerminal(runtime)) {
      const output = await this.supervisor.stop(runtime.terminalId, runtime.processId, { ...input, operation: "stop", processId: runtime.processId })
      this.appendOutputSnapshot(runtime.terminalId, context, output)
      this.markRuntimeTerminalStopped(runtime)
      const terminal = this.store.listConversationTerminals(context.conversationId).find((item) => item.terminalId === runtime.terminalId)
      return terminal ? storedTerminalOutput("stop", terminal) : withTerminalMetadata(output, terminal)
    }
    this.store.updateTerminal(runtime.terminalId, { status: "stopped", awaitingInput: false, signal: "SIGTERM", completedAt: nowIso() })
    return storedTerminalOutput("stop", { ...runtime, status: "stopped" })
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

  private handleRuntimeOutput(terminalId: string, context: ToolExecutorContext | undefined, chunk: { stream: "stdout" | "stderr" | "log"; text: string }): void {
    const sequence = this.store.appendTerminalOutput({ terminalId, stream: chunk.stream, text: chunk.text })
    context?.onOutput?.(chunk)
    const runtime = this.terminals.get(terminalId)
    const conversationId = context?.conversationId ?? runtime?.conversationId
    const terminal = conversationId ? this.store.listConversationTerminals(conversationId).find((item) => item.terminalId === terminalId) : undefined
    if (terminal) {
      this.emitTerminalEvent("terminal.output", terminal, { stream: chunk.stream, text: chunk.text, sequence })
    }
    const prompt = detectPrompt(chunk.text)
    if (prompt && runtime && !runtime.awaitingInput) {
      runtime.awaitingInput = true
      runtime.status = "awaiting_input"
      this.store.updateTerminal(terminalId, { status: "awaiting_input", awaitingInput: true, lastPrompt: prompt })
      const prompted = conversationId ? this.store.listConversationTerminals(conversationId).find((item) => item.terminalId === terminalId) : undefined
      if (prompted) {
        this.emitTerminalEvent("terminal.input.requested", prompted, { prompt, secret: isSecretPrompt(prompt) })
      }
    }
  }

  private startPolling(terminal: RuntimeTerminal): void {
    terminal.pollTimer = setInterval(() => {
      void this.pollTerminal(terminal).catch((error) => this.markRuntimeTerminalMissing(terminal, error))
    }, 500)
    terminal.pollTimer.unref?.()
    setTimeout(() => {
      if (this.terminals.get(terminal.terminalId) === terminal) {
        void this.pollTerminal(terminal).catch((error) => this.markRuntimeTerminalMissing(terminal, error))
      }
    }, 100).unref?.()
    setTimeout(() => {
      if (this.terminals.get(terminal.terminalId) === terminal && terminal.status === "running") {
        this.stopRuntimeTerminal(terminal, "Terminal idle TTL expired.")
      }
    }, this.idleTtlMs).unref?.()
  }

  private async pollTerminal(terminal: RuntimeTerminal): Promise<void> {
    await this.drainRuntimeTerminal(terminal, undefined)
  }

  private async drainRuntimeTerminal(terminal: RuntimeTerminal, context: ToolExecutorContext | undefined): Promise<BashToolOutput> {
    const output = await this.supervisor.output(terminal.terminalId, terminal.processId, {
      operation: "output",
      processId: terminal.processId,
      outputSequence: terminal.supervisorOutputSequence,
    })
    this.appendOutputSnapshot(terminal.terminalId, context, output)
    this.updateFromOutput(terminal, output)
    return output
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
    } else {
      this.emitTerminalStatus(terminal)
    }
  }

  private async stopRuntimeTerminal(terminal: RuntimeTerminal, reason?: string): Promise<void> {
    const output = await this.supervisor.stop(terminal.terminalId, terminal.processId).catch(() => undefined)
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
    }
  }

  private appendOutputSnapshot(terminalId: string, context: ToolExecutorContext | undefined, output: BashToolOutput): void {
    if (output.stdout) {
      this.handleRuntimeOutput(terminalId, context, { stream: "stdout", text: output.stdout })
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
    type: "terminal.started" | "terminal.output" | "terminal.status" | "terminal.input.requested" | "terminal.completed" | "terminal.stopped" | "terminal.stale",
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
    for (const socket of this.sockets) {
      if (socket.readyState === 1) {
        sendEvent(socket, event)
      }
    }
  }
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
  operation: "start" | "status" | "output" | "stop",
  terminal: ReturnType<typeof storedTerminalFromRow>,
  options: { message?: string; reusedTerminal?: boolean; autoDetached?: boolean } = {},
): BashToolOutput => ({
  operation,
  command: terminal.command,
  cwd: terminal.cwd,
  exitCode: terminal.exitCode ?? null,
  ...(terminal.signal ? { signal: terminal.signal } : {}),
  stdout: terminal.output.stdout,
  stderr: terminal.output.stderr,
  ...(options.message ? { message: options.message } : {}),
  ...(options.reusedTerminal !== undefined ? { reusedTerminal: options.reusedTerminal } : {}),
  durationMs: 0,
  timedOut: false,
  truncation: {
    truncated: false,
    charLimit: 80_000,
    originalLength: terminal.output.stdout.length + terminal.output.stderr.length,
    returnedLength: terminal.output.stdout.length + terminal.output.stderr.length,
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
})

const isActiveTerminalStatus = (status: TerminalStatus): boolean => status === "running" || status === "awaiting_input"

const isRuntimeTerminal = (terminal: RuntimeTerminal | ReturnType<typeof storedTerminalFromRow>): terminal is RuntimeTerminal => !("output" in terminal)

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

const shouldAutoDetachRun = (command: string): boolean =>
  /\b(pnpm|npm|yarn|bun)\s+(dev|start|serve)\b|\b(next|vite|astro|webpack|turbo)\s+dev\b|\b(uvicorn|fastapi|flask|django-admin)\b|\b(npx|pnpm\s+dlx|yarn\s+dlx|bunx)\b/i.test(
    command,
  )

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

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
