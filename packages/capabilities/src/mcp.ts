import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { abortable } from "@socrates/shared";
import type { McpToolSnapshot } from "@socrates/contracts";
import type { LedgerStore } from "@socrates/store";
import type { Availability, McpCallResult } from "@socrates/tools";
import type { McpServerConfig } from "./mcp-config";

/** How long connecting and the first tools/list may take. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
/** How long one tool call may run; progress notifications extend it. */
export const MCP_CALL_TIMEOUT_MS = 10 * 60_000;
/** After a failed connection, the server reports offline and is not retried for this long. */
export const MCP_RETRY_AFTER_MS = 30_000;
const STDERR_TAIL_LINES = 20;

export interface McpServerOptions {
  store: LedgerStore;
  connectTimeoutMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * One configured MCP server (agent-harness.md, "Capability sources"): its
 * connection, supervised and reconnected on demand, and its tool listing.
 * Every listing that differs from the server's previous one is recorded as an
 * `mcp_tools_listed` event, so the catalog is searchable before the server is
 * reached and a resumed task sees exactly what was advertised.
 */
export class McpServer {
  /** The latest known listing: live when connected, otherwise the recorded snapshot. */
  tools: McpToolSnapshot[];
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private failure: { kind: "offline" | "authentication_required"; at: number } | null = null;
  private stderr: string[] = [];
  private closed = false;
  private readonly lifetime = new AbortController();

  constructor(
    readonly config: McpServerConfig,
    private readonly options: McpServerOptions,
  ) {
    this.tools = options.store.mcpToolSnapshots().get(config.name)?.tools ?? [];
  }

  get name(): string {
    return this.config.name;
  }

  /**
   * What the catalog reports for this server's tools. A server is offline
   * only while it backs off after a failed connection; otherwise it is
   * available and connected on first use.
   */
  availability(): Availability {
    if (this.config.disabled) return "disabled";
    if (this.config.missingEnv.length || this.failure?.kind === "authentication_required") return "authentication_required";
    if (this.failure && this.now() - this.failure.at < MCP_RETRY_AFTER_MS) return "offline";
    return "available";
  }

  /** Connect when not connected, once at a time, and list the tools. */
  connect(signal?: AbortSignal): Promise<Client> {
    signal?.throwIfAborted();
    if (this.client) return Promise.resolve(this.client);
    if (this.closed) return Promise.reject(new Error(`MCP server ${this.name} is closed.`));
    const availability = this.availability();
    if (availability !== "available") return Promise.reject(new Error(`MCP server ${this.name} is ${availability}.`));
    this.connecting ??= this.open(signal).finally(() => (this.connecting = null));
    return signal ? abortable(this.connecting, signal) : this.connecting;
  }

  /** The tool as the server advertises it now; fresh asks the server for its tools/list again. */
  async tool(name: string, fresh = false, signal?: AbortSignal): Promise<McpToolSnapshot> {
    const client = await this.connect(signal);
    if (fresh) await this.list(client, signal);
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`MCP server ${this.name} does not advertise ${name}.`);
    return tool;
  }

