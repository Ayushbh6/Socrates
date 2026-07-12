import type { RuntimeConfig, TerminalWaitWakeOn, TurnEvidenceToolInput, TurnEvidenceToolOutput, WaitToolInput } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, eq, inArray } from "drizzle-orm"
import { agentTaskTurns, agentTaskWaits, agentTasks, sessions, taskEvidenceReferences, terminalSessions, turns } from "../../db/schema"
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
  startTask(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    runtimeConfig: RuntimeConfig
  }): string {
    const existing = this.taskForTurn(input.turnId)
    if (existing) return existing.id
    const now = nowIso()
    const taskId = createId("task")
    this.handle.sqlite.transaction(() => {
      this.handle.db.insert(agentTasks).values({
        id: taskId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        rootTurnId: input.turnId,
        currentTurnId: input.turnId,
        status: "running",
        runtimeConfigJson: JSON.stringify(input.runtimeConfig),
        createdAt: now,
        updatedAt: now,
        metadataJson: JSON.stringify({ lifecycle: "user_request" }),
      }).run()
      this.handle.db.insert(agentTaskTurns).values({ id: createId("tturn"), taskId, turnId: input.turnId, ordinal: 0, kind: "root", createdAt: now }).run()
    })()
    return taskId
  }

  evidenceForTurn(turnId: string, input: TurnEvidenceToolInput): TurnEvidenceToolOutput {
    const task = this.taskForTurn(turnId)
    if (!task) throw new SocratesError("task_evidence_unavailable", "No task lifecycle is registered for this turn.", { recoverable: true })
    const turnRows = this.handle.db.select({ turnId: agentTaskTurns.turnId }).from(agentTaskTurns).where(eq(agentTaskTurns.taskId, task.id)).all()
    const turnIds = turnRows.map((row) => row.turnId)
    const placeholders = turnIds.map(() => "?").join(",")
    const query = <T>(sql: string, ...params: unknown[]): T[] => this.handle.sqlite.prepare(sql).all(...params) as T[]
    const references: TurnEvidenceToolOutput["references"] = []
    const makeReference = (kind: string, label: string, selector: Record<string, unknown>): string => {
      const selectorJson = JSON.stringify(selector)
      const existing = this.handle.db.select({ id: taskEvidenceReferences.id }).from(taskEvidenceReferences)
        .where(and(eq(taskEvidenceReferences.taskId, task.id), eq(taskEvidenceReferences.kind, kind), eq(taskEvidenceReferences.selectorJson, selectorJson))).limit(1).get()
      const id = existing?.id ?? createId("evd")
      if (!existing) this.handle.db.insert(taskEvidenceReferences).values({ id, taskId: task.id, kind, selectorJson, createdAt: nowIso() }).run()
      references.push({ id, kind, label: label.slice(0, 160) })
      return id
    }
    let payload: unknown
    if (input.operation === "inspect") {
      const ref = this.handle.db.select().from(taskEvidenceReferences)
        .where(and(eq(taskEvidenceReferences.id, input.reference as string), eq(taskEvidenceReferences.taskId, task.id))).limit(1).get()
      if (!ref) throw new SocratesError("task_evidence_reference_invalid", "That evidence reference does not belong to the current task.", { recoverable: true })
      const selector = JSON.parse(ref.selectorJson) as { table?: string; ids?: string[] }
      const allowed: Record<string, string> = {
        tool_calls: `SELECT id, turn_id, tool_name, status, arguments_json, result_json, error_id, started_at, completed_at FROM tool_calls WHERE turn_id IN (${placeholders}) ORDER BY COALESCE(started_at, completed_at) ASC LIMIT ?`,
        file_operations: `SELECT id, turn_id, operation, path, old_path, status, error_id, completed_at FROM file_operations WHERE turn_id IN (${placeholders}) ORDER BY started_at ASC LIMIT ?`,
        shell_commands: `SELECT id, turn_id, command, cwd, status, exit_code, duration_ms, metadata_json FROM shell_commands WHERE turn_id IN (${placeholders}) ORDER BY started_at ASC LIMIT ?`,
        waits: `SELECT w.id, w.terminal_id, w.wake_on_json, w.reason, w.status, w.wake_event, w.created_at, w.woken_at FROM agent_task_waits w WHERE w.task_id = ? ORDER BY w.created_at ASC LIMIT ?`,
      }
      if (selector.table === "terminal_sessions" && selector.ids?.length) {
        const ids = selector.ids.slice(0, 20)
        payload = query(`SELECT id, name, command, cwd, status, exit_code, awaiting_input, last_prompt, started_at, completed_at FROM terminal_sessions WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY started_at ASC LIMIT ?`, ...ids, input.limit)
        references.push({ id: ref.id, kind: ref.kind, label: `Inspected ${ref.kind}` })
        const raw = JSON.stringify(payload, null, 2)
        const content = raw.slice(0, input.charLimit)
        return { operation: input.operation, taskId: task.id, rootTurnId: task.rootTurnId, status: task.status, resumedCount: Math.max(0, turnIds.length - 1), content, references, truncation: { truncated: raw.length > input.charLimit, charLimit: input.charLimit, originalLength: raw.length, returnedLength: content.length } }
      }
      const sql = selector.table ? allowed[selector.table] : undefined
      if (!sql) throw new SocratesError("task_evidence_reference_invalid", "That evidence reference cannot be inspected.", { recoverable: true })
      payload = selector.table === "waits" ? query(sql, task.id, input.limit) : query(sql, ...turnIds, input.limit)
      references.push({ id: ref.id, kind: ref.kind, label: `Inspected ${ref.kind}` })
    } else {
      const user = query<{ content: string }>(`SELECT content FROM messages WHERE turn_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1`, task.rootTurnId)[0]
      const tools = query<{ tool_name: string; status: string; total: number }>(
        `SELECT tool_name, status, COUNT(*) AS total FROM tool_calls WHERE turn_id IN (${placeholders}) GROUP BY tool_name, status ORDER BY total DESC LIMIT 30`, ...turnIds,
      )
      const failures = query<{ tool_name: string; error_id: string | null; total: number }>(
        `SELECT tool_name, error_id, COUNT(*) AS total FROM tool_calls WHERE turn_id IN (${placeholders}) AND status = 'failed' GROUP BY tool_name, error_id ORDER BY total DESC LIMIT 10`, ...turnIds,
      )
      const files = query<{ path: string; operation: string; status: string }>(
        `SELECT path, operation, status FROM file_operations WHERE turn_id IN (${placeholders}) ORDER BY started_at ASC LIMIT 40`, ...turnIds,
      )
      const commands = query<{ command: string; status: string; exit_code: number | null; metadata_json: string | null }>(
        `SELECT command, status, exit_code, metadata_json FROM shell_commands WHERE turn_id IN (${placeholders}) ORDER BY started_at ASC LIMIT 20`, ...turnIds,
      )
      const waits = query<{ reason: string; status: string; wake_event: string | null }>(
        `SELECT reason, status, wake_event FROM agent_task_waits WHERE task_id = ? ORDER BY created_at ASC LIMIT 20`, task.id,
      )
      if (tools.length) makeReference("tool_calls", "Task tool calls and results", { table: "tool_calls" })
      if (files.length) makeReference("changed_files", "Task file operations", { table: "file_operations" })
      if (commands.length) makeReference("shell_commands", "Task shell commands", { table: "shell_commands" })
      if (waits.length) makeReference("waits", "Task waits and wake events", { table: "waits" })
      const terminalIds = [...new Set(commands.flatMap((row) => {
        const metadata = parseRecord(row.metadata_json)
        return typeof metadata?.terminalId === "string" ? [metadata.terminalId] : []
      }))]
      const terminals = terminalIds.length
        ? query<{ id: string; name: string; status: string; exit_code: number | null; awaiting_input: number }>(
            `SELECT id, name, status, exit_code, awaiting_input FROM terminal_sessions WHERE id IN (${terminalIds.map(() => "?").join(",")}) ORDER BY started_at ASC`, ...terminalIds,
          )
        : []
      if (terminals.length) makeReference("terminals", "Task Terminal final states", { table: "terminal_sessions", ids: terminalIds })
      payload = {
        userRequest: (user?.content ?? "").slice(0, 2_000),
        turns: turnIds.length,
        tools,
        failures,
        files,
        commands: commands.map((row) => ({ command: row.command.slice(0, 500), status: row.status, exitCode: row.exit_code })),
        terminals,
        waits,
      }
    }
    const raw = JSON.stringify(payload, null, 2)
    const content = raw.slice(0, input.charLimit)
    return {
      operation: input.operation,
      taskId: task.id,
      rootTurnId: task.rootTurnId,
      status: task.status,
      resumedCount: Math.max(0, turnIds.length - 1),
      content,
      references: references.slice(0, 20),
      truncation: { truncated: raw.length > input.charLimit, charLimit: input.charLimit, originalLength: raw.length, returnedLength: content.length },
    }
  }

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
      const ordinal = this.handle.db.select({ id: agentTaskTurns.id }).from(agentTaskTurns).where(eq(agentTaskTurns.taskId, task.taskId)).all().length
      this.handle.db.insert(agentTaskTurns).values({ id: createId("tturn"), taskId: task.taskId, turnId, ordinal, kind: "resume", createdAt: now }).run()
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

  private taskForTurn(turnId: string): typeof agentTasks.$inferSelect | undefined {
    return this.handle.db.select().from(agentTasks).innerJoin(agentTaskTurns, eq(agentTasks.id, agentTaskTurns.taskId))
      .where(eq(agentTaskTurns.turnId, turnId)).limit(1).get()?.agent_tasks
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
