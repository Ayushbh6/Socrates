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
    "List or describe Model Context Protocol servers available to Socrates. Call list before answering when a user asks a helper, extension, server, integration, browser/web/screenshot tool, custom capability, or external tool to do work. Use describe with the exact canonical id from list whenever possible; use name only for an exact listed display name. Do not copy a display name into id. Describe loads that server's docs and exposes dynamic mcp__... tool names. Do not fake MCP/helper results.",
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