  /**
   * Call one tool. A protocol error or a timeout is the tool's error result;
   * only an unreachable server throws.
   */
  async call(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const client = await this.connect(signal);
    try {
      const result = await client.callTool({ name: tool, arguments: input }, undefined, { signal, timeout: MCP_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
      return { content: renderResult(result), isError: result.isError === true };
    } catch (error) {
      if (!signal.aborted && error instanceof McpError && error.code !== ErrorCode.ConnectionClosed) return { content: error.message, isError: true };
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    const client = this.client ?? (await this.connecting?.catch(() => null));
    this.client = null;
    await client?.close().catch(() => {});
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async open(requestSignal?: AbortSignal): Promise<Client> {
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.lifetime.signal]) : this.lifetime.signal;
    const client = new Client(
      { name: "socrates", version: "0.2.0" },
      { listChanged: { tools: { autoRefresh: false, onChanged: () => void this.list(client).catch((e) => this.diagnose("tools/list after list_changed failed", e)) } } },
    );
    this.stderr = [];
    const transport = this.config.transport === "stdio"
      ? new StdioClientTransport({ command: this.config.command, args: this.config.args, env: { ...getDefaultEnvironment(), ...this.config.env }, ...(this.config.cwd ? { cwd: this.config.cwd } : {}), stderr: "pipe" })
      : new StreamableHTTPClientTransport(new URL(this.config.url), { requestInit: { headers: this.config.headers } });
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on("data", (chunk: Buffer) => {
        this.stderr.push(...chunk.toString("utf8").split("\n").filter(Boolean));
        this.stderr.splice(0, Math.max(0, this.stderr.length - STDERR_TAIL_LINES));
      });
    }
    try {
      await abortable(client.connect(transport, { signal, timeout: this.options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS }), signal);
      await this.list(client, signal);
      signal.throwIfAborted();
    } catch (error) {
      await client.close().catch(() => {});
      const unauthorized = error instanceof UnauthorizedError || (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403));
      if (!signal.aborted) this.failure = { kind: unauthorized ? "authentication_required" : "offline", at: this.now() };
      this.diagnose("connection failed", error);
      throw error;
    }
    this.failure = null;
    client.onclose = () => {
      // A dropped connection is reconnected on next use.
      if (this.client === client) this.client = null;
    };
    if (this.closed) {
      await client.close().catch(() => {});
      throw new Error(`MCP server ${this.name} is closed.`);
    }
    this.client = client;
    return client;
  }

  /** Read the complete tools/list and record it when it changed. */
  private async list(client: Client, requestSignal?: AbortSignal): Promise<void> {
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.lifetime.signal]) : this.lifetime.signal;
    signal.throwIfAborted();
    const tools: McpToolSnapshot[] = [];
    let cursor: string | undefined;
    do {
      const page = await abortable(client.listTools(cursor ? { cursor } : undefined, { signal, timeout: this.options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS }), signal);
      signal.throwIfAborted();
      for (const t of page.tools) {
        tools.push({ name: t.name, description: (t.description ?? t.title ?? "").trim(), read_only: t.annotations?.readOnlyHint === true, input_schema: t.inputSchema as McpToolSnapshot["input_schema"] });
      }
      cursor = page.nextCursor;
    } while (cursor);
    tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    signal.throwIfAborted();
    this.tools = tools;
    const digest = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
    this.options.store.recordMcpToolSnapshot({ server: this.name, digest, tools });
  }

  /** Bounded internal diagnostics; never shown to a model. */
  private diagnose(what: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.log?.(`MCP server ${this.name}: ${what}: ${message}${this.stderr.length ? `\nstderr:\n${this.stderr.join("\n")}` : ""}`);
  }
}

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

/** The result as text: text blocks verbatim, other blocks as one descriptive line, structured content when nothing else was returned. */
export function renderResult(result: CallToolResult): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts = blocks.map((block) => {
    switch (block.type) {
      case "text": return block.text;
      case "image": case "audio": return `[${block.type} ${block.mimeType}, about ${Math.floor((block.data.length * 3) / 4)} bytes]`;
      case "resource": return "text" in block.resource && typeof block.resource.text === "string" ? block.resource.text : `[resource ${block.resource.uri}${block.resource.mimeType ? ` ${block.resource.mimeType}` : ""}]`;
      case "resource_link": return `[resource link ${block.uri}${block.name ? ` (${block.name})` : ""}]`;
      default: return `[${(block as { type: string }).type} content]`;
    }
  });
  if (!parts.length && result.structuredContent) return JSON.stringify(result.structuredContent);
  if (!parts.length && "toolResult" in result) return JSON.stringify(result.toolResult);
  return parts.join("\n");
}
