import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { normalizeError } from "@socrates/shared"
import type { BashToolInput, BashToolOutput } from "@socrates/contracts"
import { terminalHostSocketPath } from "./terminalSupervisorPaths"

type Method = "start" | "status" | "output" | "stop" | "input" | "resize" | "has" | "health" | "shutdown-host" | "shutdown-if-idle" | "shutdown"
type SupervisorRequest = {
  id: string
  method: Method
  terminalId?: string
  workspacePath?: string
  processId?: string
  input?: BashToolInput
  text?: string
  cols?: number
  rows?: number
}
type SupervisorResponse = {
  id: string
  ok: boolean
  output?: BashToolOutput
  has?: boolean
  health?: { instanceId: string; processId: number; startedAt: string; terminalCount: number }
  error?: { code: string; message: string; details?: unknown }
}

const socketPath = process.argv[2]
const instanceId = crypto.randomUUID()
const startedAt = new Date().toISOString()
const knownHosts = new Set<string>()
const spawningHosts = new Map<string, Promise<void>>()
const activeStarts = new Set<Promise<SupervisorResponse>>()
const clientSockets = new Set<net.Socket>()
const idleShutdownMs = boundedMilliseconds(process.env.SOCRATES_TERMINAL_SUPERVISOR_IDLE_MS, 30_000, 100, 10 * 60_000)
let shuttingDown = false
let idleTimer: NodeJS.Timeout | undefined

if (!socketPath) throw new Error("Supervisor socket path is required.")
if (process.platform !== "win32" && fs.existsSync(socketPath)) fs.unlinkSync(socketPath)

const server = net.createServer((socket) => {
  clientSockets.add(socket)
  socket.once("close", () => clientSockets.delete(socket))
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
  scheduleIdleShutdown()
})

const handleLine = async (socket: net.Socket, line: string): Promise<void> => {
  clearTimeout(idleTimer)
  let request: SupervisorRequest
  try {
    request = JSON.parse(line) as SupervisorRequest
    socket.end(JSON.stringify(await handleRequest(request)) + "\n")
  } catch (error) {
    const normalized = normalizeError(error)
    socket.end(JSON.stringify({ id: requestId(line), ok: false, error: { code: normalized.code, message: normalized.message, details: normalized.details } }) + "\n")
  } finally {
    scheduleIdleShutdown()
  }
}

const handleRequest = async (request: SupervisorRequest): Promise<SupervisorResponse> => {
  if (request.method === "health") {
    return { id: request.id, ok: true, health: { instanceId, processId: process.pid, startedAt, terminalCount: knownHosts.size } }
  }
  if (request.method === "shutdown-if-idle") {
    if (knownHosts.size === 0 && activeStarts.size === 0) await beginShutdown()
    return { id: request.id, ok: true }
  }
  if (request.method === "shutdown") {
    await beginShutdown()
    return { id: request.id, ok: true }
  }
  const terminalId = request.terminalId
  if (!terminalId) throw new Error("Terminal id is required.")
  if (request.method === "has") {
    const has = await canConnect(terminalHostSocketPath(socketPath, terminalId))
    if (has) knownHosts.add(terminalId)
    else knownHosts.delete(terminalId)
    return { id: request.id, ok: true, has }
  }
  if (request.method === "start") {
    if (shuttingDown) throw new Error("Terminal supervisor is shutting down.")
    const start = startTerminal(request)
    activeStarts.add(start)
    try {
      return await start
    } finally {
      activeStarts.delete(start)
      scheduleIdleShutdown()
    }
  }
  if (request.method === "shutdown-host") {
    const hostSocket = terminalHostSocketPath(socketPath, terminalId)
    if (await canConnect(hostSocket)) {
      await sendHost(terminalId, { id: request.id, method: "shutdown-host", terminalId })
      await waitForDisconnect(hostSocket)
    }
    knownHosts.delete(terminalId)
    return { id: request.id, ok: true }
  }
  if (!(await canConnect(terminalHostSocketPath(socketPath, terminalId)))) {
    knownHosts.delete(terminalId)
    return { id: request.id, ok: true, output: missingOutput(request.method, request.processId) }
  }
  const response = await sendHost(terminalId, request)
  if (
    request.method === "stop" ||
    (response.output && !response.output.truncation.truncated && (response.output.process?.status === "exited" || response.output.process?.status === "stopped"))
  ) {
    knownHosts.delete(terminalId)
  }
  return response
}

const ensureHost = async (terminalId: string): Promise<void> => {
  if (await canConnect(terminalHostSocketPath(socketPath, terminalId))) return
  const pending = spawningHosts.get(terminalId)
  if (pending) return pending
  const promise = spawnHost(terminalId)
  spawningHosts.set(terminalId, promise)
  try {
    await promise
  } finally {
    spawningHosts.delete(terminalId)
  }
}

