import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { LedgerStore } from "@socrates/store";
import type { CapabilityCatalog, CatalogEntry, LoadedMcpTool, LoadedSkill, McpCallResult } from "@socrates/tools";
import { McpServer } from "./mcp";
import { readMcpConfig } from "./mcp-config";
import { type InstalledSkill, loadSkill, scanSkills } from "./skills";

/** MCP tool descriptions in the catalog are bounded; the live schema arrives only on activation. */
export const MCP_DESCRIPTION_MAX_CHARS = 400;

/** The user's global Socrates folder: `$SOCRATES_HOME`, or `~/.socrates`. */
export function socratesHome(): string {
  return process.env.SOCRATES_HOME || path.join(homedir(), ".socrates");
}

export interface InstalledCatalogOptions {
  store: LedgerStore;
  /** The folder holding `skills/` and `mcp.json`; defaults to socratesHome(). */
  home?: string;
  /** Environment for `${NAME}` references in mcp.json. */
  env?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
  now?: () => number;
  /** Internal diagnostics: skipped Skills and servers, connection failures. Never shown to a model. */
  log?: (message: string) => void;
}

/**
 * The installed capabilities (agent-harness.md, "Capability sources"): the
 * global Skills in `<home>/skills/` and the global MCP servers in
 * `<home>/mcp.json`. Sources are global because a goal need not have a
 * project folder. Opening connects every enabled server once; a server that
 * fails is retried on demand after a short back-off.
 */
export class InstalledCatalog implements CapabilityCatalog {
  private skills: InstalledSkill[] = [];
  private readonly servers: McpServer[];
  readonly home: string;

  private constructor(private readonly options: InstalledCatalogOptions) {
    this.home = options.home ?? socratesHome();
    const config = readMcpConfig(path.join(this.home, "mcp.json"), options.env);
    for (const problem of config.problems) options.log?.(problem);
    this.servers = config.servers.map((c) => new McpServer(c, { store: options.store, ...(options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}), ...(options.now ? { now: options.now } : {}), ...(options.log ? { log: options.log } : {}) }));
    for (const server of this.servers) {
      if (server.config.missingEnv.length) options.log?.(`MCP server ${server.name} needs the environment variables ${server.config.missingEnv.join(", ")}.`);
    }
  }

  static async open(options: InstalledCatalogOptions): Promise<InstalledCatalog> {
    const catalog = new InstalledCatalog(options);
    await catalog.refresh();
    await Promise.allSettled(catalog.servers.filter((s) => s.availability() === "available").map((s) => s.connect()));
    return catalog;
  }

  /** Rescan the Skills folder; Skills installed or removed since opening are picked up. */
  async refresh(): Promise<void> {
    const scan = scanSkills(path.join(this.home, "skills"));
    for (const problem of scan.problems) this.options.log?.(problem);
    this.skills = scan.skills;
  }

  entries(): CatalogEntry[] {
    const skills: CatalogEntry[] = this.skills.map((s) => ({ kind: "skill", name: s.name, description: s.description, tags: s.tags, aliases: s.aliases, provider: "user", availability: "available" }));
    const tools: CatalogEntry[] = this.servers.flatMap((server) => {
      const availability = server.availability();
      return server.tools.map((t) => ({
        kind: "mcp" as const,
        name: `${server.name}.${t.name}`,
        server: server.name,
        tool: t.name,
        description: t.description.length > MCP_DESCRIPTION_MAX_CHARS ? `${t.description.slice(0, MCP_DESCRIPTION_MAX_CHARS - 1)}…` : t.description,
        tags: [],
        aliases: [],
        availability,
        readOnly: t.read_only,
      }));
    });
    return [...skills, ...tools];
  }

  async loadSkill(name: string): Promise<LoadedSkill> {
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) throw new Error(`Skill ${name} is not installed.`);
    return loadSkill(skill);
  }

  async loadMcpTool(name: string, options: { fresh?: boolean } = {}): Promise<LoadedMcpTool> {
    const { server, tool } = this.resolve(name);
    const t = await server.tool(tool, options.fresh ?? false);
    return {
      schemaVersion: createHash("sha256").update(JSON.stringify(t.input_schema)).digest("hex").slice(0, 12),
      description: t.description,
      inputSchema: t.input_schema,
      connection: "connected",
      readOnly: t.read_only,
    };
  }

  async callMcpTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const { server, tool } = this.resolve(name);
    return server.call(tool, input, signal);
  }

  /** Stop every server this catalog started. */
  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => s.close()));
  }

  /** Split a catalog name, `server.tool`, by its configured server. */
  private resolve(name: string): { server: McpServer; tool: string } {
    const server = this.servers.filter((s) => name.startsWith(`${s.name}.`)).sort((a, b) => b.name.length - a.name.length)[0];
    if (!server) throw new Error(`No configured MCP server provides ${name}.`);
    return { server, tool: name.slice(server.name.length + 1) };
  }
}
