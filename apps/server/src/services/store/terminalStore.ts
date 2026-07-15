import { and, desc, eq, inArray, or } from "drizzle-orm"
import type { ConversationTerminal, TerminalStatus } from "@socrates/contracts"
import { createId, nowIso } from "@socrates/shared"
import { terminalOutputChunks, terminalSessions } from "../../db/schema"
import { StoreBase } from "./shared"

export type CreateTerminalInput = {
  terminalId?: string
  projectId: string
  conversationId: string
  workspacePath: string
  name: string
  command: string
  cwd: string
  status: TerminalStatus
  platform?: string
  shellKind?: "posix" | "powershell" | "cmd"
  shellExecutable?: string
  processId?: string
  autoDetached?: boolean
  awaitingInput?: boolean
  stateVersion?: number
  lastPrompt?: string
  metadata?: unknown
}

export type UpdateTerminalInput = Partial<{
  name: string
  cwd: string
  status: TerminalStatus
  platform: string
  shellKind: "posix" | "powershell" | "cmd"
  shellExecutable: string
  processId: string
  exitCode: number | null
  signal: string | null
  autoDetached: boolean
  awaitingInput: boolean
  stateVersion: number
  lastPrompt: string | null
  completedAt: string | null
  metadata: unknown
}>

export type AppendTerminalOutputInput = {
  terminalId: string
  stream: "stdout" | "stderr" | "log" | "result" | "input" | "pty"
  text: string
  redacted?: boolean
}

export type TerminalSessionRow = typeof terminalSessions.$inferSelect
type TerminalOutputRow = typeof terminalOutputChunks.$inferSelect
type TerminalOutputSnapshot = ConversationTerminal["output"] & {
  originalLength: number
  returnedLength: number
  truncated: boolean
  modelVisibleNextSequence: number
}

export class TerminalStore extends StoreBase {
  createTerminal(input: CreateTerminalInput): string {
    const now = nowIso()
    const id = input.terminalId ?? createId("term")
    this.handle.db
      .insert(terminalSessions)
      .values({
        id,
        projectId: input.projectId,
        conversationId: input.conversationId,
        workspacePath: input.workspacePath,
        name: input.name,
        command: input.command,
        cwd: input.cwd,
        status: input.status,
        platform: input.platform,
        shellKind: input.shellKind,
        shellExecutable: input.shellExecutable,
        processId: input.processId,
        autoDetached: input.autoDetached ?? false,
        awaitingInput: input.awaitingInput ?? false,
        stateVersion: input.stateVersion ?? 0,
        lastPrompt: input.lastPrompt,
        startedAt: now,
        updatedAt: now,
        metadataJson: input.metadata === undefined ? undefined : JSON.stringify(input.metadata),
      })
      .run()
    return id
  }

