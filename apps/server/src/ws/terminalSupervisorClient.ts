import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { BashToolInput, BashToolOutput } from "@socrates/contracts"
import { SocratesError, type ErrorDetails } from "@socrates/shared"

type SupervisorMethod = "start" | "status" | "output" | "stop" | "input" | "resize" | "has" | "health" | "shutdown-if-idle" | "shutdown"
type SupervisorRequest = {
  id: string
  method: SupervisorMethod
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
  health?: TerminalSupervisorHealth
  error?: { code: string; message: string; details?: unknown }
}

export type TerminalSupervisorHealth = {
  instanceId: string
  processId: number
  startedAt: string
  terminalCount: number
}

const terminalSupervisorProtocolVersion = "pty-v3-20260607-text-input"

export class TerminalSupervisorClient {
  private readonly socketPath: string
  private spawnPromise: Promise<void> | undefined

  constructor(scope = process.cwd()) {
    const hash = crypto.createHash("sha256").update(`${scope}:${terminalSupervisorProtocolVersion}`).digest("hex").slice(0, 16)
    this.socketPath =
      process.platform === "win32" ? `\\\\.\\pipe\\socrates-terminal-${hash}` : path.join(os.tmpdir(), `socrates-terminal-${hash}.sock`)
  }

  async start(terminalId: string, workspacePath: string, input: BashToolInput): Promise<BashToolOutput> {
    const response = await this.request({ method: "start", terminalId, workspacePath, input })
    return requireOutput(response)
  }

  async status(terminalId: string, processId: string | undefined, input: BashToolInput = {}): Promise<BashToolOutput> {
    const response = await this.request({ method: "status", terminalId, input, ...(processId ? { processId } : {}) })
    return requireOutput(response)
  }

  async output(terminalId: string, processId: string | undefined, input: BashToolInput = {}): Promise<BashToolOutput> {
    const response = await this.request({ method: "output", terminalId, input, ...(processId ? { processId } : {}) })
    return requireOutput(response)
  }

  async stop(terminalId: string, processId: string | undefined, input: BashToolInput = {}): Promise<BashToolOutput> {
    const response = await this.request({ method: "stop", terminalId, input, ...(processId ? { processId } : {}) })
    return requireOutput(response)
  }

  async input(terminalId: string, processId: string | undefined, text: string): Promise<void> {
    await this.request({ method: "input", terminalId, text, ...(processId ? { processId } : {}) })
  }

  async resize(terminalId: string, processId: string | undefined, cols: number, rows: number): Promise<void> {
    await this.request({ method: "resize", terminalId, cols, rows, ...(processId ? { processId } : {}) })
  }

  async has(terminalId: string): Promise<boolean> {
    const response = await this.request({ method: "has", terminalId })
    return response.has === true
  }

  async inspectHealth(): Promise<TerminalSupervisorHealth | undefined> {
    if (!(await this.canConnect())) return undefined
    const response = await this.send({ method: "health" }).catch(() => undefined)
    if (!response) return undefined
    // Supervisors started by the immediately previous protocol remain usable until
    // their last Terminal exits, even though they do not expose health metadata.
    return response.health ?? { instanceId: "legacy", processId: 0, startedAt: "unknown", terminalCount: -1 }
  }

  async health(): Promise<TerminalSupervisorHealth> {
    const response = await this.request({ method: "health" })
    if (!response.health) {
      throw new SocratesError("terminal_supervisor_missing_health", "Terminal supervisor did not return health information.", { recoverable: true })
    }
    return response.health
  }

  async shutdownIfIdle(): Promise<void> {
    if (!(await this.canConnect())) {
      return
    }
    await this.send({ method: "shutdown-if-idle" }).catch(() => undefined)
  }

  async shutdown(): Promise<void> {
    if (!(await this.canConnect())) {
      return
    }
    await this.send({ method: "shutdown" }).catch(() => undefined)
    await this.waitForDisconnect()
  }

