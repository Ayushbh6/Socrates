import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { McpRuntime } from "./index"

const tempHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "socrates-mcp-test-"))

describe("McpRuntime", () => {
  it("configures the bundled Playwright preset without secrets", async () => {
    const home = tempHome()
    const runtime = new McpRuntime({ socratesHome: home })

    const configured = await runtime.handleRegistryTool({ operation: "configure", preset: "playwright" })
    expect(configured.configured).toBe(true)
    expect(configured.server?.id).toBe("playwright")
    expect(configured.server?.requiresSecrets).toBe(false)
    expect(fs.existsSync(path.join(home, "mcp.json"))).toBe(true)
    expect(fs.existsSync(path.join(home, ".env"))).toBe(true)

    const listed = await runtime.handleRegistryTool({ operation: "list" })
    expect(listed.servers?.[0]?.id).toBe("playwright")
    expect(JSON.stringify(fs.readFileSync(path.join(home, "mcp.json"), "utf8"))).not.toContain("API_KEY")
  })

  it("describes Playwright with concise registry docs", async () => {
    const runtime = new McpRuntime({ socratesHome: tempHome() })
    const described = await runtime.handleRegistryTool({ operation: "describe", serverId: "playwright" })
    expect(described.docs).toContain("Use Playwright MCP")
    expect(described.summary).toContain("playwright")
  })
})