  updateTerminal(terminalId: string, input: UpdateTerminalInput): void {
    const current = this.getTerminalRow(terminalId)
    const previousMetadata = asRecord(parseJson(current?.metadataJson ?? null))
    const nextMetadata = input.metadata === undefined ? previousMetadata : { ...(previousMetadata ?? {}), ...(asRecord(input.metadata) ?? {}) }
    const stateChanged = Boolean(
      current &&
        ((input.status !== undefined && input.status !== current.status) ||
          (input.exitCode !== undefined && input.exitCode !== current.exitCode) ||
          (input.signal !== undefined && input.signal !== current.signal) ||
          (input.awaitingInput !== undefined && input.awaitingInput !== current.awaitingInput) ||
          (input.lastPrompt !== undefined && input.lastPrompt !== current.lastPrompt) ||
          (input.completedAt !== undefined && input.completedAt !== current.completedAt)),
    )
    this.handle.db
      .update(terminalSessions)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        ...(input.shellKind === undefined ? {} : { shellKind: input.shellKind }),
        ...(input.shellExecutable === undefined ? {} : { shellExecutable: input.shellExecutable }),
        ...(input.processId === undefined ? {} : { processId: input.processId }),
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.autoDetached === undefined ? {} : { autoDetached: input.autoDetached }),
        ...(input.awaitingInput === undefined ? {} : { awaitingInput: input.awaitingInput }),
        ...(stateChanged ? { stateVersion: (current?.stateVersion ?? 0) + 1 } : {}),
        ...(input.lastPrompt === undefined ? {} : { lastPrompt: input.lastPrompt }),
        ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
        ...(input.metadata === undefined ? {} : { metadataJson: JSON.stringify(nextMetadata ?? {}) }),
        updatedAt: nowIso(),
      })
      .where(eq(terminalSessions.id, terminalId))
      .run()
  }

  appendOutput(input: AppendTerminalOutputInput): number {
    const row = this.handle.sqlite
      .prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence FROM terminal_output_chunks WHERE terminal_session_id = ?")
      .get(input.terminalId) as { next_sequence: number }
    this.handle.db
      .insert(terminalOutputChunks)
      .values({
        id: createId("tout"),
        terminalSessionId: input.terminalId,
        sequence: row.next_sequence,
        stream: input.stream,
        text: input.text,
        redacted: input.redacted ?? false,
        createdAt: nowIso(),
      })
      .run()
    this.updateTerminal(input.terminalId, {})
    return row.next_sequence
  }

  getModelVisibleOutputSequence(terminalId: string): number {
    const metadata = asRecord(parseJson(this.getTerminalRow(terminalId)?.metadataJson ?? null))
    const value = metadata?.modelVisibleOutputSequence
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
  }

  setModelVisibleOutputSequence(terminalId: string, sequence: number): void {
    this.updateTerminal(terminalId, { metadata: { modelVisibleOutputSequence: Math.max(0, Math.floor(sequence)) } })
  }

  terminalOutputSnapshot(terminalId: string, fromSequence = 0, charLimit = 80_000): TerminalOutputSnapshot {
    const allChunks = this.outputChunks(terminalId)
    const nextOutputSequence = allChunks.reduce((max, chunk) => Math.max(max, chunk.sequence + 1), 0)
    const chunks = allChunks.filter((chunk) => chunk.sequence >= fromSequence)
    const full = summarizeOutput(chunks)
    const bounded = boundTerminalOutput(full, charLimit)
    return {
      ...bounded,
      nextOutputSequence,
      originalLength: full.stdout.length + full.stderr.length,
      returnedLength: bounded.stdout.length + bounded.stderr.length,
      truncated: bounded.stdout.length < full.stdout.length || bounded.stderr.length < full.stderr.length,
      // Never advance the model cursor across content we did not return. Repeating a bounded
      // page is preferable to silently losing terminal evidence.
      modelVisibleNextSequence: bounded.stdout.length < full.stdout.length || bounded.stderr.length < full.stderr.length ? fromSequence : nextOutputSequence,
    }
  }

  getTerminalRow(terminalId: string): TerminalSessionRow | undefined {
    return this.handle.db.select().from(terminalSessions).where(eq(terminalSessions.id, terminalId)).get()
  }

  findTerminalRow(conversationId: string, identifier: string): TerminalSessionRow | undefined {
    const exact = this.handle.db
      .select()
      .from(terminalSessions)
      .where(and(eq(terminalSessions.conversationId, conversationId), or(eq(terminalSessions.id, identifier), eq(terminalSessions.processId, identifier))))
      .limit(1)
      .get()
    if (exact) {
      return exact
    }
    const nameMatches = this.handle.db
      .select()
      .from(terminalSessions)
      .where(and(eq(terminalSessions.conversationId, conversationId), eq(terminalSessions.name, identifier)))
      .orderBy(desc(terminalSessions.updatedAt))
      .all()
    const activeMatches = nameMatches.filter((row) => row.status === "starting" || row.status === "running" || row.status === "awaiting_input")
    const activeMatch = activeMatches[0]
    if (activeMatches.length === 1 && activeMatch) {
      return activeMatch
    }
    const onlyMatch = nameMatches[0]
    if (nameMatches.length === 1 && onlyMatch) {
      return onlyMatch
    }
    return undefined
  }

  listConversationTerminals(conversationId: string, limit = 20): ConversationTerminal[] {
    const rows = this.handle.db
      .select()
      .from(terminalSessions)
      .where(eq(terminalSessions.conversationId, conversationId))
      .orderBy(desc(terminalSessions.updatedAt))
      .limit(limit)
      .all()
    return rows.map((row) => this.mapTerminal(row))
  }

  listActiveTerminals(): ConversationTerminal[] {
    const rows = this.handle.db
      .select()
      .from(terminalSessions)
      .where(inArray(terminalSessions.status, ["starting", "running", "awaiting_input"]))
      .all()
    return rows.map((row) => this.mapTerminal(row))
  }

  terminalContextBrief(conversationId: string, limit = 8): string | undefined {
    const terminals = this.listConversationTerminals(conversationId, limit).filter((terminal) =>
      ["starting", "running", "awaiting_input", "detached", "missing"].includes(terminal.status),
    )
    if (terminals.length === 0) {
      return undefined
    }
    const context = [
      "Active Terminal Context",
      "These are bounded current-state anchors. Use bash list before complex Terminal work. If a Terminal awaits user input, tell the user what prompt is waiting and stop; do not claim success until follow-up output confirms it.",
      ...terminals.map((terminal) => {
        const tail = [terminal.output.stdout, terminal.output.stderr].filter(Boolean).join("\n").slice(-900)
        return [
          `- name: ${clipText(terminal.name, 96)}`,
          `  status: ${terminal.status}${terminal.awaitingInput ? " awaiting user input" : ""}`,
          `  command: ${clipText(terminal.command, 320)}`,
          `  cwd: ${clipText(terminal.cwd, 240)}`,
          `  shell: ${clipText([terminal.platform, terminal.shellKind, terminal.shellExecutable].filter(Boolean).join(" / ") || "unknown", 160)}`,
          `  started: ${terminal.startedAt}; updated: ${terminal.updatedAt}`,
          terminal.exitCode !== undefined || terminal.signal ? `  exit: ${terminal.exitCode ?? "none"}${terminal.signal ? ` signal ${terminal.signal}` : ""}` : undefined,
          terminal.lastPrompt ? `  prompt: ${clipText(terminal.lastPrompt, 300)}` : undefined,
          tail ? `  recent output:\n${indent(tail, "    ")}` : undefined,
        ]
          .filter(Boolean)
          .join("\n")
      }),
    ].join("\n")
    return clipText(context, 10_000)
  }

  markRunningDetached(): ConversationTerminal[] {
    const rows = this.handle.db
      .select()
      .from(terminalSessions)
      .where(inArray(terminalSessions.status, ["starting", "running", "awaiting_input"]))
      .all()
    const now = nowIso()
    for (const row of rows) {
      this.updateTerminal(row.id, { status: "detached", awaitingInput: false, completedAt: now })
    }
    return rows.map((row) => this.mapTerminal({ ...row, status: "detached", awaitingInput: false, completedAt: now, updatedAt: now }))
  }

  stopConversationTerminals(conversationId: string): void {
    const rows = this.handle.db
      .select()
      .from(terminalSessions)
      .where(and(eq(terminalSessions.conversationId, conversationId), inArray(terminalSessions.status, ["starting", "running", "awaiting_input"])))
      .all()
    const now = nowIso()
    for (const row of rows) {
      this.updateTerminal(row.id, { status: "stopped", awaitingInput: false, signal: "SIGTERM", completedAt: now })
    }
  }

  stopProjectTerminals(projectId: string): void {
    const rows = this.handle.db
      .select()
      .from(terminalSessions)
      .where(and(eq(terminalSessions.projectId, projectId), inArray(terminalSessions.status, ["starting", "running", "awaiting_input"])))
      .all()
    const now = nowIso()
    for (const row of rows) {
      this.updateTerminal(row.id, { status: "stopped", awaitingInput: false, signal: "SIGTERM", completedAt: now })
    }
  }

  private mapTerminal(row: TerminalSessionRow): ConversationTerminal {
    const chunks = this.outputChunks(row.id)
    const output = summarizeOutput(chunks)
    return {
      terminalId: row.id,
      projectId: row.projectId,
      conversationId: row.conversationId,
      name: row.name,
      command: row.command,
      cwd: row.cwd,
      workspacePath: row.workspacePath,
      status: toTerminalStatus(row.status),
      ...(row.platform ? { platform: row.platform } : {}),
      ...(isShellKind(row.shellKind) ? { shellKind: row.shellKind } : {}),
      ...(row.shellExecutable ? { shellExecutable: row.shellExecutable } : {}),
      ...(row.processId ? { processId: row.processId } : {}),
      ...(row.exitCode === null ? {} : { exitCode: row.exitCode }),
      ...(row.signal ? { signal: row.signal } : {}),
      autoDetached: row.autoDetached,
      awaitingInput: row.awaitingInput,
      stateVersion: row.stateVersion,
      ...(row.lastPrompt ? { lastPrompt: row.lastPrompt } : {}),
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      output,
    }
  }

  private outputChunks(terminalId: string): TerminalOutputRow[] {
    return this.handle.db
      .select()
      .from(terminalOutputChunks)
      .where(eq(terminalOutputChunks.terminalSessionId, terminalId))
      .orderBy(terminalOutputChunks.sequence)
      .all()
  }
}

