import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { TerminalSupervisorClient } from "./terminalSupervisorClient"
import { terminalHostSocketPath, terminalSupervisorSocketPath } from "./terminalSupervisorPaths"

const clients: TerminalSupervisorClient[] = []
const command = (source: string): string => JSON.stringify(process.execPath) + " -e " + JSON.stringify(source)
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.shutdown()))
})

describe("Terminal supervisor resilience", () => {
  it("serializes shutdown behind an in-flight start and never respawns afterward", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-terminal-shutdown-race-"))
    const client = new TerminalSupervisorClient(workspace)
    clients.push(client)
    const terminalId = "term_shutdown_race"
    const start = client.start(terminalId, workspace, {
      operation: "start",
      command: command('process.stdout.write("race-ready\\n"); setInterval(() => {}, 1000)'),
      name: "shutdown-race",
    })

    const shutdown = client.shutdown()
    const started = await start
    expect(started.process?.status).toBe("running")
    await shutdown

    if (process.platform !== "win32") {
      expect(fs.existsSync(terminalHostSocketPath(terminalSupervisorSocketPath(workspace), terminalId))).toBe(false)
      expect(fs.existsSync(terminalSupervisorSocketPath(workspace))).toBe(false)
    }
    await expect(client.health()).rejects.toMatchObject({ code: "terminal_supervisor_closed" })
  })

  it("self-expires while genuinely idle and can be restarted by a live client", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-terminal-idle-"))
    const client = new TerminalSupervisorClient(workspace, { idleShutdownMs: 100 })
    clients.push(client)
    const first = await client.health()
    await wait(350)
    if (process.platform !== "win32") {
      expect(fs.existsSync(terminalSupervisorSocketPath(workspace))).toBe(false)
    }
    const second = await client.health()
    expect(second.processId).not.toBe(first.processId)
  })

  it("forgets a naturally exited host that disappears before a poll response and then self-expires", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-terminal-natural-exit-"))
    const client = new TerminalSupervisorClient(workspace, { idleShutdownMs: 100 })
    clients.push(client)
    const terminalId = "term_natural_exit"
    const started = await client.start(terminalId, workspace, {
      operation: "start",
      command: command('setTimeout(() => process.exit(0), 40)'),
      name: "natural-exit",
    })

    await wait(250)
    const final = await client.status(terminalId, started.process?.processId)
    expect(["exited", "missing"]).toContain(final.process?.status)
    await wait(350)

    if (process.platform !== "win32") {
      expect(fs.existsSync(terminalHostSocketPath(terminalSupervisorSocketPath(workspace), terminalId))).toBe(false)
      expect(fs.existsSync(terminalSupervisorSocketPath(workspace))).toBe(false)
    }
  })

  it("keeps concurrent PTYs isolated, survives coordinator loss, accepts input, and bounds large reads", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-terminal-stress-"))
    const client = new TerminalSupervisorClient(workspace)
    clients.push(client)

    const starts = await Promise.all(
      ["alpha", "beta", "gamma", "delta"].map((name) =>
        client.start(
          "term_" + name,
          workspace,
          {
            operation: "start",
            command: command(
              name === "gamma"
                ? 'process.stdout.write("gamma-ready\\n" + "x".repeat(120000)); setInterval(() => {}, 1000)'
                : name === "delta"
                  ? 'process.stdout.write("delta-ready\\n"); process.stdin.once("data", d => { process.stdout.write("delta-input:" + d.toString().trim()); process.exit(0) }); setInterval(() => {}, 1000)'
                : 'process.stdout.write("' + name + '-ready\\n"); setInterval(() => {}, 1000)',
            ),
            name,
            ...(name === "delta" ? { inputMode: "user" as const } : {}),
          },
        ),
      ),
    )
    expect(starts.every((output) => output.process?.status === "running")).toBe(true)

    await wait(250)
    const healthBefore = await client.health()
    process.kill(healthBefore.processId, "SIGKILL")
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(healthBefore.processId, 0)
        await wait(20)
      } catch {
        break
      }
    }

    const alpha = await client.output("term_alpha", starts[0]?.process?.processId, { operation: "output", charLimit: 16_000 })
    const beta = await client.output("term_beta", starts[1]?.process?.processId, { operation: "output", charLimit: 16_000 })
    const gamma = await client.output("term_gamma", starts[2]?.process?.processId, { operation: "output", charLimit: 16_000 })
    expect(alpha.stdout).toContain("alpha-ready")
    expect(alpha.stdout).not.toContain("beta-ready")
    expect(beta.stdout).toContain("beta-ready")
    expect(beta.stdout).not.toContain("alpha-ready")
    expect(gamma.truncation.returnedLength).toBeLessThanOrEqual(16_000)
    expect(gamma.truncation.truncated).toBe(true)

    await client.input("term_delta", starts[3]?.process?.processId, "violet\n")
    await wait(150)
    const deltaAfterInput = await client.output("term_delta", starts[3]?.process?.processId, { operation: "output", charLimit: 16_000 })
    expect(deltaAfterInput.stdout).toContain("delta-input:violet")

    await Promise.allSettled([
      client.stop("term_alpha", starts[0]?.process?.processId),
      client.stop("term_beta", starts[1]?.process?.processId),
      client.stop("term_gamma", starts[2]?.process?.processId),
      client.stop("term_delta", starts[3]?.process?.processId),
    ])
  }, 15_000)
})
