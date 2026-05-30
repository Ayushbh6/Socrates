import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import type { McpRegistryToolInput, McpRegistryToolOutput, ModelToolDefinition } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"

const mcpServerConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    requiresSecrets: z.boolean().optional(),
  })
  .strict()

const mcpConfigSchema = z
  .object({
    servers: z.record(z.string(), mcpServerConfigSchema).optional(),
  })
  .strict()

type McpConfig = z.infer<typeof mcpConfigSchema>
type McpServerConfig = z.infer<typeof mcpServerConfigSchema>

type McpTool = {
  name: string
  description?: string
  inputSchema?: unknown
}

export class McpRuntime {
  readonly socratesHome: string
  readonly configPath: string
  readonly envPath: string
  readonly registryPath: string
  private readonly clients = new Map<string, Promise<StdioMcpClient>>()

  constructor(options: { socratesHome?: string } = {}) {
    this.socratesHome = options.socratesHome ?? path.join(os.homedir(), ".Socrates")
    this.configPath = path.join(this.socratesHome, "mcp.json")
    this.envPath = path.join(this.socratesHome, ".env")
    this.registryPath = path.join(this.socratesHome, "mcp", "registry")
  }

  handleRegistryTool(input: McpRegistryToolInput): Promise<McpRegistryToolOutput> {
    this.ensureDefaults()
    const serverName = input.serverName ?? input.serverId ?? input.preset ?? "playwright"
    switch (input.operation) {
      case "list":
        return Promise.resolve(this.list())
      case "describe":
        return this.describe(serverName)
      case "check":
        return this.check(serverName)
      case "configure":
        return Promise.resolve(this.configure(input.preset ?? input.serverName ?? input.serverId ?? "playwright"))
    }
  }

  getDynamicToolDefinitions(serverId = "playwright"): ModelToolDefinition[] {
    this.ensureDefaults()
    const configured = this.readConfig().servers?.[serverId]
    if (!configured?.enabled) {
      return []
    }
    const cached = this.readCachedTools(serverId)
    return cached.map((tool) => ({
      name: dynamicToolName(serverId, tool.name),
      description: tool.description ?? `Run the ${tool.name} tool from the ${serverId} MCP server.`,
      inputSchema: jsonSchemaToZod(tool.inputSchema),
    }))
  }

  async callDynamicTool(dynamicName: string, input: unknown, options: { cwd?: string; sessionKey?: string } = {}): Promise<unknown> {
    const parsed = parseDynamicToolName(dynamicName)
    const config = this.readConfig().servers?.[parsed.serverId]
    if (!config?.enabled) {
      throw new SocratesError("mcp_server_not_configured", "MCP server is not configured or enabled.", {
        details: { serverId: parsed.serverId },
        recoverable: true,
      })
    }
    const client = await this.clientFor(parsed.serverId, config, options)
    try {
      const response = await client.request("tools/call", { name: parsed.toolName, arguments: input ?? {} })
      if (isMcpToolErrorResponse(response)) {
        throw new SocratesError("mcp_tool_failed", mcpToolErrorMessage(response), {
          details: { dynamicName, response },
          recoverable: true,
        })
      }
      return response
    } catch (error) {
      if (client.isClosed) {
        this.clients.delete(this.clientKey(parsed.serverId, options))
      }
      throw error
    }
  }

  close(): void {
    for (const clientPromise of this.clients.values()) {
      void clientPromise.then((client) => client.close()).catch(() => undefined)
    }
    this.clients.clear()
  }

  private list(): McpRegistryToolOutput {
    const config = this.readConfig()
    const servers = Object.entries(config.servers ?? {}).map(([id, server]) => ({
      id,
      label: id === "playwright" ? "Playwright MCP" : id,
      configured: true,
      enabled: server.enabled ?? true,
      bundled: id === "playwright",
      requiresSecrets: server.requiresSecrets ?? false,
      status: "unknown" as const,
      configPath: this.configPath,
      envPath: this.envPath,
    }))
    return {
      operation: "list",
      configPath: this.configPath,
      envPath: this.envPath,
      servers,
      summary: servers.length ? `Found ${servers.length} configured MCP server${servers.length === 1 ? "" : "s"}.` : "No MCP servers configured.",
    }
  }

