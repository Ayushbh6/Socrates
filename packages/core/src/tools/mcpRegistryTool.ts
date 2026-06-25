import {
  mcpRegistryToolInputSchema,
  mcpRegistryToolModelInputSchema,
  mcpRegistryToolOutputSchema,
  type McpRegistryToolInput,
  type McpRegistryToolOutput,
} from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const mcpRegistryTool: SocratesTool<McpRegistryToolInput, McpRegistryToolOutput> = {
  name: "mcp_registry",
  description:
    "List, describe, check, or configure Model Context Protocol servers available to Socrates. Use this before browser automation or MCP setup. Prefer canonical serverId values returned by list; serverName is accepted as an exact display-label fallback. The registry returns concise docs and dynamic MCP tool names when available.",
  inputSchema: mcpRegistryToolInputSchema,
  modelInputSchema: mcpRegistryToolModelInputSchema,
  resultSchema: mcpRegistryToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "mcp",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => {
    if (!context.executors.mcp_registry) {
      throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
    }
    return context.executors.mcp_registry(input, context)
  },
  summary: (output) => output.summary,
  resultPreview: (output) => JSON.stringify(output, null, 2),
}
