import type { ConversationToolRun, ToolName } from "@socrates/contracts"
import { createId, nowIso } from "@socrates/shared"
import { and, eq, inArray } from "drizzle-orm"
import { approvals, fileOperations, patches, shellCommands, shellOutputChunks, toolCalls } from "../../db/schema"
import { StoreBase } from "./shared"

export class ToolStore extends StoreBase {
  createToolCall(input: {
    toolCallId: string
    conversationId: string
    sessionId: string
    turnId: string
    modelCallId?: string
    toolName: string
    arguments: unknown
    requiresApproval: boolean
  }): void {
    const pendingApproval = input.requiresApproval
      ? this.handle.db.select().from(approvals).where(eq(approvals.toolCallId, input.toolCallId)).get()
      : undefined
    this.handle.db
      .insert(toolCalls)
      .values({
        id: input.toolCallId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        modelCallId: input.modelCallId,
        toolName: input.toolName,
        status: input.requiresApproval ? "awaiting_approval" : "running",
        argumentsJson: JSON.stringify(input.arguments),
        requiresApproval: input.requiresApproval,
        approvalId: pendingApproval?.id,
        startedAt: nowIso(),
      })
      .run()
  }

  attachApproval(toolCallId: string, approvalId: string): void {
    this.handle.db
      .update(toolCalls)
      .set({ approvalId, status: "awaiting_approval" })
      .where(eq(toolCalls.id, toolCallId))
      .run()
  }

  markToolRunning(toolCallId: string): void {
    this.handle.db.update(toolCalls).set({ status: "running" }).where(eq(toolCalls.id, toolCallId)).run()
  }

  markToolRunningByApproval(approvalId: string): void {
    this.handle.db.update(toolCalls).set({ status: "running" }).where(eq(toolCalls.approvalId, approvalId)).run()
  }

  completeToolCall(toolCallId: string, result: unknown): void {
    this.handle.db
      .update(toolCalls)
      .set({ status: "completed", resultJson: JSON.stringify(result), completedAt: nowIso() })
      .where(eq(toolCalls.id, toolCallId))
      .run()
  }

  failToolCall(toolCallId: string, errorId?: string, rejected = false): void {
    this.handle.db
      .update(toolCalls)
      .set({ status: rejected ? "rejected" : "failed", errorId, completedAt: nowIso() })
      .where(eq(toolCalls.id, toolCallId))
      .run()
  }

  cancelOpenToolCallsForTurn(turnId: string): void {
    const now = nowIso()
    this.handle.db
      .update(toolCalls)
      .set({ status: "cancelled", completedAt: now })
      .where(and(eq(toolCalls.turnId, turnId), inArray(toolCalls.status, ["running", "awaiting_approval"])))
      .run()
  }

  createShellCommand(input: {
    toolCallId: string
    conversationId: string
    sessionId: string
    turnId: string
    command: string
    cwd: string
  }): string {
    const id = createId("sh")
    this.handle.db
      .insert(shellCommands)
      .values({
        id,
        toolCallId: input.toolCallId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        command: input.command,
        cwd: input.cwd,
        status: "running",
        startedAt: nowIso(),
      })
      .run()
    return id
  }

  appendShellOutput(toolCallId: string, stream: "stdout" | "stderr" | "log" | "result", text: string): void {
    const command = this.handle.db.select().from(shellCommands).where(eq(shellCommands.toolCallId, toolCallId)).get()
    if (!command) {
      return
    }
    const row = this.handle.sqlite
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM shell_output_chunks WHERE shell_command_id = ?")
      .get(command.id) as { next_sequence: number }
    this.handle.db
      .insert(shellOutputChunks)
      .values({
        id: createId("shout"),
        shellCommandId: command.id,
        sequence: row.next_sequence,
        stream,
        text,
        createdAt: nowIso(),
      })
      .run()
  }

  completeShellCommand(toolCallId: string, input: { exitCode: number | null; signal?: string | null; durationMs: number; cwd?: string }): void {
    this.handle.db
      .update(shellCommands)
      .set({
        status: "completed",
        exitCode: input.exitCode,
        signal: input.signal,
        durationMs: input.durationMs,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        completedAt: nowIso(),
      })
      .where(eq(shellCommands.toolCallId, toolCallId))
      .run()
  }

  failShellCommand(toolCallId: string): void {
    this.handle.db
      .update(shellCommands)
      .set({
        status: "failed",
        completedAt: nowIso(),
      })
      .where(eq(shellCommands.toolCallId, toolCallId))
      .run()
  }

