import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { LedgerStore } from "@socrates/store";
import { mcpCatalogName, type CapabilityCatalog, type CatalogEntry, type LoadedMcpTool, type LoadedSkill, type McpCallResult } from "@socrates/tools";
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
 * project folder. Servers connect when first needed — activation or a call —
 * and are reused; search reads the recorded tool lists and never connects.
 * Opening connects only servers with no recorded list yet, so their tools
 * can be found. A server that fails is retried after a short back-off.
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
    return catalog;
  }

  /** Rescan Skills and retry first discovery for servers without a snapshot after backoff. */
  async refresh(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const scan = scanSkills(path.join(this.home, "skills"));
    for (const problem of scan.problems) this.options.log?.(problem);
    this.skills = scan.skills;
    // First discovery can fail transiently. Retry only unknown lists, outside search.
    const known = this.options.store.mcpToolSnapshots();
    await Promise.allSettled(this.servers.filter((s) => !known.has(s.name) && s.availability() === "available").map((s) => s.connect(signal)));
    signal?.throwIfAborted();
  }

  entries(): CatalogEntry[] {
    const skills: CatalogEntry[] = this.skills.map((s) => ({ kind: "skill", name: s.name, description: s.description, tags: s.tags, aliases: s.aliases, provider: "user", availability: "available" }));
    const tools: CatalogEntry[] = this.servers.flatMap((server) => {
      const availability = server.availability();
      return server.tools.map((t) => ({
        kind: "mcp" as const,
        name: mcpCatalogName(server.name, t.name),
        server: server.name,
        tool: t.name,
        description: t.description.length > MCP_DESCRIPTION_MAX_CHARS ? `${t.description.slice(0, MCP_DESCRIPTION_MAX_CHARS - 1)}…` : t.description,
        tags: [],
        aliases: mcpCatalogName(server.name, t.name) === `${server.name}.${t.name}` ? [] : [`${server.name}.${t.name}`],
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

  async loadMcpTool(name: string, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<LoadedMcpTool> {
    const { server, tool } = this.resolve(name);
    const t = await server.tool(tool, options.fresh ?? false, options.signal);
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

  /** Resolve the exact catalog record; never infer identity from a dotted prefix. */
  private resolve(name: string): { server: McpServer; tool: string } {
    const entry = this.entries().find((e) => e.kind === "mcp" && e.name === name);
    if (!entry || entry.kind !== "mcp") throw new Error(`No configured MCP server provides ${name}.`);
    const server = this.servers.find((s) => s.name === entry.server)!;
    return { server, tool: entry.tool };
  }
}
