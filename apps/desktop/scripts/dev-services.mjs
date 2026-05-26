import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const children = []

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const socratesHome = process.env.SOCRATES_HOME ?? path.join(os.homedir(), ".Socrates")

const isPortOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.end()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
    socket.setTimeout(500, () => {
      socket.destroy()
      resolve(false)
    })
  })

const waitForPort = async (port, label, timeoutMs = 60_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label} did not open 127.0.0.1:${port} within ${timeoutMs}ms`)
}

const prefixLines = (stream, label) => {
  let buffer = ""
  stream.on("data", (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.length > 0) {
        console.log(`[${label}] ${line}`)
      }
    }
  })
}

const startService = (label, args, extraEnv = {}) => {
  const child = spawn(pnpmCommand, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      SOCRATES_HOME: socratesHome,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  prefixLines(child.stdout, label)
  prefixLines(child.stderr, label)
  child.once("exit", (code, signal) => {
    if (signal) {
      return
    }
    if (code !== 0) {
      console.error(`[${label}] exited with code ${code}`)
      shutdown(1)
    }
  })
}

const shutdown = (code = 0) => {
  for (const child of children.splice(0)) {
    child.kill()
  }
  process.exit(code)
}

process.once("SIGINT", () => shutdown(0))
process.once("SIGTERM", () => shutdown(0))

if (!(await isPortOpen(4000))) {
  startService("server", ["--filter", "@socrates/server", "dev"])
} else {
  console.log("[server] using existing service on 127.0.0.1:4000")
}

if (!(await isPortOpen(3000))) {
  startService("web", ["--filter", "web", "dev"], {
    NEXT_PUBLIC_SOCRATES_API_BASE_URL: "http://127.0.0.1:4000",
    SOCRATES_API_BASE_URL: "http://127.0.0.1:4000",
  })
} else {
  console.log("[web] using existing service on 127.0.0.1:3000")
}

await waitForPort(4000, "Socrates server")
await waitForPort(3000, "Socrates web")
console.log(`[desktop] Socrates services are ready with SOCRATES_HOME=${socratesHome}`)

setInterval(() => undefined, 60_000)
