import { createHash } from "node:crypto";
import type { ImageData, JsonSchema } from "@socrates/contracts";

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
  /** Canonical catalog name from mcpCatalogName; dots inside components are escaped. */
  name: string;
  server: string;
  tool: string;
  description: string;
  tags: string[];
  aliases: string[];
  availability: Availability;
  /** The server's readOnlyHint: such a tool never asks for approval. */
  readOnly?: boolean;
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
  /** The server's readOnlyHint. Any other tool asks the user once per goal before its first call. */
  readOnly?: boolean;
}

/** One MCP tool call's result as the server returned it. */
export interface McpCallResult {
  content: string;
  isError: boolean;
  /** The result's image blocks (a screenshot), for a model that can see; at most MCP_IMAGES_MAX, each up to IMAGE_MAX_BYTES. */
  images?: ImageData[];
}

/** Images shown to a model from one MCP call; a page that returns more shows the first ones. */
export const MCP_IMAGES_MAX = 4;

export interface CapabilityCatalog {
  entries(): CatalogEntry[];
  loadSkill(name: string): Promise<LoadedSkill>;
  /**
   * Connect when needed and resolve the exact advertised tool. With fresh,
   * the server's tools/list is requested again instead of read from the
   * live connection's current listing (activation does this).
   */
  loadMcpTool(name: string, options?: { fresh?: boolean; signal?: AbortSignal }): Promise<LoadedMcpTool>;
  /** Invoke one MCP tool on its server. Throws when the server cannot be reached. */
  callMcpTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
  /** Pick up sources that changed since the catalog was opened, such as newly installed Skills. */
  refresh?(signal?: AbortSignal): Promise<void>;
  /** Stop every connection the catalog opened; called when Socrates closes. */
  close?(): Promise<void>;
}

/** A fixed in-memory catalog: the empty default, and the source used by tests. */
export class StaticCatalog implements CapabilityCatalog {
  constructor(
    private readonly items: CatalogEntry[] = [],
    private readonly skills: Record<string, LoadedSkill> = {},
    private readonly tools: Record<string, LoadedMcpTool> = {},
    private readonly handlers: Record<string, (input: Record<string, unknown>) => Promise<McpCallResult> | McpCallResult> = {},
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

  async callMcpTool(name: string, input: Record<string, unknown>): Promise<McpCallResult> {
    const handler = this.handlers[name];
    if (!handler) throw new Error(`MCP tool ${name} has no server connection.`);
    return handler(input);
  }
}

const MAX_PUBLIC_NAME = 64;

/**
 * The collision-safe public name of an MCP tool, such as
 * mcp__github__get_issue. A server or tool name that is not already a plain
 * identifier (one that had to be rewritten, contains "__", or is too long)
 * gets a short hash of its exact identity, so two different tools can never
 * share a public name.
 */
export function mcpPublicName(server: string, tool: string): string {
  const plain = (s: string) => /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/.test(s);
  const name = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  if (plain(server) && plain(tool) && name.length <= MAX_PUBLIC_NAME) return name;
  const suffix = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_PUBLIC_NAME - suffix.length - 1)}_${suffix}`;
}

/** Reversible component encoding keeps catalog identities unique, including dots and percent signs.
 * Plain names retain their persisted names and approvals. Escaped identities use a dot-free
 * namespace so no legacy dotted name or approval can be mistaken for a new encoded identity. */
export function mcpCatalogName(server: string, tool: string): string {
  const component = (value: string) => encodeURIComponent(value).replace(/\./g, "%2E");
  const a = component(server), b = component(tool);
  return a === server && b === tool ? `${server}.${tool}` : `mcp:${a}/${b}`;
}