  private async describe(serverId: string): Promise<McpRegistryToolOutput> {
    const config = this.readConfig()
    const server = config.servers?.[serverId]
    const docs = this.readRegistryDocs(serverId)
    const tools = this.readCachedTools(serverId).map((tool) => ({
      name: tool.name,
      dynamicName: dynamicToolName(serverId, tool.name),
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    }))
    return {
      operation: "describe",
      configPath: this.configPath,
      envPath: this.envPath,
      ...(server ? { server: this.serverSummary(serverId, server, tools.length ? "available" : "unknown", tools.length) } : {}),
      tools,
      docs,
      summary: server ? `${serverId} MCP is configured. Use the listed dynamic tool names when exposed.` : `${serverId} MCP is not configured.`,
    }
  }

  private async check(serverId: string): Promise<McpRegistryToolOutput> {
    const config = this.readConfig()
    const server = config.servers?.[serverId]
    if (!server) {
      return {
        operation: "check",
        configPath: this.configPath,
        envPath: this.envPath,
        server: {
          id: serverId,
          label: serverId,
          configured: false,
          enabled: false,
          requiresSecrets: false,
          status: "missing",
          configPath: this.configPath,
          envPath: this.envPath,
        },
        summary: `${serverId} MCP is not configured.`,
      }
    }

    try {
      const client = new StdioMcpClient(server, this.readEnv())
      try {
        await client.initialize()
        const response = await client.request("tools/list", {})
        const tools = parseToolsList(response)
        this.writeCachedTools(serverId, tools)
        return {
          operation: "check",
          configPath: this.configPath,
          envPath: this.envPath,
          server: this.serverSummary(serverId, server, "available", tools.length),
          tools: tools.map((tool) => ({
            name: tool.name,
            dynamicName: dynamicToolName(serverId, tool.name),
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
          })),
          summary: `${serverId} MCP is available with ${tools.length} tool${tools.length === 1 ? "" : "s"}.`,
        }
      } finally {
        client.close()
      }
    } catch (error) {
      return {
        operation: "check",
        configPath: this.configPath,
        envPath: this.envPath,
        server: this.serverSummary(serverId, server, "failed", 0),
        summary: `${serverId} MCP check failed.`,
        warnings: [error instanceof Error ? error.message : String(error)],
      }
    }
  }

  private configure(preset: string): McpRegistryToolOutput {
    if (preset !== "playwright") {
      return {
        operation: "configure",
        configPath: this.configPath,
        envPath: this.envPath,
        configured: false,
        summary: `${preset} does not have a built-in no-secret preset yet.`,
        warnings: [`Add custom MCP config manually to ${this.configPath} and secrets to ${this.envPath}.`],
      }
    }
    const config = this.readConfig()
    const next: McpConfig = {
      ...config,
      servers: {
        ...(config.servers ?? {}),
        playwright: defaultPlaywrightConfig(),
      },
    }
    this.writeConfig(next)
    this.closeServerClients("playwright")
    this.ensureRegistryDocs()
    return {
      operation: "configure",
      configPath: this.configPath,
      envPath: this.envPath,
      configured: true,
      server: this.serverSummary("playwright", next.servers?.playwright as McpServerConfig, "unknown", 0),
      summary: `Configured Playwright MCP at ${this.configPath}. It does not require secrets.`,
    }
  }

  private ensureDefaults(): void {
    fs.mkdirSync(this.socratesHome, { recursive: true })
    fs.mkdirSync(this.registryPath, { recursive: true })
    if (!fs.existsSync(this.configPath)) {
      this.writeConfig({ servers: { playwright: defaultPlaywrightConfig() } })
    }
    if (!fs.existsSync(this.envPath)) {
      fs.writeFileSync(this.envPath, "# Socrates local secrets. MCP API keys can be added here when needed.\n")
    }
    this.ensureRegistryDocs()
  }

  private ensureRegistryDocs(): void {
    const docsPath = path.join(this.registryPath, "playwright.md")
    const docs = [
      "# Playwright MCP",
      "",
      "Use Playwright MCP when the task needs a real browser: opening local apps, inspecting pages, clicking, typing, taking screenshots, or debugging UI flows.",
      "",
      "Call mcp_registry with operation=\"check\" and serverName=\"playwright\" to discover available dynamic tools. Use the returned mcp__playwright__* tool names only after they are exposed in the current turn.",
      "",
      "This bundled preset does not require API keys. Browser sessions may create local browser state and should be used only when browser automation is relevant.",
      "",
    ].join("\n")
    const existing = fs.existsSync(docsPath) ? fs.readFileSync(docsPath, "utf8") : undefined
    if (!existing || existing.includes('serverId="playwright"')) {
      fs.writeFileSync(docsPath, docs)
    }
  }