  private async request(input: Omit<SupervisorRequest, "id">): Promise<SupervisorResponse> {
    await this.ensureRunning()
    try {
      return await this.send(input)
    } catch (firstError) {
      if (firstError instanceof SocratesError && firstError.code !== "terminal_supervisor_timeout") {
        throw firstError
      }
      // A request timeout is not proof that the supervisor is dead. Never replace a
      // potentially healthy supervisor (and its PTYs) from an ordinary operation.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await wait(100 * (attempt + 1))
        if (await this.canConnect()) {
          try {
            return await this.send(input)
          } catch {
            // Retry only after another reachability probe; never replace in-place.
          }
        }
      }
      throw new SocratesError("terminal_supervisor_unavailable", "Terminal supervisor is not reachable after bounded retries.", {
        details: { cause: firstError instanceof Error ? firstError.message : String(firstError) },
        recoverable: true,
      })
    }
  }

  private async ensureRunning(): Promise<void> {
    if (await this.canConnect()) {
      return
    }
    if (this.spawnPromise) {
      return this.spawnPromise
    }
    const spawnPromise = this.spawnSupervisor()
    this.spawnPromise = spawnPromise
    try {
      await spawnPromise
    } finally {
      if (this.spawnPromise === spawnPromise) this.spawnPromise = undefined
    }
  }

  private async spawnSupervisor(): Promise<void> {
    if (process.platform !== "win32" && fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath)
    }
    const currentPath = fileURLToPath(import.meta.url)
    const isBuilt = currentPath.endsWith(".js")
    const supervisorPath = fileURLToPath(new URL(isBuilt ? "./terminalSupervisorProcess.js" : "./terminalSupervisorProcess.ts", import.meta.url))
    const args = isBuilt ? [supervisorPath, this.socketPath] : ["--import", "tsx", supervisorPath, this.socketPath]
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SOCRATES_TERMINAL_SUPERVISOR: "1" },
    })
    child.unref()
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      if (await this.canConnect()) {
        return
      }
      await wait(50)
    }
    throw new SocratesError("terminal_supervisor_unavailable", "Terminal supervisor did not become ready.", { recoverable: true })
  }

  private canConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath)
      const done = (ok: boolean) => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(ok)
      }
      socket.once("connect", () => done(true))
      socket.once("error", () => done(false))
      socket.setTimeout(250, () => done(false))
    })
  }

  private async waitForDisconnect(): Promise<void> {
    const deadline = Date.now() + 1_000
    while (Date.now() < deadline) {
      if (!(await this.canConnect())) {
        return
      }
      await wait(20)
    }
  }

  private send(input: Omit<SupervisorRequest, "id">): Promise<SupervisorResponse> {
    return new Promise((resolve, reject) => {
      const request = { ...input, id: crypto.randomUUID() }
      const socket = net.createConnection(this.socketPath)
      let buffer = ""
      const cleanup = () => {
        socket.removeAllListeners()
        socket.destroy()
      }
      socket.setEncoding("utf8")
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`))
      socket.on("data", (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf("\n")
        if (newline < 0) {
          return
        }
        const line = buffer.slice(0, newline)
        cleanup()
        const response = JSON.parse(line) as SupervisorResponse
        if (!response.ok) {
          reject(
            new SocratesError(response.error?.code ?? "terminal_supervisor_failed", response.error?.message ?? "Terminal supervisor request failed.", {
              ...(response.error?.details === undefined ? {} : { details: response.error.details as ErrorDetails }),
              recoverable: true,
            }),
          )
          return
        }
        resolve(response)
      })
      socket.once("error", (error) => {
        cleanup()
        reject(error)
      })
      socket.setTimeout(5_000, () => {
        cleanup()
        reject(new SocratesError("terminal_supervisor_timeout", "Terminal supervisor request timed out.", { recoverable: true }))
      })
    })
  }
}

const requireOutput = (response: SupervisorResponse): BashToolOutput => {
  if (!response.output) {
    throw new SocratesError("terminal_supervisor_missing_output", "Terminal supervisor did not return process output.", { recoverable: true })
  }
  return response.output
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
