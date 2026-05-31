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
    expect(described.docs).toContain('serverName="playwright"')
    expect(described.docs).not.toContain('serverId="playwright"')
    expect(described.summary).toContain("playwright")
  })

  it("exposes no-schema dynamic MCP tools as object inputs", async () => {
    const home = tempHome()
    const runtime = new McpRuntime({ socratesHome: home })

    await runtime.handleRegistryTool({ operation: "configure", preset: "playwright" })
    fs.mkdirSync(path.join(home, "mcp", "registry"), { recursive: true })
    fs.writeFileSync(
      path.join(home, "mcp", "registry", "playwright.tools.json"),
      `${JSON.stringify([{ name: "noop", description: "No input schema." }], null, 2)}\n`,
    )

    const [tool] = runtime.getDynamicToolDefinitions("playwright")
    expect(tool?.name).toBe("mcp__playwright__noop")
    expect(tool?.inputSchema._def.typeName).toBe("ZodObject")
    expect(tool?.inputSchema.safeParse({ unexpected: "allowed" }).success).toBe(true)
  })

  it("reuses dynamic MCP clients within a conversation and runs them in the workspace cwd", async () => {
    const home = tempHome()
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "socrates-mcp-workspace-")))
    const runtime = new McpRuntime({ socratesHome: home })
    configureFakeMcp(home)

    try {
      const first = (await runtime.callDynamicTool("mcp__fake__record", { value: 1 }, { cwd: workspace, sessionKey: "conv_1" })) as {
        calls: number
        cwd: string
      }
      const second = (await runtime.callDynamicTool("mcp__fake__record", { value: 2 }, { cwd: workspace, sessionKey: "conv_1" })) as {
        calls: number
        cwd: string
      }

      expect(first).toMatchObject({ calls: 1, cwd: workspace })
      expect(second).toMatchObject({ calls: 2, cwd: workspace })
    } finally {
      runtime.close()
    }
  })

  it("turns MCP isError results into recoverable tool failures", async () => {
    const home = tempHome()
    const runtime = new McpRuntime({ socratesHome: home })
    configureFakeMcp(home)

    try {
      await expect(runtime.callDynamicTool("mcp__fake__fail", {}, { sessionKey: "conv_1" })).rejects.toMatchObject({
        code: "mcp_tool_failed",
        message: "### Error\nFake MCP failure",
        recoverable: true,
      })
    } finally {
      runtime.close()
    }
  })
})

const configureFakeMcp = (home: string): void => {
  const scriptPath = path.join(home, "fake-mcp.cjs")
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    scriptPath,
    [
      "const readline = require('node:readline');",
      "let calls = 0;",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') {",
      "    send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } });",
      "    return;",
      "  }",
      "  if (message.method === 'tools/call') {",
      "    calls += 1;",
      "    if (message.params && message.params.name === 'fail') {",
      "      send(message.id, { isError: true, content: [{ type: 'text', text: '### Error\\nFake MCP failure' }] });",
      "      return;",
      "    }",
      "    send(message.id, { calls, cwd: process.cwd(), arguments: message.params ? message.params.arguments : undefined });",
      "    return;",
      "  }",
      "  if (message.id !== undefined) send(message.id, {});",
      "});",
    ].join("\n"),
  )
  fs.writeFileSync(
    path.join(home, "mcp.json"),
    `${JSON.stringify({ servers: { fake: { command: process.execPath, args: [scriptPath], enabled: true } } }, null, 2)}\n`,
  )
}