const summarizeOutput = (chunks: TerminalOutputRow[]): ConversationTerminal["output"] => {
  const pty = chunks.filter((chunk) => chunk.stream === "pty").map((chunk) => chunk.text).join("").slice(-20_000)
  const stdout = chunks.filter((chunk) => chunk.stream === "stdout" || chunk.stream === "pty").map((chunk) => chunk.text).join("").slice(-20_000)
  const stderr = chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.text).join("").slice(-20_000)
  const nextOutputSequence = chunks.reduce((max, chunk) => Math.max(max, chunk.sequence + 1), 0)
  return { stdout, stderr, ...(pty ? { pty } : {}), nextOutputSequence }
}

const boundTerminalOutput = (output: ConversationTerminal["output"], charLimit: number): ConversationTerminal["output"] => {
  const limit = Math.max(0, charLimit)
  const stdout = output.stdout.slice(0, limit)
  const stderrLimit = Math.max(0, limit - stdout.length)
  const stderr = output.stderr.slice(0, stderrLimit)
  const pty = output.pty ? output.pty.slice(0, limit) : undefined
  return { stdout, stderr, ...(pty ? { pty } : {}), nextOutputSequence: output.nextOutputSequence }
}

const toTerminalStatus = (value: string): TerminalStatus =>
  value === "starting" ||
  value === "running" ||
  value === "exited" ||
  value === "stopped" ||
  value === "detached" ||
  value === "stale" ||
  value === "awaiting_input" ||
  value === "missing"
    ? value
    : "missing"

const isShellKind = (value: unknown): value is "posix" | "powershell" | "cmd" =>
  value === "posix" || value === "powershell" || value === "cmd"

const parseJson = (text: string | null): unknown => {
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const indent = (text: string, prefix: string): string =>
  text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n")

const clipText = (value: string, limit: number): string => (value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`)
