import type { RuntimeConfig, TerminalWaitWakeOn, WaitToolInput } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, eq, inArray } from "drizzle-orm"
import { agentTaskWaits, agentTasks, sessions, terminalSessions, turns } from "../../db/schema"
import { StoreBase } from "./shared"

type TerminalWakeEvent = TerminalWaitWakeOn

type WaitTerminal = {
  id: string
  name: string
  status: string
  exitCode: number | null
}

export type ReadyTerminalTask = {
  taskId: string
  terminalId: string
  projectId: string
  conversationId: string
  sessionId: string
  rootTurnId: string
  currentTurnId: string
  runtimeConfig: RuntimeConfig
  reason: string
  terminalName: string
  terminalStatus: string
  exitCode: number | null
  wakeEvent: TerminalWakeEvent
}

export type ContinuedTerminalTask = ReadyTerminalTask & {
  turnId: string
  runtimeConfigId: string
}

export class AgentTaskStore extends StoreBase {
  registerTerminalWait(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    runtimeConfig: RuntimeConfig
    wait: WaitToolInput
  }): { status: "waiting" | "already_ready"; message: string } {
    const terminals = this.resolveNamedTerminals(input.conversationId, input.wait.terminalNames)
    const ready = terminals.find((terminal) => {
      const event = wakeEventForTerminal(terminal)
      return event && input.wait.wakeOn.includes(event)
    })
    if (ready) {
      return {
        status: "already_ready",
        message: `Terminal "${ready.name}" already has a requested event; continue now.`,
      }
    }

    const now = nowIso()
    const existingTask = this.handle.db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(and(eq(agentTasks.currentTurnId, input.turnId), inArray(agentTasks.status, ["running", "ready"])))
      .limit(1)
      .get()
    const taskId = existingTask?.id ?? createId("task")
    const write = this.handle.sqlite.transaction(() => {
      if (existingTask) {
        this.handle.db
          .update(agentTasks)
          .set({ status: "waiting", updatedAt: now, metadataJson: JSON.stringify({ reason: input.wait.reason }) })
          .where(eq(agentTasks.id, taskId))
          .run()
      } else {
        this.handle.db
          .insert(agentTasks)
          .values({
            id: taskId,
            projectId: input.projectId,
            conversationId: input.conversationId,
            sessionId: input.sessionId,
            rootTurnId: input.turnId,
            currentTurnId: input.turnId,
            status: "waiting",
            runtimeConfigJson: JSON.stringify(input.runtimeConfig),
            createdAt: now,
            updatedAt: now,
            metadataJson: JSON.stringify({ reason: input.wait.reason }),
          })
          .run()
      }
      for (const terminal of terminals) {
        this.handle.db
          .insert(agentTaskWaits)
          .values({
            id: createId("twait"),
            taskId,
            terminalId: terminal.id,
            wakeOnJson: JSON.stringify(input.wait.wakeOn),
            reason: input.wait.reason,
            status: "waiting",
            createdAt: now,
          })
          .run()
      }
      this.handle.db.update(turns).set({ status: "waiting", metadataJson: JSON.stringify({ terminalTaskId: taskId }) }).where(eq(turns.id, input.turnId)).run()
      this.handle.db.update(sessions).set({ status: "idle", updatedAt: now }).where(eq(sessions.id, input.sessionId)).run()
    })
    write()

    // Recheck after persistence so completion between the first check and registration cannot strand the task.
    const raced = this.resolveNamedTerminals(input.conversationId, input.wait.terminalNames).find((terminal) => {
      const event = wakeEventForTerminal(terminal)
      return event && input.wait.wakeOn.includes(event)
    })
    if (raced) {
      this.claimWakeForTerminal(raced.id, wakeEventForTerminal(raced) as TerminalWakeEvent)
      return { status: "already_ready", message: `Terminal "${raced.name}" completed during wait registration; continue now.` }
    }
    return { status: "waiting", message: `Task suspended until a requested Terminal event occurs.` }
  }

  claimWakeForTerminal(terminalId: string, wakeEvent: TerminalWakeEvent): ReadyTerminalTask[] {
    const waitRows = this.handle.db
      .select({
        waitId: agentTaskWaits.id,
        wakeOnJson: agentTaskWaits.wakeOnJson,
        reason: agentTaskWaits.reason,
        taskId: agentTasks.id,
        projectId: agentTasks.projectId,
        conversationId: agentTasks.conversationId,
        sessionId: agentTasks.sessionId,
        rootTurnId: agentTasks.rootTurnId,
        currentTurnId: agentTasks.currentTurnId,
        runtimeConfigJson: agentTasks.runtimeConfigJson,
        status: agentTasks.status,
      })
      .from(agentTaskWaits)
      .innerJoin(agentTasks, eq(agentTaskWaits.taskId, agentTasks.id))
      .where(and(eq(agentTaskWaits.terminalId, terminalId), eq(agentTaskWaits.status, "waiting"), eq(agentTasks.status, "waiting")))
      .all()
    if (waitRows.length === 0) return []

    const terminal = this.handle.db.select().from(terminalSessions).where(eq(terminalSessions.id, terminalId)).get()
    if (!terminal) return []
    const now = nowIso()
    const ready: ReadyTerminalTask[] = []
    const claim = this.handle.sqlite.transaction(() => {
      for (const wait of waitRows) {
        const wakeOn = parseWakeOn(wait.wakeOnJson)
        if (!wakeOn.includes(wakeEvent)) continue
        const changed = this.handle.db
          .update(agentTasks)
          .set({ status: "ready", updatedAt: now, metadataJson: JSON.stringify({ reason: wait.reason, wakeEvent, terminalId }) })
          .where(and(eq(agentTasks.id, wait.taskId), eq(agentTasks.status, "waiting")))
          .run().changes
        if (changed === 0) continue
        this.handle.db
          .update(turns)
          .set({ status: "suspended", completedAt: now, metadataJson: JSON.stringify({ terminalTaskId: wait.taskId, wakeEvent }) })
          .where(eq(turns.id, wait.currentTurnId))
          .run()
        this.handle.db
          .update(agentTaskWaits)
          .set({ status: "woken", wokenAt: now, wakeEvent })
          .where(and(eq(agentTaskWaits.taskId, wait.taskId), eq(agentTaskWaits.status, "waiting")))
          .run()
        ready.push({
          taskId: wait.taskId,
          terminalId,
          projectId: wait.projectId,
          conversationId: wait.conversationId,
          sessionId: wait.sessionId,
          rootTurnId: wait.rootTurnId,
          currentTurnId: wait.currentTurnId,
          runtimeConfig: parseRuntimeConfig(wait.runtimeConfigJson),
          reason: wait.reason,
          terminalName: terminal.name,
          terminalStatus: terminal.status,
          exitCode: terminal.exitCode,
          wakeEvent,
        })
      }
    })
    claim()
    return ready
  }

  beginContinuation(task: ReadyTerminalTask): ContinuedTerminalTask | undefined {
    const now = nowIso()
    const turnId = createId("turn")
    const runtimeConfigId = createId("trc")
    const started = this.handle.sqlite.transaction(() => {
      const changed = this.handle.db
        .update(agentTasks)
        .set({ status: "running", currentTurnId: turnId, updatedAt: now })
        .where(and(eq(agentTasks.id, task.taskId), eq(agentTasks.status, "ready")))
        .run().changes
      if (changed === 0) return false
      this.handle.db.insert(turns).values({ id: turnId, sessionId: task.sessionId, conversationId: task.conversationId, status: "running", startedAt: now }).run()
      this.insertRuntimeConfigWithId(runtimeConfigId, turnId, task.runtimeConfig, now)
      this.handle.db.update(sessions).set({ status: "active", updatedAt: now }).where(eq(sessions.id, task.sessionId)).run()
      return true
    })()
    return started ? { ...task, turnId, runtimeConfigId } : undefined
  }

  listReadyTasks(): ReadyTerminalTask[] {
    const rows = this.handle.db
      .select({
        taskId: agentTasks.id,
        projectId: agentTasks.projectId,
        conversationId: agentTasks.conversationId,
        sessionId: agentTasks.sessionId,
        rootTurnId: agentTasks.rootTurnId,
        currentTurnId: agentTasks.currentTurnId,
        runtimeConfigJson: agentTasks.runtimeConfigJson,
        metadataJson: agentTasks.metadataJson,
      })
      .from(agentTasks)
      .where(eq(agentTasks.status, "ready"))
      .all()
    return rows.flatMap((task) => {
      const metadata = parseRecord(task.metadataJson)
      const terminalId = typeof metadata?.terminalId === "string" ? metadata.terminalId : undefined
      const wakeEvent = metadata?.wakeEvent
      if (!terminalId || (wakeEvent !== "completed" && wakeEvent !== "failed" && wakeEvent !== "input_required")) return []
      const terminal = this.handle.db.select().from(terminalSessions).where(eq(terminalSessions.id, terminalId)).get()
      if (!terminal) return []
      return [
        {
          taskId: task.taskId,
          terminalId,
          projectId: task.projectId,
          conversationId: task.conversationId,
          sessionId: task.sessionId,
          rootTurnId: task.rootTurnId,
          currentTurnId: task.currentTurnId,
          runtimeConfig: parseRuntimeConfig(task.runtimeConfigJson),
          reason: typeof metadata?.reason === "string" ? metadata.reason : "Terminal event ready",
          terminalName: terminal.name,
          terminalStatus: terminal.status,
          exitCode: terminal.exitCode,
          wakeEvent,
        },
      ]
    })
  }

  requeueInterruptedContinuations(): number {
    const now = nowIso()
    const rows = this.handle.db
      .select({ taskId: agentTasks.id, currentTurnId: agentTasks.currentTurnId, turnStatus: turns.status })
      .from(agentTasks)
      .innerJoin(turns, eq(agentTasks.currentTurnId, turns.id))
      .where(eq(agentTasks.status, "running"))
      .all()
    let requeued = 0
    this.handle.sqlite.transaction(() => {
      for (const row of rows) {
        if (row.turnStatus === "completed" || row.turnStatus === "failed") {
          this.handle.db
            .update(agentTasks)
            .set({ status: row.turnStatus, completedAt: now, updatedAt: now })
            .where(and(eq(agentTasks.id, row.taskId), eq(agentTasks.status, "running"), eq(agentTasks.currentTurnId, row.currentTurnId)))
            .run()
          continue
        }
        if (row.turnStatus !== "cancelled") continue
        requeued += this.handle.db
          .update(agentTasks)
          .set({ status: "ready", updatedAt: now })
          .where(and(eq(agentTasks.id, row.taskId), eq(agentTasks.status, "running"), eq(agentTasks.currentTurnId, row.currentTurnId)))
          .run().changes
      }
    })()
    return requeued
  }

  completeTaskForTurn(turnId: string, status: "completed" | "failed" | "cancelled"): void {
    const now = nowIso()
    this.handle.db
      .update(agentTasks)
      .set({ status, completedAt: now, updatedAt: now })
      .where(and(eq(agentTasks.currentTurnId, turnId), inArray(agentTasks.status, ["waiting", "running", "ready"])))
      .run()
  }

  hasWaitingTerminalTask(terminalId: string): boolean {
    const row = this.handle.db
      .select({ id: agentTaskWaits.id })
      .from(agentTaskWaits)
      .innerJoin(agentTasks, eq(agentTaskWaits.taskId, agentTasks.id))
      .where(and(eq(agentTaskWaits.terminalId, terminalId), eq(agentTaskWaits.status, "waiting"), eq(agentTasks.status, "waiting")))
      .limit(1)
      .get()
    return Boolean(row)
  }

  private resolveNamedTerminals(conversationId: string, names: string[]): WaitTerminal[] {
    const rows = this.handle.db
      .select({ id: terminalSessions.id, name: terminalSessions.name, status: terminalSessions.status, exitCode: terminalSessions.exitCode })
      .from(terminalSessions)
      .where(and(eq(terminalSessions.conversationId, conversationId), inArray(terminalSessions.name, names)))
      .all()
    const resolved: WaitTerminal[] = []
    for (const name of names) {
      const matching = rows.filter((row) => row.name === name)
      if (matching.length !== 1) {
        throw new SocratesError(
          matching.length === 0 ? "terminal_not_found" : "terminal_ambiguous",
          matching.length === 0 ? `No Terminal named "${name}" is available.` : `Terminal name "${name}" is ambiguous. Use Terminal list and a unique name.`,
          { recoverable: true },
        )
      }
      const terminal = matching[0]
      if (!terminal || !["running", "awaiting_input", "exited", "stopped", "detached", "missing"].includes(terminal.status)) {
        throw new SocratesError("terminal_wait_invalid_state", `Terminal "${name}" cannot be waited on in its current state.`, { recoverable: true })
      }
      resolved.push(terminal)
    }
    return resolved
  }

  private insertRuntimeConfigWithId(id: string, turnId: string, runtimeConfig: RuntimeConfig, createdAt: string): void {
    this.handle.sqlite
      .prepare(
        `INSERT INTO turn_runtime_configs (id, turn_id, provider_id, auth_mode, model_id, thinking_enabled, thinking_effort, approval_mode, sandbox_mode, temperature, max_output_tokens, context_window_tokens, tool_policy_json, provider_options_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        turnId,
        runtimeConfig.providerId,
        runtimeConfig.authMode ?? "api_key",
        runtimeConfig.modelId,
        runtimeConfig.thinkingEnabled ? 1 : 0,
        runtimeConfig.thinkingEffort ?? null,
        runtimeConfig.approvalMode,
        runtimeConfig.sandboxMode,
        null,
        null,
        null,
        null,
        null,
        createdAt,
      )
  }
}

const wakeEventForTerminal = (terminal: WaitTerminal): TerminalWakeEvent | undefined => {
  if (terminal.status === "awaiting_input") return "input_required"
  if (terminal.status === "exited") return terminal.exitCode === 0 ? "completed" : "failed"
  if (["stopped", "detached", "missing"].includes(terminal.status)) return "failed"
  return undefined
}

const parseWakeOn = (value: string): TerminalWakeEvent[] => {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is TerminalWakeEvent => item === "completed" || item === "failed" || item === "input_required") : []
  } catch {
    return []
  }
}

const parseRuntimeConfig = (value: string): RuntimeConfig => JSON.parse(value) as RuntimeConfig

const parseRecord = (value: string | null): Record<string, unknown> | undefined => {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
