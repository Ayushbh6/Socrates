import { spawn } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import type { McpRegistryToolInput, McpRegistryToolOutput, McpServerScope, ModelToolDefinition } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"

const mcpServerConfigSchema = z
  .object({
    label: z.string().optional(),
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

export type ManagedMcpServerInput = {
  id: string
  label?: string | undefined
  command: string
  args?: string[] | undefined
  env?: Record<string, string> | undefined
  enabled?: boolean | undefined
  requiresSecrets?: boolean | undefined
}

type McpPaths = {
  scope: McpServerScope
  configPath: string
  envPath: string
  registryPath: string
}

type ScopedServer = {
  id: string
  scope: McpServerScope
  config: McpServerConfig
  paths: McpPaths
}

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

  handleRegistryTool(input: McpRegistryToolInput, options: { workspacePath?: string | undefined } = {}): Promise<McpRegistryToolOutput> {
    this.ensureDefaults()
    const hasExplicitServerLookup = Boolean(input.serverId?.trim() || input.serverName?.trim() || input.preset)
    const serverLookup = input.operation === "configure" ? input.preset ?? input.serverId ?? input.serverName ?? "playwright" : this.registryServerLookup(input, options)
    switch (input.operation) {
      case "list":
        return this.list(hasExplicitServerLookup ? serverLookup : undefined, options)
      case "describe":
        return this.describe(serverLookup, options)
      case "check":
        return this.check(serverLookup, options)
      case "configure":
        return Promise.resolve(this.configure(serverLookup))
    }
  }

  getDynamicToolDefinitions(serverId = "playwright", options: { workspacePath?: string | undefined } = {}): ModelToolDefinition[] {
    this.ensureDefaults()
    const resolved = this.resolveServer(serverId, options)
    if (!resolved?.config.enabled) {
      return []
    }
    const cached = this.readCachedTools(resolved.id, resolved.paths)
    return cached.map((tool) => ({
      name: dynamicToolName(resolved.id, tool.name),
      description: tool.description ?? `Run the ${tool.name} tool from the ${resolved.id} MCP server.`,
      inputSchema: jsonSchemaToZod(tool.inputSchema),
    }))
  }

  async callDynamicTool(dynamicName: string, input: unknown, options: { cwd?: string | undefined; sessionKey?: string | undefined; workspacePath?: string | undefined } = {}): Promise<unknown> {
    const parsed = parseDynamicToolName(dynamicName)
    const resolved = this.resolveServer(parsed.serverId, options)
    if (!resolved?.config.enabled) {
      throw new SocratesError("mcp_server_not_configured", "MCP server is not configured or enabled.", {
        details: { serverId: parsed.serverId },
        recoverable: true,
      })
    }
    const client = await this.clientFor(resolved.id, resolved.config, this.readEnv(resolved.paths), options)
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
        this.clients.delete(this.clientKey(resolved.id, options))
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

  listManagedServers(options: { workspacePath?: string | undefined } = {}): Array<NonNullable<McpRegistryToolOutput["servers"]>[number]> {
    this.ensureDefaults()
    return this.scopedServers(options).map((server) => this.serverSummary(server.id, server.config, "unknown", undefined, server.scope, server.paths))
  }

  upsertManagedServer(scope: McpServerScope, input: ManagedMcpServerInput, options: { workspacePath?: string | undefined } = {}): NonNullable<McpRegistryToolOutput["server"]> {
    const paths = this.pathsForScope(scope, options.workspacePath)
    const config = this.readConfig(paths)
    const next: McpConfig = {
      ...config,
      servers: {
        ...(config.servers ?? {}),
        [input.id]: {
          ...(input.label ? { label: input.label } : {}),
          command: input.command,
          ...(input.args ? { args: input.args } : {}),
          ...(input.env ? { env: input.env } : {}),
          enabled: input.enabled ?? true,
          requiresSecrets: input.requiresSecrets ?? false,
        },
      },
    }
    this.writeConfig(next, paths)
    this.closeServerClients(input.id)
    return this.serverSummary(input.id, next.servers?.[input.id] as McpServerConfig, "unknown", undefined, scope, paths)
  }

  updateManagedServer(
    scope: McpServerScope,
    serverId: string,
    input: { enabled?: boolean | undefined },
    options: { workspacePath?: string | undefined } = {},
  ): NonNullable<McpRegistryToolOutput["server"]> {
    const paths = this.pathsForScope(scope, options.workspacePath)
    const config = this.readConfig(paths)
    const server = config.servers?.[serverId]
    if (!server) {
      throw new SocratesError("mcp_server_not_configured", "MCP server is not configured.", { details: { serverId, scope }, recoverable: true })
    }
    const nextServer = {
      ...server,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    }
    const next: McpConfig = {
      ...config,
      servers: {
        ...(config.servers ?? {}),
        [serverId]: nextServer,
      },
    }
    this.writeConfig(next, paths)
    this.closeServerClients(serverId)
    return this.serverSummary(serverId, nextServer, "unknown", undefined, scope, paths)
  }

  deleteManagedServer(scope: McpServerScope, serverId: string, options: { workspacePath?: string | undefined } = {}): void {
    if (scope === "global" && serverId === "playwright") {
      throw new SocratesError("mcp_bundled_server_required", "Bundled Playwright MCP cannot be deleted. Disable it instead.", {
        details: { serverId, scope },
        recoverable: true,
      })
    }
    const paths = this.pathsForScope(scope, options.workspacePath)
    const config = this.readConfig(paths)
    const servers = { ...(config.servers ?? {}) }
    delete servers[serverId]
    this.writeConfig({ ...config, servers }, paths)
    this.deleteCachedTools(serverId, paths)
    this.closeServerClients(serverId)
  }

  async checkManagedServer(
    serverId: string,
    options: { scope?: McpServerScope | undefined; workspacePath?: string | undefined } = {},
  ): Promise<{ server: NonNullable<McpRegistryToolOutput["server"]>; tools: NonNullable<McpRegistryToolOutput["tools"]>; warnings?: string[] }> {
    const output = await this.check(serverId, options)
    return {
      server: output.server as NonNullable<McpRegistryToolOutput["server"]>,
      tools: output.tools ?? [],
      ...(output.warnings ? { warnings: output.warnings } : {}),
    }
  }

  private async list(namedServer: string | undefined, options: { workspacePath?: string | undefined }): Promise<McpRegistryToolOutput> {
    const servers = this.scopedServers(options).map((server) => this.serverSummary(server.id, server.config, "unknown", undefined, server.scope, server.paths))
    const checked = namedServer ? await this.check(namedServer, options) : undefined
    return {
      operation: "list",
      configPath: this.configPath,
      envPath: this.envPath,
      servers,
      ...(checked?.server ? { server: checked.server } : {}),
      ...(checked?.tools ? { tools: checked.tools } : {}),
      ...(checked?.docs ? { docs: checked.docs } : {}),
      summary: servers.length ? `Found ${servers.length} configured MCP server${servers.length === 1 ? "" : "s"}.` : "No MCP servers configured.",
      ...(checked?.warnings ? { warnings: checked.warnings } : {}),
    }
  }

  private async describe(serverId: string, options: { workspacePath?: string | undefined }): Promise<McpRegistryToolOutput> {
    const resolved = this.resolveServer(serverId, options)
    const resolvedId = resolved?.id ?? serverId
    const docs = this.readRegistryDocs(resolvedId, resolved?.paths)
    const tools = (resolved ? this.readCachedTools(resolvedId, resolved.paths) : []).map((tool) => ({
      name: tool.name,
      dynamicName: dynamicToolName(resolvedId, tool.name),
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    }))
    return {
      operation: "describe",
      configPath: this.configPath,
      envPath: this.envPath,
      ...(resolved ? { server: this.serverSummary(resolvedId, resolved.config, tools.length ? "available" : "unknown", tools.length, resolved.scope, resolved.paths) } : {}),
      tools,
      docs,
      summary: resolved ? `${resolvedId} MCP is configured. Use the listed dynamic tool names when exposed.` : `${serverId} MCP is not configured.`,
    }
  }

  private async check(serverId: string, options: { scope?: McpServerScope | undefined; workspacePath?: string | undefined }): Promise<McpRegistryToolOutput> {
    const resolved = this.resolveServer(serverId, options)
    if (!resolved) {
      return {
        operation: "check",
        configPath: this.configPath,
        envPath: this.envPath,
        server: {
          id: serverId,
          label: serverId,
          ...(options.scope ? { scope: options.scope } : {}),
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
      const client = new StdioMcpClient(resolved.config, this.readEnv(resolved.paths))
      try {
        await client.initialize()
        const response = await client.request("tools/list", {})
        const tools = parseToolsList(response)
        this.writeCachedTools(resolved.id, tools, resolved.paths)
        return {
          operation: "check",
          configPath: this.configPath,
          envPath: this.envPath,
          server: this.serverSummary(resolved.id, resolved.config, "available", tools.length, resolved.scope, resolved.paths),
          tools: tools.map((tool) => ({
            name: tool.name,
            dynamicName: dynamicToolName(resolved.id, tool.name),
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
          })),
          summary: `${resolved.id} MCP is available with ${tools.length} tool${tools.length === 1 ? "" : "s"}.`,
        }
      } finally {
        client.close()
      }
    } catch (error) {
      return {
        operation: "check",
        configPath: this.configPath,
        envPath: this.envPath,
        server: this.serverSummary(resolved.id, resolved.config, "failed", 0, resolved.scope, resolved.paths),
        summary: `${resolved.id} MCP check failed.`,
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
    const paths = this.globalPaths()
    const config = this.readConfig(paths)
    const next: McpConfig = {
      ...config,
      servers: {
        ...(config.servers ?? {}),
        playwright: defaultPlaywrightConfig(),
      },
    }
    this.writeConfig(next, paths)
    this.closeServerClients("playwright")
    this.ensureRegistryDocs()
    return {
      operation: "configure",
      configPath: this.configPath,
      envPath: this.envPath,
      configured: true,
      server: this.serverSummary("playwright", next.servers?.playwright as McpServerConfig, "unknown", 0, "global", paths),
      summary: `Configured Playwright MCP at ${this.configPath}. It does not require secrets.`,
    }
  }

  private ensureDefaults(): void {
    const paths = this.globalPaths()
    fs.mkdirSync(this.socratesHome, { recursive: true })
    fs.mkdirSync(paths.registryPath, { recursive: true })
    if (!fs.existsSync(paths.configPath)) {
      this.writeConfig({ servers: { playwright: defaultPlaywrightConfig() } }, paths)
    } else {
      const config = this.readConfig(paths)
      const repaired = this.repairBundledPlaywrightConfig(config)
      if (repaired !== config) {
        this.writeConfig(repaired, paths)
        this.closeServerClients("playwright")
      }
    }
    if (!fs.existsSync(paths.envPath)) {
      fs.writeFileSync(paths.envPath, "# Socrates local secrets. MCP API keys can be added here when needed.\n")
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
      "Call mcp_registry with operation=\"check\" and serverId=\"playwright\" to discover available dynamic tools. Use the returned mcp__playwright__* tool names only after they are exposed in the current turn.",
      "",
      "This bundled preset does not require API keys. Browser sessions may create local browser state and should be used only when browser automation is relevant.",
      "",
    ].join("\n")
    const existing = fs.existsSync(docsPath) ? fs.readFileSync(docsPath, "utf8") : undefined
    if (!existing || existing.includes('serverName="playwright"')) {
      fs.writeFileSync(docsPath, docs)
    }
  }

  private readRegistryDocs(serverId: string, paths = this.globalPaths()): string | undefined {
    const docsPath = path.join(paths.registryPath, `${serverId}.md`)
    return fs.existsSync(docsPath) ? fs.readFileSync(docsPath, "utf8") : undefined
  }

  private readConfig(paths = this.globalPaths()): McpConfig {
    if (!fs.existsSync(paths.configPath)) {
      return {}
    }
    const parsed = mcpConfigSchema.safeParse(JSON.parse(fs.readFileSync(paths.configPath, "utf8")))
    if (!parsed.success) {
      throw new SocratesError("mcp_config_invalid", "MCP config file is invalid.", {
        details: { configPath: paths.configPath, issues: parsed.error.flatten() },
        recoverable: true,
      })
    }
    return parsed.data
  }

  private writeConfig(config: McpConfig, paths = this.globalPaths()): void {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true })
    fs.writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`)
  }

  private async clientFor(
    serverId: string,
    config: McpServerConfig,
    env: Record<string, string>,
    options: { cwd?: string | undefined; sessionKey?: string | undefined; workspacePath?: string | undefined },
  ): Promise<StdioMcpClient> {
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
      const client = new StdioMcpClient(config, env, {
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

  private clientKey(serverId: string, options: { cwd?: string | undefined; sessionKey?: string | undefined; workspacePath?: string | undefined }): string {
    return [serverId, options.sessionKey ?? "default", options.workspacePath ? path.resolve(options.workspacePath) : "", options.cwd ? path.resolve(options.cwd) : ""].join("\0")
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

  private readEnv(paths = this.globalPaths()): Record<string, string> {
    if (!fs.existsSync(paths.envPath)) {
      return {}
    }
    const result: Record<string, string> = {}
    for (const line of fs.readFileSync(paths.envPath, "utf8").split(/\r?\n/)) {
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

  private readCachedTools(serverId: string, paths = this.globalPaths()): McpTool[] {
    const cachePath = path.join(paths.registryPath, `${serverId}.tools.json`)
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

  private writeCachedTools(serverId: string, tools: McpTool[], paths = this.globalPaths()): void {
    fs.mkdirSync(paths.registryPath, { recursive: true })
    fs.writeFileSync(path.join(paths.registryPath, `${serverId}.tools.json`), `${JSON.stringify(tools, null, 2)}\n`)
  }

  private deleteCachedTools(serverId: string, paths = this.globalPaths()): void {
    const cachePath = path.join(paths.registryPath, `${serverId}.tools.json`)
    if (fs.existsSync(cachePath)) {
      fs.rmSync(cachePath)
    }
  }

  private globalPaths(): McpPaths {
    return {
      scope: "global",
      configPath: this.configPath,
      envPath: this.envPath,
      registryPath: this.registryPath,
    }
  }

  private projectPaths(workspacePath: string): McpPaths {
    const root = path.join(workspacePath, ".socrates")
    return {
      scope: "project",
      configPath: path.join(root, "mcp.json"),
      envPath: path.join(root, ".env"),
      registryPath: path.join(root, "mcp", "registry"),
    }
  }

  private pathsForScope(scope: McpServerScope, workspacePath: string | undefined): McpPaths {
    if (scope === "global") {
      this.ensureDefaults()
      return this.globalPaths()
    }
    if (!workspacePath) {
      throw new SocratesError("mcp_project_workspace_required", "Project MCP servers require an active workspace path.", { recoverable: true })
    }
    const paths = this.projectPaths(workspacePath)
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true })
    fs.mkdirSync(paths.registryPath, { recursive: true })
    return paths
  }

  private scopedServers(options: { workspacePath?: string | undefined }): ScopedServer[] {
    const globalPaths = this.globalPaths()
    const globalConfig = this.readConfig(globalPaths)
    const servers: ScopedServer[] = Object.entries(globalConfig.servers ?? {}).map(([id, config]) => ({
      id,
      scope: "global",
      config: normalizeServerConfig(config),
      paths: globalPaths,
    }))
    if (options.workspacePath) {
      const projectPaths = this.projectPaths(options.workspacePath)
      const projectConfig = this.readConfig(projectPaths)
      servers.push(
        ...Object.entries(projectConfig.servers ?? {}).map(([id, config]) => ({
          id,
          scope: "project" as const,
          config: normalizeServerConfig(config),
          paths: projectPaths,
        })),
      )
    }
    return servers
  }

  private registryServerLookup(input: McpRegistryToolInput, options: { scope?: McpServerScope | undefined; workspacePath?: string | undefined }): string {
    const serverId = input.serverId?.trim()
    const serverName = input.serverName?.trim()
    if (serverId && serverName) {
      const byId = this.resolveServerById(serverId, options)
      const byName = this.resolveServerByName(serverName, options)
      if (!byId || !byName || byId.id !== byName.id || byId.scope !== byName.scope) {
        throw new SocratesError("mcp_server_identity_conflict", "MCP serverId and serverName did not refer to the same configured server.", {
          details: { serverId, serverName },
          recoverable: true,
        })
      }
      return byId.id
    }
    return serverId ?? serverName ?? input.preset ?? "playwright"
  }

  private resolveServer(serverId: string, options: { scope?: McpServerScope | undefined; workspacePath?: string | undefined }): ScopedServer | undefined {
    this.ensureDefaults()
    return this.resolveServerById(serverId, options) ?? this.resolveServerByName(serverId, options)
  }

  private resolveServerById(serverId: string, options: { scope?: McpServerScope | undefined; workspacePath?: string | undefined }): ScopedServer | undefined {
    this.ensureDefaults()
    return findMatchingServer(this.serverCandidates(options), (server) => server.id === serverId)
  }

  private resolveServerByName(serverName: string, options: { scope?: McpServerScope | undefined; workspacePath?: string | undefined }): ScopedServer | undefined {
    this.ensureDefaults()
    const lookup = serverName.trim()
    return findMatchingServer(this.serverCandidates(options), (server) => (server.config.label ?? "").trim() === lookup)
  }

  private serverCandidates(options: { scope?: McpServerScope | undefined; workspacePath?: string | undefined }): ScopedServer[] {
    if (options.scope) {
      const paths = this.pathsForScope(options.scope, options.workspacePath)
      return Object.entries(this.readConfig(paths).servers ?? {}).map(([id, config]) => ({
        id,
        scope: options.scope as McpServerScope,
        config: normalizeServerConfig(config),
        paths,
      }))
    }
    return this.scopedServers(options)
  }

  private repairBundledPlaywrightConfig(config: McpConfig): McpConfig {
    const existing = config.servers?.playwright
    if (!existing) {
      return {
        ...config,
        servers: {
          ...(config.servers ?? {}),
          playwright: defaultPlaywrightConfig(),
        },
      }
    }
    if (!isBundledPlaywrightConfig(existing)) {
      return config
    }
    const commandExists = fs.existsSync(existing.command)
    const firstArg = existing.args?.[0]
    const cliExists = firstArg ? fs.existsSync(firstArg) : false
    if (commandExists && cliExists) {
      return config
    }
    return {
      ...config,
      servers: {
        ...(config.servers ?? {}),
        playwright: defaultPlaywrightConfig(),
      },
    }
  }

  private serverSummary(
    serverId: string,
    server: McpServerConfig,
    status: "available" | "missing" | "failed" | "unknown",
    toolCount: number | undefined,
    scope: McpServerScope,
    paths: McpPaths,
  ) {
    return {
      id: serverId,
      label: server.label ?? (serverId === "playwright" ? "Playwright MCP" : serverId),
      scope,
      configured: true,
      enabled: server.enabled ?? true,
      bundled: serverId === "playwright",
      requiresSecrets: server.requiresSecrets ?? false,
      status,
      ...(toolCount === undefined ? {} : { toolCount }),
      configPath: paths.configPath,
      envPath: paths.envPath,
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
  label: "Playwright MCP",
  command: process.execPath,
  args: [resolvePlaywrightMcpCli()],
  enabled: true,
  requiresSecrets: false,
})

const resolvePlaywrightMcpCli = (): string => {
  const require = createRequire(import.meta.url)
  const packageJson = require.resolve("@playwright/mcp/package.json")
  return path.join(path.dirname(packageJson), "cli.js")
}

const normalizeServerConfig = (server: McpServerConfig): McpServerConfig => ({
  ...server,
  enabled: server.enabled ?? true,
  requiresSecrets: server.requiresSecrets ?? false,
})

const findMatchingServer = (servers: ScopedServer[], matches: (server: ScopedServer) => boolean): ScopedServer | undefined => {
  const matched = servers.filter(matches)
  const projectMatches = matched.filter((server) => server.scope === "project")
  if (projectMatches.length === 1) {
    return projectMatches[0]
  }
  if (projectMatches.length > 1) {
    return undefined
  }
  return matched.length === 1 ? matched[0] : undefined
}

const isBundledPlaywrightConfig = (server: McpServerConfig): boolean => {
  const command = server.command
  const firstArg = server.args?.[0] ?? ""
  if (firstArg.includes("@playwright/mcp")) {
    return true
  }
  if (firstArg.includes(`${path.sep}.Socrates${path.sep}runtimes${path.sep}`) && firstArg.endsWith(path.join("@playwright", "mcp", "cli.js"))) {
    return true
  }
  return command.includes(`${path.sep}.Socrates${path.sep}runtimes${path.sep}`)
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
