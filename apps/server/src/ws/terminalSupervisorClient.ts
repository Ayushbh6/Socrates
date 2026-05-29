import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { BashToolInput, BashToolOutput } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"

type SupervisorMethod = "start" | "status" | "output" | "stop" | "input" | "has"
type SupervisorRequest = {
  id: string
  method: SupervisorMethod
  terminalId: string
  workspacePath?: string
  processId?: string
  input?: BashToolInput
  text?: string
}
type SupervisorResponse = {
  id: string
  ok: boolean
  output?: BashToolOutput
  has?: boolean
  error?: { code: string; message: string; details?: unknown }
}

export class TerminalSupervisorClient {
  private readonly socketPath: string
  private spawnPromise: Promise<void> | undefined

  constructor(scope = process.cwd()) {
    const hash = crypto.createHash("sha256").update(scope).digest("hex").slice(0, 16)
    this.socketPath =
      process.platform === "win32" ? `\\\\.\\pipe\\socrates-terminal-${hash}` : path.join(os.tmpdir(), `socrates-terminal-${hash}.sock`)
  }

  async start(terminalId: string, workspacePath: string, input: BashToolInput): Promise<BashToolOutput> {
    const response = await this.request({ method: "start", terminalId, workspacePath, input })
    return requireOutput(response)
  }

  async status(terminalId: string, processId: string | undefined, input: BashToolInput = {}): Promise<BashToolOutput> {
    const response = await this.request({ method: "status", terminalId, processId, input })
    return requireOutput(response)
  }

  async output(terminalId: string, processId: string | undefined, input: BashToolInput = {}): Promise<BashToolOutput> {
    const response = await this.request({ method: "output", terminalId, processId, input })
    return requireOutput(response)
  }

  async stop(terminalId: string, processId: string | undefined, input: BashToolInput = {}): Promise<BashToolOutput> {
    const response = await this.request({ method: "stop", terminalId, processId, input })
    return requireOutput(response)
  }

  async input(terminalId: string, processId: string | undefined, text: string): Promise<void> {
    await this.request({ method: "input", terminalId, processId, text })
  }

  async has(terminalId: string): Promise<boolean> {
    const response = await this.request({ method: "has", terminalId })
    return response.has === true
  }

  private async request(input: Omit<SupervisorRequest, "id">): Promise<SupervisorResponse> {
    await this.ensureRunning()
    try {
      return await this.send(input)
    } catch (error) {
      await this.ensureRunning(true)
      return await this.send(input)
    }
  }

  private async ensureRunning(force = false): Promise<void> {
    if (!force && (await this.canConnect())) {
      return
    }
    if (this.spawnPromise && !force) {
      return this.spawnPromise
    }
    this.spawnPromise = this.spawnSupervisor()
    await this.spawnPromise
    this.spawnPromise = undefined
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
          reject(new SocratesError(response.error?.code ?? "terminal_supervisor_failed", response.error?.message ?? "Terminal supervisor request failed.", {
            details: response.error?.details,
            recoverable: true,
          }))
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
