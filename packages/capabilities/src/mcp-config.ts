import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The global MCP server configuration, `mcp.json` in the common `mcpServers`
 * format. It is the user's own file, so its servers are trusted: starting
 * them needs no approval. A server with `command` runs over stdio; one with
 * `url` uses streamable HTTP with optional static headers. `${NAME}` in any
 * string value is replaced by that environment variable, which is how
 * secrets stay out of the file.
 */

const Common = { disabled: z.boolean().optional() };
const StdioServer = z.object({ type: z.literal("stdio").optional(), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}), cwd: z.string().optional(), ...Common });
const HttpServer = z.object({ type: z.enum(["http", "streamable-http"]).optional(), url: z.string().min(1), headers: z.record(z.string(), z.string()).default({}), ...Common });

export type McpServerConfig =
  | { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string; disabled: boolean; missingEnv: string[] }
  | { name: string; transport: "http"; url: string; headers: Record<string, string>; disabled: boolean; missingEnv: string[] };

/** Replace `${NAME}` with the environment variable, collecting the names that are not set. */
function expand(value: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const found = env[name];
    if (found === undefined || found === "") {
      missing.add(name);
      return "";
    }
    return found;
  });
}

const expandAll = (record: Record<string, string>, env: NodeJS.ProcessEnv, missing: Set<string>) =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expand(v, env, missing)]));

/** Parse the configuration file. Each server is validated on its own; an invalid one is skipped with a reason. */
export function readMcpConfig(file: string, env: NodeJS.ProcessEnv = process.env): { servers: McpServerConfig[]; problems: string[] } {
  const problems: string[] = [];
  if (!existsSync(file)) return { servers: [], problems };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { servers: [], problems: [`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const entries = raw && typeof raw === "object" && "mcpServers" in raw ? (raw as { mcpServers: unknown }).mcpServers : null;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { servers: [], problems: [`${file} has no mcpServers object.`] };

  const servers: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!name.trim()) continue;
    const missing = new Set<string>();
    const isStdio = !!value && typeof value === "object" && "command" in value;
    const parsed = isStdio ? StdioServer.safeParse(value) : HttpServer.safeParse(value);
    if (!parsed.success) {
      problems.push(`MCP server ${name} skipped: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(server)"}: ${i.message}`).join("; ")}.`);
      continue;
    }
    if ("command" in parsed.data) {
      const s = parsed.data;
      servers.push({
        name,
        transport: "stdio",
        command: expand(s.command, env, missing),
        args: s.args.map((a) => expand(a, env, missing)),
        env: expandAll(s.env, env, missing),
        ...(s.cwd ? { cwd: expand(s.cwd, env, missing) } : {}),
        disabled: s.disabled ?? false,
        missingEnv: [...missing],
      });
    } else {
      const s = parsed.data;
      const url = expand(s.url, env, missing);
      if (!missing.size && !URL.canParse(url)) {
        problems.push(`MCP server ${name} skipped: url is not a valid URL.`);
        continue;
      }
      servers.push({ name, transport: "http", url, headers: expandAll(s.headers, env, missing), disabled: s.disabled ?? false, missingEnv: [...missing] });
    }
  }
  return { servers, problems };
}
