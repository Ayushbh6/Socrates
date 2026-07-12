import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { normalizeError } from "@socrates/shared"
import type { BashToolInput, BashToolOutput } from "@socrates/contracts"

type Method = "start" | "status" | "output" | "stop" | "input" | "resize" | "has" | "health" | "shutdown-if-idle" | "shutdown"
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

if (!socketPath) throw new Error("Supervisor socket path is required.")
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
  let request: SupervisorRequest
  try {
    request = JSON.parse(line) as SupervisorRequest
    socket.end(JSON.stringify(await handleRequest(request)) + "\n")
  } catch (error) {
    const normalized = normalizeError(error)
    socket.end(JSON.stringify({ id: requestId(line), ok: false, error: { code: normalized.code, message: normalized.message, details: normalized.details } }) + "\n")
  }
}

const handleRequest = async (request: SupervisorRequest): Promise<SupervisorResponse> => {
  if (request.method === "health") {
    return { id: request.id, ok: true, health: { instanceId, processId: process.pid, startedAt, terminalCount: knownHosts.size } }
  }
  if (request.method === "shutdown-if-idle") {
    if (knownHosts.size === 0) setTimeout(shutdownCoordinator, 20).unref?.()
    return { id: request.id, ok: true }
  }
  if (request.method === "shutdown") {
    await Promise.allSettled([...knownHosts].map((terminalId) => sendHost(terminalId, { id: crypto.randomUUID(), method: "shutdown", terminalId })))
    setTimeout(shutdownCoordinator, 20).unref?.()
    return { id: request.id, ok: true }
  }
  const terminalId = request.terminalId
  if (!terminalId) throw new Error("Terminal id is required.")
  if (request.method === "has") {
    const has = await canConnect(hostSocketPath(terminalId))
    if (has) knownHosts.add(terminalId)
    return { id: request.id, ok: true, has }
  }
  if (request.method === "start") {
    await ensureHost(terminalId)
    knownHosts.add(terminalId)
  }
  if (!(await canConnect(hostSocketPath(terminalId)))) {
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
  if (await canConnect(hostSocketPath(terminalId))) return
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
  const hostSocket = hostSocketPath(terminalId)
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
    const socket = net.createConnection(hostSocketPath(terminalId))
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

const hostSocketPath = (terminalId: string): string => {
  const suffix = crypto.createHash("sha256").update(terminalId).digest("hex").slice(0, 16)
  return process.platform === "win32" ? "\\\\.\\pipe\\socrates-terminal-host-" + suffix : path.join(path.dirname(socketPath), "socrates-terminal-host-" + suffix + ".sock")
}

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
const shutdownCoordinator = (): void => {
  server.close(() => {
    if (process.platform !== "win32" && fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
    process.exit(0)
  })
}
process.on("SIGTERM", shutdownCoordinator)
process.on("SIGINT", shutdownCoordinator)