  private readRegistryDocs(serverId: string): string | undefined {
    const docsPath = path.join(this.registryPath, `${serverId}.md`)
    return fs.existsSync(docsPath) ? fs.readFileSync(docsPath, "utf8") : undefined
  }

  private readConfig(): McpConfig {
    if (!fs.existsSync(this.configPath)) {
      return {}
    }
    const parsed = mcpConfigSchema.safeParse(JSON.parse(fs.readFileSync(this.configPath, "utf8")))
    if (!parsed.success) {
      throw new SocratesError("mcp_config_invalid", "MCP config file is invalid.", {
        details: { configPath: this.configPath, issues: parsed.error.flatten() },
        recoverable: true,
      })
    }
    return parsed.data
  }

  private writeConfig(config: McpConfig): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    fs.writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`)
  }

  private async clientFor(serverId: string, config: McpServerConfig, options: { cwd?: string; sessionKey?: string }): Promise<StdioMcpClient> {
    const key = this.clientKey(serverId, options)
    const existing = this.clients.get(key)
    if (existing) {
      const client = await existing
      if (!client.isClosed) {
        return client
      }
      this.clients.delete(key)
    }

    const clientPromise = (async () => {
      const client = new StdioMcpClient(config, this.readEnv(), {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        onClose: () => {
          this.clients.delete(key)
        },
      })
      await client.initialize()
      return client
    })()
    this.clients.set(key, clientPromise)
    try {
      return await clientPromise
    } catch (error) {
      this.clients.delete(key)
      throw error
    }
  }

  private clientKey(serverId: string, options: { cwd?: string; sessionKey?: string }): string {
    return [serverId, options.sessionKey ?? "default", options.cwd ? path.resolve(options.cwd) : ""].join("\0")
  }

  private closeServerClients(serverId: string): void {
    for (const [key, clientPromise] of this.clients.entries()) {
      if (!key.startsWith(`${serverId}\0`)) {
        continue
      }
      this.clients.delete(key)
      void clientPromise.then((client) => client.close()).catch(() => undefined)
    }
  }

  private readEnv(): Record<string, string> {
    if (!fs.existsSync(this.envPath)) {
      return {}
    }
    const result: Record<string, string> = {}
    for (const line of fs.readFileSync(this.envPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) {
        continue
      }
      const index = trimmed.indexOf("=")
      if (index <= 0) {
        continue
      }
      result[trimmed.slice(0, index)] = trimmed.slice(index + 1)
    }
    return result
  }

  private readCachedTools(serverId: string): McpTool[] {
    const cachePath = path.join(this.registryPath, `${serverId}.tools.json`)
    if (!fs.existsSync(cachePath)) {
      return []
    }
    const parsed = z.array(mcpToolSchema).safeParse(JSON.parse(fs.readFileSync(cachePath, "utf8")))
    return parsed.success
      ? parsed.data.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        }))
      : []
  }

  private writeCachedTools(serverId: string, tools: McpTool[]): void {
    fs.mkdirSync(this.registryPath, { recursive: true })
    fs.writeFileSync(path.join(this.registryPath, `${serverId}.tools.json`), `${JSON.stringify(tools, null, 2)}\n`)
  }

  private serverSummary(serverId: string, server: McpServerConfig, status: "available" | "missing" | "failed" | "unknown", toolCount?: number) {
    return {
      id: serverId,
      label: serverId === "playwright" ? "Playwright MCP" : serverId,
      configured: true,
      enabled: server.enabled ?? true,
      bundled: serverId === "playwright",
      requiresSecrets: server.requiresSecrets ?? false,
      status,
      ...(toolCount === undefined ? {} : { toolCount }),
      configPath: this.configPath,
      envPath: this.envPath,
    }
  }
}

const mcpToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.unknown().optional(),
  })
  .strict()

const defaultPlaywrightConfig = (): McpServerConfig => ({
  command: process.execPath,
  args: [resolvePlaywrightMcpCli()],
  enabled: true,
  requiresSecrets: false,
})

const resolvePlaywrightMcpCli = (): string => {
  const packageJson = fileURLToPath(import.meta.resolve("@playwright/mcp/package.json"))
  return path.join(path.dirname(packageJson), "cli.js")
}

const dynamicToolName = (serverId: string, toolName: string) => `mcp__${serverId}__${toolName}` as const

const parseDynamicToolName = (dynamicName: string): { serverId: string; toolName: string } => {
  const match = /^mcp__([a-z0-9_-]+)__([a-zA-Z0-9_-]+)$/.exec(dynamicName)
  if (!match) {
    throw new SocratesError("mcp_tool_name_invalid", "Dynamic MCP tool name is invalid.", {
      details: { dynamicName },
      recoverable: true,
    })
  }
  return { serverId: match[1] as string, toolName: match[2] as string }
}

const parseToolsList = (response: unknown): McpTool[] => {
  const record = asRecord(response)
  const tools = Array.isArray(record?.tools) ? record.tools : []
  return tools.flatMap((tool): McpTool[] => {
    const item = asRecord(tool)
    if (!item || typeof item.name !== "string") {
      return []
    }
    return [
      {
        name: item.name,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
        ...(item.inputSchema === undefined ? {} : { inputSchema: item.inputSchema }),
      },
    ]
  })
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const isMcpToolErrorResponse = (response: unknown): boolean => asRecord(response)?.isError === true

const mcpToolErrorMessage = (response: unknown): string => {
  const record = asRecord(response)
  const content = Array.isArray(record?.content) ? record.content : []
  for (const part of content) {
    const item = asRecord(part)
    if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
      return item.text.trim()
    }
  }
  return "MCP tool returned an error."
}

const jsonSchemaToZod = (schema: unknown): z.ZodTypeAny => {
  const record = asRecord(schema)
  if (!record || record.type !== "object") {
    return z.object({}).passthrough()
  }
  const properties = asRecord(record.properties) ?? {}
  const required = new Set(Array.isArray(record.required) ? record.required.filter((item): item is string => typeof item === "string") : [])
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, value] of Object.entries(properties)) {
    const field = zodForJsonSchema(value)
    shape[key] = required.has(key) ? field : field.optional()
  }
  return z.object(shape).passthrough()
}

const zodForJsonSchema = (schema: unknown): z.ZodTypeAny => {
  const record = asRecord(schema)
  if (!record) return z.unknown()
  if (Array.isArray(record.enum) && record.enum.every((item) => typeof item === "string") && record.enum.length > 0) {
    return z.enum(record.enum as [string, ...string[]])
  }
  switch (record.type) {
    case "string":
      return z.string()
    case "number":
      return z.number()
    case "integer":
      return z.number().int()
    case "boolean":
      return z.boolean()
    case "array":
      return z.array(zodForJsonSchema(record.items))
    case "object":
      return jsonSchemaToZod(record)
    default:
      return z.unknown()
  }
}

class StdioMcpClient {
  private child: ReturnType<typeof spawn> | undefined
  private nextId = 1
  private buffer = ""
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private closed = false

  constructor(
    private readonly config: McpServerConfig,
    private readonly env: Record<string, string>,
    private readonly options: { cwd?: string; onClose?: () => void } = {},
  ) {}

  get isClosed(): boolean {
    return this.closed
  }

  async initialize(): Promise<void> {
    this.child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.env, ...(this.config.env ?? {}) },
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child.stdout?.setEncoding("utf8")
    this.child.stdout?.on("data", (chunk) => this.handleData(String(chunk)))
    this.child.on("error", (error) => {
      this.markClosed(error)
    })
    this.child.on("exit", (code, signal) => {
      const error = new Error(`MCP server exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`)
      this.markClosed(error)
    })
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "Socrates", version: "0.1.0" },
    })
    this.notify("notifications/initialized", {})
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("MCP server is closed."))
    }
    const id = this.nextId
    this.nextId += 1
    const message = { jsonrpc: "2.0", id, method, params }
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${method}`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

  notify(method: string, params: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    const error = new Error("MCP server was closed.")
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.child?.kill()
    this.options.onClose?.()
  }

  private handleData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf("\n")
      if (index < 0) {
        return
      }
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) {
        continue
      }
      let message: { id?: unknown; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: string } }
      } catch {
        continue
      }
      if (typeof message.id !== "number") {
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) {
        continue
      }
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "MCP request failed"))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  private markClosed(error: Error): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.options.onClose?.()
  }
}