  cancelOpenShellCommandsForTurn(turnId: string): void {
    this.handle.db
      .update(shellCommands)
      .set({
        status: "cancelled",
        signal: "SIGTERM",
        completedAt: nowIso(),
      })
      .where(and(eq(shellCommands.turnId, turnId), eq(shellCommands.status, "running")))
      .run()
  }

  recordFileOperations(input: {
    conversationId: string
    sessionId: string
    turnId: string
    toolCallId: string
    files: Array<{ path: string; operation: string }>
  }): void {
    const now = nowIso()
    for (const file of input.files) {
      this.handle.db
        .insert(fileOperations)
        .values({
          id: createId("fop"),
          toolCallId: input.toolCallId,
          conversationId: input.conversationId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          operation: file.operation,
          path: file.path,
          status: "completed",
          startedAt: now,
          completedAt: now,
        })
        .run()
    }
  }

  recordPatch(input: {
    conversationId: string
    sessionId: string
    turnId: string
    toolCallId: string
    diff: string
    files: Array<{ path: string; operation: string }>
  }): void {
    this.handle.db
      .insert(patches)
      .values({
        id: createId("patch"),
        toolCallId: input.toolCallId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: "applied",
        diffText: input.diff,
        filesJson: JSON.stringify(input.files),
        createdAt: nowIso(),
        appliedAt: nowIso(),
      })
      .run()
  }

  getConversationToolRuns(conversationId: string): ConversationToolRun[] {
    const toolRows = this.handle.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.conversationId, conversationId))
      .orderBy(toolCalls.startedAt)
      .all()

    if (toolRows.length === 0) {
      return []
    }

    const toolCallIds = toolRows.map((row) => row.id)
    const approvalRows = this.handle.db.select().from(approvals).where(inArray(approvals.toolCallId, toolCallIds)).all()
    const shellRows = this.handle.db.select().from(shellCommands).where(inArray(shellCommands.toolCallId, toolCallIds)).all()
    const shellCommandIds = shellRows.map((row) => row.id)
    const shellOutputRows =
      shellCommandIds.length > 0
        ? this.handle.db
            .select()
            .from(shellOutputChunks)
            .where(inArray(shellOutputChunks.shellCommandId, shellCommandIds))
            .orderBy(shellOutputChunks.sequence)
            .all()
        : []
    const fileRows = this.handle.db.select().from(fileOperations).where(inArray(fileOperations.toolCallId, toolCallIds)).all()
    const patchRows = this.handle.db.select().from(patches).where(inArray(patches.toolCallId, toolCallIds)).all()

    return toolRows.map((tool) => {
      const approval = approvalRows.find((row) => row.toolCallId === tool.id)
      const shell = shellRows.find((row) => row.toolCallId === tool.id)
      const chunks = shell ? shellOutputRows.filter((row) => row.shellCommandId === shell.id) : []
      const stdout = chunks.filter((row) => row.stream === "stdout").map((row) => row.text).join("")
      const stderr = chunks.filter((row) => row.stream === "stderr").map((row) => row.text).join("")
      const log = chunks.filter((row) => row.stream !== "stdout" && row.stream !== "stderr").map((row) => row.text).join("")
      const files = fileRows
        .filter((row) => row.toolCallId === tool.id)
        .map((row) => ({ path: row.path, operation: row.operation, status: row.status }))
      const patch = patchRows.find((row) => row.toolCallId === tool.id)
      const result = parseJson(tool.resultJson)
      const durationMs =
        shell?.durationMs ??
        (tool.startedAt && tool.completedAt ? Math.max(Date.parse(tool.completedAt) - Date.parse(tool.startedAt), 0) : undefined)

      return {
        toolCallId: tool.id,
        conversationId: tool.conversationId,
        sessionId: tool.sessionId,
        turnId: tool.turnId,
        toolName: tool.toolName as ToolName,
        status: normalizeToolStatus(tool.status),
        requiresApproval: tool.requiresApproval,
        arguments: parseJson(tool.argumentsJson),
        ...(result === undefined ? {} : { result }),
        ...(tool.errorId ? { errorId: tool.errorId } : {}),
        ...(approval ? { approval: mapApproval(approval) } : {}),
        summary: summarizeStoredToolRun(tool.toolName, result, shell),
        resultPreview: previewStoredToolResult(tool.toolName, result, stdout, stderr),
        ...(tool.startedAt ? { startedAt: tool.startedAt } : {}),
        ...(tool.completedAt ? { completedAt: tool.completedAt } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(shell
          ? {
              shell: {
                command: shell.command,
                cwd: shell.cwd,
                status: shell.status,
                exitCode: shell.exitCode,
                signal: shell.signal,
                ...(shell.durationMs === null ? {} : { durationMs: shell.durationMs }),
                stdout: truncatePreview(stdout, 20_000),
                stderr: truncatePreview(stderr, 20_000),
                ...(log ? { log: truncatePreview(log, 10_000) } : {}),
              },
            }
          : {}),
        ...(files.length > 0 ? { fileOperations: files } : {}),
        ...(patch
          ? {
              patch: {
                status: patch.status,
                diff: truncatePreview(patch.diffText, 20_000),
                files: parseJson(patch.filesJson),
              },
            }
          : {}),
      }
    })
  }
}