const spawnHost = async (terminalId: string): Promise<void> => {
  const hostSocket = terminalHostSocketPath(socketPath, terminalId)
  if (process.platform !== "win32" && fs.existsSync(hostSocket)) fs.unlinkSync(hostSocket)
  const currentPath = fileURLToPath(import.meta.url)
  const isBuilt = currentPath.endsWith(".js")
  const hostPath = fileURLToPath(new URL(isBuilt ? "./terminalHostProcess.js" : "./terminalHostProcess.ts", import.meta.url))
  const args = isBuilt ? [hostPath, hostSocket, terminalId] : ["--import", "tsx", hostPath, hostSocket, terminalId]
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: { ...process.env, SOCRATES_TERMINAL_HOST: "1" } })
  child.unref()
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await canConnect(hostSocket)) return
    await wait(40)
  }
  throw new Error("Terminal host did not become ready.")
}

const sendHost = (terminalId: string, request: SupervisorRequest): Promise<SupervisorResponse> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(terminalHostSocketPath(socketPath, terminalId))
    let buffer = ""
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"))
    socket.on("data", (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, newline)) as SupervisorResponse)
    })
    socket.once("error", reject)
    socket.setTimeout(5_000, () => {
      socket.destroy()
      reject(new Error("Terminal host request timed out."))
    })
  })

const canConnect = (target: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection(target)
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.setTimeout(200, () => done(false))
  })

const missingOutput = (method: Method, processId: string | undefined): BashToolOutput => ({
  operation: method === "start" || method === "output" || method === "stop" ? method : "status",
  cwd: process.cwd(),
  exitCode: null,
  stdout: "",
  stderr: "",
  durationMs: 0,
  timedOut: false,
  truncation: { truncated: false, charLimit: 80_000, originalLength: 0, returnedLength: 0 },
  shell: { platform: process.platform, kind: process.platform === "win32" ? "powershell" : "posix", executable: "unknown" },
  process: { processId: processId ?? "missing", status: "missing", nextOutputSequence: 0 },
})

const requestId = (line: string): string => {
  try {
    const value = JSON.parse(line) as { id?: unknown }
    return typeof value.id === "string" ? value.id : "unknown"
  } catch {
    return "unknown"
  }
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const startTerminal = async (request: SupervisorRequest): Promise<SupervisorResponse> => {
  const terminalId = request.terminalId as string
  try {
    await ensureHost(terminalId)
    if (shuttingDown) {
      await sendHost(terminalId, { id: crypto.randomUUID(), method: "shutdown", terminalId }).catch(() => undefined)
      throw new Error("Terminal supervisor shut down while the Terminal was starting.")
    }
    knownHosts.add(terminalId)
    const response = await sendHost(terminalId, request)
    if (response.output && !response.output.truncation.truncated && (response.output.process?.status === "exited" || response.output.process?.status === "stopped")) {
      knownHosts.delete(terminalId)
    }
    return response
  } catch (error) {
    knownHosts.delete(terminalId)
    throw error
  }
}

const beginShutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(idleTimer)
  await Promise.allSettled([...activeStarts])
  const terminalIds = [...knownHosts]
  await Promise.allSettled(terminalIds.map((terminalId) => sendHost(terminalId, { id: crypto.randomUUID(), method: "shutdown", terminalId })))
  await Promise.allSettled(terminalIds.map((terminalId) => waitForDisconnect(terminalHostSocketPath(socketPath, terminalId))))
  knownHosts.clear()
  setTimeout(shutdownCoordinator, 20).unref?.()
}

const waitForDisconnect = async (target: string): Promise<void> => {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (!(await canConnect(target))) return
    await wait(25)
  }
  throw new Error("Terminal process endpoint did not close after shutdown.")
}

function scheduleIdleShutdown(): void {
  clearTimeout(idleTimer)
  if (shuttingDown || knownHosts.size > 0 || activeStarts.size > 0 || spawningHosts.size > 0) return
  idleTimer = setTimeout(() => {
    if (!shuttingDown && knownHosts.size === 0 && activeStarts.size === 0 && spawningHosts.size === 0) {
      void beginShutdown()
    }
  }, idleShutdownMs)
  idleTimer.unref?.()
}

function boundedMilliseconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

const shutdownCoordinator = (): void => {
  shuttingDown = true
  clearTimeout(idleTimer)
  for (const socket of clientSockets) socket.destroy()
  clientSockets.clear()
  server.close(() => {
    if (process.platform !== "win32" && fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
    process.exit(0)
  })
}
process.on("SIGTERM", () => void beginShutdown())
process.on("SIGINT", () => void beginShutdown())
