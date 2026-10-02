import type { JsonSchema } from "@socrates/contracts";

/**
 * The capability catalog (agent-harness.md, "Conditional capabilities"):
 * lightweight discovery metadata for Skills and MCP tools. Sources (installed
 * Skills, configured MCP servers) implement this interface; the permanent
 * capability tools only search it and activate exact entries.
 */

export type Availability = "available" | "authentication_required" | "offline" | "disabled" | "unavailable";

export interface SkillEntry {
  kind: "skill";
  name: string;
  description: string;
  tags: string[];
  aliases: string[];
  provider: string;
  availability: Availability;
}

export interface McpToolEntry {
  kind: "mcp";
  /** Catalog name, "server.tool". */
  name: string;
  server: string;
  tool: string;
  description: string;
  tags: string[];
  aliases: string[];
  availability: Availability;
}

export type CatalogEntry = SkillEntry | McpToolEntry;

/** Full Skill content, loaded only on activation. */
export interface LoadedSkill {
  version: string;
  instructions: string;
  resourceBase: { kind: "directory"; path: string } | { kind: "url"; url: string } | { kind: "opaque"; description: string };
  /** Catalog names of capabilities the Skill depends on. */
  dependencies: string[];
}

/** One MCP tool's live definition, fetched fresh from its server on activation. */
export interface LoadedMcpTool {
  schemaVersion: string;
  description: string;
  inputSchema: JsonSchema;
  connection: "connected";
}

export interface CapabilityCatalog {
  entries(): CatalogEntry[];
  loadSkill(name: string): Promise<LoadedSkill>;
  /** Connect when needed and resolve the exact advertised tool. */
  loadMcpTool(name: string): Promise<LoadedMcpTool>;
}

/** A fixed in-memory catalog: the empty default, and the source used by tests. */
export class StaticCatalog implements CapabilityCatalog {
  constructor(
    private readonly items: CatalogEntry[] = [],
    private readonly skills: Record<string, LoadedSkill> = {},
    private readonly tools: Record<string, LoadedMcpTool> = {},
  ) {}

  entries(): CatalogEntry[] {
    return this.items;
  }

  async loadSkill(name: string): Promise<LoadedSkill> {
    const skill = this.skills[name];
    if (!skill) throw new Error(`Skill ${name} has no content.`);
    return skill;
  }

  async loadMcpTool(name: string): Promise<LoadedMcpTool> {
    const tool = this.tools[name];
    if (!tool) throw new Error(`MCP tool ${name} is not advertised by its server.`);
    return tool;
  }
}

/** The collision-safe public name of an MCP tool, such as mcp__github__get_issue. */
export function mcpPublicName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}