const parseJson = (text: string | null): unknown => {
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const normalizeToolStatus = (status: string): ConversationToolRun["status"] => {
  if (["running", "awaiting_approval", "completed", "failed", "rejected", "cancelled"].includes(status)) {
    return status as ConversationToolRun["status"]
  }
  return "failed"
}

const mapApproval = (row: typeof approvals.$inferSelect): ConversationToolRun["approval"] => ({
  approvalId: row.id,
  status: row.status === "approved" || row.status === "rejected" ? row.status : "pending",
  actionKind: normalizeActionKind(row.actionKind),
  title: parseApprovalAction(row.actionJson).title ?? "Approval request",
  description: parseApprovalAction(row.actionJson).description,
  actionPreview: parseApprovalAction(row.actionJson).actionPreview ?? "",
  risk: normalizeRisk(parseApprovalAction(row.actionJson).risk),
  ...(row.decision === "approved" || row.decision === "rejected" ? { decision: row.decision } : {}),
})

const parseApprovalAction = (text: string): { title?: string; description?: string; actionPreview?: string; risk?: string } => {
  const parsed = parseJson(text)
  return typeof parsed === "object" && parsed !== null ? (parsed as { title?: string; description?: string; actionPreview?: string; risk?: string }) : {}
}

const normalizeActionKind = (value: string): NonNullable<ConversationToolRun["approval"]>["actionKind"] => {
  if (["shell_command", "file_write", "patch_apply", "git_commit", "git_push", "other"].includes(value)) {
    return value as NonNullable<ConversationToolRun["approval"]>["actionKind"]
  }
  return "other"
}

const normalizeRisk = (value: string | undefined): NonNullable<ConversationToolRun["approval"]>["risk"] => {
  if (value === "low" || value === "medium" || value === "high") {
    return value
  }
  return undefined
}

const summarizeStoredToolRun = (
  toolName: string,
  result: unknown,
  shell: typeof shellCommands.$inferSelect | undefined,
): string => {
  if (shell) {
    return `Command exited ${shell.exitCode === null || shell.exitCode === undefined ? "without an exit code" : `with code ${shell.exitCode}`}.`
  }
  if (typeof result === "object" && result !== null) {
    if ("summary" in result && typeof result.summary === "string") {
      return result.summary
    }
    if ("totalMatches" in result && typeof result.totalMatches === "number") {
      return `Found ${result.totalMatches} ${result.totalMatches === 1 ? "match" : "matches"}.`
    }
    if ("changedFiles" in result && Array.isArray(result.changedFiles)) {
      return `Changed ${result.changedFiles.length} ${result.changedFiles.length === 1 ? "file" : "files"}.`
    }
  }
  return `${toolName} completed.`
}

const previewStoredToolResult = (toolName: string, result: unknown, stdout: string, stderr: string): string => {
  if (toolName === "bash") {
    return truncatePreview([stdout, stderr].filter(Boolean).join("\n"), 20_000)
  }
  if (typeof result === "object" && result !== null && "content" in result && typeof result.content === "string") {
    return truncatePreview(result.content, 20_000)
  }
  if (typeof result === "object" && result !== null && "diff" in result && typeof result.diff === "string") {
    return truncatePreview(result.diff, 20_000)
  }
  return result === undefined ? "" : truncatePreview(JSON.stringify(result, null, 2), 20_000)
}

const truncatePreview = (text: string, charLimit: number): string =>
  text.length > charLimit ? `${text.slice(0, charLimit)}\n... truncated ...` : text
