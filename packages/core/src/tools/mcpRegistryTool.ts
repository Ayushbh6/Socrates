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
    "Discover, validate, add, or delete Model Context Protocol servers. When a user asks for a helper, extension, server, integration, or custom capability, use list then describe with the canonical id. When the user explicitly asks to add a server and provides its trusted command/config, configure saves it disabled, checks the handshake/tools, and enables only on success. Put secrets in secretEnv so they are stored in .socrates/.env, never mcp.json. Use delete only after an explicit user request. Do not invent packages, commands, URLs, or credentials.",
  inputSchema: mcpRegistryToolInputSchema,
  modelInputSchema: mcpRegistryToolModelInputSchema,
  resultSchema: mcpRegistryToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "mcp",
  decidePolicy: (input) => {
    if (input.operation !== "configure" && input.operation !== "delete") return { type: "auto" }
    const id = input.server?.id ?? input.id ?? "MCP server"
    const redacted = input.operation === "configure" && input.server?.secretEnv
      ? { ...input, server: { ...input.server, secretEnv: Object.fromEntries(Object.keys(input.server.secretEnv).map((key) => [key, "••••••••"])) } }
      : input
    return {
      type: "approval_required",
      request: {
        actionKind: "file_write",
        title: input.operation === "delete" ? `Delete ${id} MCP` : `Configure ${id} MCP`,
        description: `${input.operation === "delete" ? "Delete" : "Write"} this ${input.scope ?? "project"} MCP configuration.`,
        actionPreview: JSON.stringify(redacted, null, 2),
        risk: "medium",
      },
    }
  },
  execute: (input, context) => {
    if (!context.executors.mcp_registry) {
      throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
    }
    return context.executors.mcp_registry(input, context)
  },
  summary: (output) => output.summary,
  resultPreview: (output) => JSON.stringify(output, null, 2),
}
