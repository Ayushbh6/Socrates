import net from "node:net"
import os from "node:os"
import fs from "node:fs"
import crypto from "node:crypto"
import { createWorkspaceShellSession, type WorkspaceShellSession } from "@socrates/workspace"
import { normalizeError } from "@socrates/shared"
import type { BashToolInput, BashToolOutput } from "@socrates/contracts"

type SupervisorTerminal = {
  terminalId: string
  workspacePath: string
  session: WorkspaceShellSession
  processId: string
}

type SupervisorRequest =
  | { id: string; method: "start"; terminalId: string; workspacePath: string; input: BashToolInput }
  | { id: string; method: "status" | "output" | "stop"; terminalId: string; processId?: string; input?: BashToolInput }
  | { id: string; method: "input"; terminalId: string; processId?: string; text: string }
  | { id: string; method: "resize"; terminalId: string; processId?: string; cols: number; rows: number }
  | { id: string; method: "has"; terminalId: string }
  | { id: string; method: "health" }
  | { id: string; method: "shutdown" }
  | { id: string; method: "shutdown-if-idle" }

type SupervisorResponse =
  | { id: string; ok: true; output?: BashToolOutput; has?: boolean; health?: { instanceId: string; processId: number; startedAt: string; terminalCount: number } }
  | { id: string; ok: false; error: { code: string; message: string; details?: unknown } }

const terminals = new Map<string, SupervisorTerminal>()
const socketPath = process.argv[2]
const supervisorIdleShutdownMs = Number.parseInt(process.env.SOCRATES_TERMINAL_SUPERVISOR_IDLE_SHUTDOWN_MS ?? "2000", 10)
const supervisorInstanceId = crypto.randomUUID()
const supervisorStartedAt = new Date().toISOString()
let idleShutdownTimer: NodeJS.Timeout | undefined

if (!socketPath) {
  throw new Error("Supervisor socket path is required.")
}

if (process.platform !== "win32" && fs.existsSync(socketPath)) {
  fs.unlinkSync(socketPath)
}

const server = net.createServer((socket) => {
  let buffer = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) {
        return
      }
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      void handleLine(socket, line)
    }
  })
})

server.listen(socketPath)
server.on("listening", () => {
  if (process.platform !== "win32") {
    fs.chmodSync(socketPath, 0o600)
  }
})

const handleLine = async (socket: net.Socket, line: string): Promise<void> => {
  let request: SupervisorRequest
  try {
    request = JSON.parse(line) as SupervisorRequest
  } catch (error) {
    write(socket, { id: "unknown", ok: false, error: { code: "invalid_request", message: normalizeError(error).message } })
    return
  }

  try {
    write(socket, await handleRequest(request))
    refreshIdleShutdown()
  } catch (error) {
    const normalized = normalizeError(error)
    write(socket, {
      id: request.id,
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details === undefined ? {} : { details: normalized.details }),
      },
    })
  }
}

const handleRequest = async (request: SupervisorRequest): Promise<SupervisorResponse> => {
  if (request.method === "shutdown") {
    setTimeout(shutdown, 20).unref?.()
    return { id: request.id, ok: true }
  }

  if (request.method === "shutdown-if-idle") {
    if (terminals.size === 0) {
      setTimeout(shutdown, 20).unref?.()
    }
    return { id: request.id, ok: true }
  }

  if (request.method === "has") {
    return { id: request.id, ok: true, has: terminals.has(request.terminalId) }
  }

  if (request.method === "health") {
    return {
      id: request.id,
      ok: true,
      health: { instanceId: supervisorInstanceId, processId: process.pid, startedAt: supervisorStartedAt, terminalCount: terminals.size },
    }
  }

  if (request.method === "start") {
    const existing = terminals.get(request.terminalId)
    if (existing) {
      existing.session.dispose()
      terminals.delete(request.terminalId)
    }
    const session = createWorkspaceShellSession(request.workspacePath)
    try {
      const output = await session.run({ ...request.input, operation: "start" })
      const processId = output.process?.processId
      if (!processId) {
        session.dispose()
        throw new Error("Terminal process did not return a process id.")
      }
      terminals.set(request.terminalId, { terminalId: request.terminalId, workspacePath: request.workspacePath, session, processId })
      return { id: request.id, ok: true, output }
    } catch (error) {
      session.dispose()
      throw error
    }
  }

  const terminal = terminals.get(request.terminalId)
  if (!terminal) {
    const operation = request.method === "input" || request.method === "resize" ? "status" : request.method
    return {
      id: request.id,
      ok: true,
      output: missingOutput(operation, request.processId),
    }
  }

  if (request.method === "input") {
    terminal.session.writeProcessInput(request.processId ?? terminal.processId, request.text)
    return { id: request.id, ok: true }
  }

  if (request.method === "resize") {
    terminal.session.resizeProcess(request.processId ?? terminal.processId, request.cols, request.rows)
    return { id: request.id, ok: true }
  }

  const input = { ...(request.input ?? {}), operation: request.method, processId: request.processId ?? terminal.processId } as BashToolInput
  const output = await terminal.session.run(input)
  if (output.process?.status === "exited" || output.process?.status === "stopped" || request.method === "stop") {
    terminal.session.dispose()
    terminals.delete(request.terminalId)
  }
  return { id: request.id, ok: true, output }
}

const missingOutput = (operation: "status" | "output" | "stop", processId: string | undefined): BashToolOutput => ({
  operation,
  cwd: os.homedir(),
  exitCode: null,
  stdout: "",
  stderr: "",
  durationMs: 0,
  timedOut: false,
  truncation: { truncated: false, charLimit: 80_000, originalLength: 0, returnedLength: 0 },
  shell: { platform: process.platform, kind: process.platform === "win32" ? "powershell" : "posix", executable: "unknown" },
  process: { processId: processId ?? "missing", status: "missing", nextOutputSequence: 0 },
})

const write = (socket: net.Socket, response: SupervisorResponse): void => {
  socket.write(`${JSON.stringify(response)}\n`)
}

const shutdown = (): void => {
  clearTimeout(idleShutdownTimer)
  for (const terminal of terminals.values()) {
    terminal.session.dispose()
  }
  terminals.clear()
  server.close(() => {
    if (process.platform !== "win32" && fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath)
    }
    process.exit(0)
  })
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

const refreshIdleShutdown = (): void => {
  clearTimeout(idleShutdownTimer)
  if (terminals.size > 0 || supervisorIdleShutdownMs <= 0) {
    return
  }
  idleShutdownTimer = setTimeout(shutdown, supervisorIdleShutdownMs)
  idleShutdownTimer.unref?.()
}
