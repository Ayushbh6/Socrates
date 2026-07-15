import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import { createWorkspaceShellSession, type WorkspaceShellSession } from "@socrates/workspace"
import { normalizeError } from "@socrates/shared"
import type { BashToolInput, BashToolOutput } from "@socrates/contracts"

type HostRequest = {
  id: string
  method: "start" | "status" | "output" | "stop" | "input" | "resize" | "health" | "shutdown" | "shutdown-host"
  terminalId: string
  workspacePath?: string
  processId?: string
  input?: BashToolInput
  text?: string
  cols?: number
  rows?: number
}

type HostResponse = {
  id: string
  ok: boolean
  output?: BashToolOutput
  health?: { instanceId: string; processId: number; startedAt: string }
  error?: { code: string; message: string; details?: unknown }
}

const socketPath = process.argv[2]
const expectedTerminalId = process.argv[3]
const instanceId = crypto.randomUUID()
const startedAt = new Date().toISOString()
let session: WorkspaceShellSession | undefined
let processId: string | undefined
let shuttingDown = false
const startupTimeoutMs = boundedMilliseconds(process.env.SOCRATES_TERMINAL_HOST_STARTUP_TIMEOUT_MS, 30_000, 1_000, 10 * 60_000)
const startupTimer = setTimeout(() => {
  if (!session) shutdown()
}, startupTimeoutMs)
startupTimer.unref?.()

if (!socketPath || !expectedTerminalId) throw new Error("Terminal host socket path and terminal id are required.")
if (process.platform !== "win32" && fs.existsSync(socketPath)) fs.unlinkSync(socketPath)

const server = net.createServer((socket) => {
  let buffer = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      void handleLine(socket, line)
    }
  })
})

server.listen(socketPath)
server.on("listening", () => {
  if (process.platform !== "win32") fs.chmodSync(socketPath, 0o600)
})

const handleLine = async (socket: net.Socket, line: string): Promise<void> => {
  let request: HostRequest
  try {
    request = JSON.parse(line) as HostRequest
    if (request.terminalId !== expectedTerminalId) throw new Error("Terminal host scope mismatch.")
    write(socket, await handleRequest(request))
  } catch (error) {
    const normalized = normalizeError(error)
    write(socket, { id: requestId(line), ok: false, error: { code: normalized.code, message: normalized.message, details: normalized.details } })
  }
}

const handleRequest = async (request: HostRequest): Promise<HostResponse> => {
  if (request.method === "health") {
    return { id: request.id, ok: true, health: { instanceId, processId: process.pid, startedAt } }
  }
  if (request.method === "shutdown" || request.method === "shutdown-host") {
    setTimeout(shutdown, 20).unref?.()
    return { id: request.id, ok: true }
  }
  if (request.method === "start") {
    if (shuttingDown) throw new Error("Terminal host is shutting down.")
    if (!request.workspacePath || !request.input) throw new Error("Terminal start payload is incomplete.")
    clearTimeout(startupTimer)
    session?.dispose()
    session = createWorkspaceShellSession(request.workspacePath)
    const output = await session.run({ ...request.input, operation: "start" })
    processId = output.process?.processId
    if (!processId) throw new Error("Terminal process did not return a process id.")
    return { id: request.id, ok: true, output }
  }
  if (!session || !processId) {
    const operation = request.method === "input" || request.method === "resize" ? "status" : request.method
    return { id: request.id, ok: true, output: missingOutput(operation, request.processId) }
  }
  if (request.method === "input") {
    session.writeProcessInput(request.processId ?? processId, request.text ?? "")
    return { id: request.id, ok: true }
  }
  if (request.method === "resize") {
    if (!request.cols || !request.rows) throw new Error("Terminal resize payload is incomplete.")
    session.resizeProcess(request.processId ?? processId, request.cols, request.rows)
    return { id: request.id, ok: true }
  }
  const output = await session.run({ ...(request.input ?? {}), operation: request.method, processId: request.processId ?? processId } as BashToolInput)
  if (request.method === "stop" || (!output.truncation.truncated && (output.process?.status === "exited" || output.process?.status === "stopped"))) {
    setTimeout(shutdown, 50).unref?.()
  }
  return { id: request.id, ok: true, output }
}

const missingOutput = (operation: "status" | "output" | "stop", requestedId: string | undefined): BashToolOutput => ({
  operation,
  cwd: os.homedir(),
  exitCode: null,
  stdout: "",
  stderr: "",
  durationMs: 0,
  timedOut: false,
  truncation: { truncated: false, charLimit: 80_000, originalLength: 0, returnedLength: 0 },
  shell: { platform: process.platform, kind: process.platform === "win32" ? "powershell" : "posix", executable: "unknown" },
  process: { processId: requestedId ?? "missing", status: "missing", nextOutputSequence: 0 },
})

const write = (socket: net.Socket, response: HostResponse): void => {
  socket.end(JSON.stringify(response) + "\n")
}

const requestId = (line: string): string => {
  try {
    const value = JSON.parse(line) as { id?: unknown }
    return typeof value.id === "string" ? value.id : "unknown"
  } catch {
    return "unknown"
  }
}

const shutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(startupTimer)
  session?.dispose()
  server.close(() => {
    if (process.platform !== "win32" && fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
    process.exit(0)
  })
}

function boundedMilliseconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
