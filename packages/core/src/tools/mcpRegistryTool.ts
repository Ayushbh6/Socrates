import {
  mcpRegistryToolInputSchema,
  mcpRegistryToolModelInputSchema,
  mcpRegistryToolOutputSchema,
  type McpRegistryToolInput,
  type McpRegistryToolOutput,
} from "@socrates/contracts"
import { createId, SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const mcpRegistryTool: SocratesTool<McpRegistryToolInput, McpRegistryToolOutput> = {
  name: "mcp_registry",
  description:
    "Discover, validate, add, or delete Model Context Protocol servers. When a user asks for a helper, extension, server, integration, or custom capability, use list then describe with the canonical id. When the user explicitly asks to add a server and provides its trusted command/config, configure saves it disabled, checks the handshake/tools, and enables only on success. Declare required secret key names in secretBindings; never read, request, infer, or provide secret values yourself. Use source=workspace_env only when the user explicitly asked to reuse that exact key from a workspace .env file; otherwise use source=user_input so Socrates can collect it privately. Use delete only after an explicit user request. Do not invent packages, commands, URLs, or credentials.",
  inputSchema: mcpRegistryToolInputSchema,
  modelInputSchema: mcpRegistryToolModelInputSchema,
  resultSchema: mcpRegistryToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "mcp",
  decidePolicy: (input) => {
    if (input.operation !== "configure" && input.operation !== "delete") return { type: "auto" }
    const id = input.server?.id ?? input.id ?? "MCP server"
    return {
      type: "approval_required",
      request: {
        actionKind: "file_write",
        title: input.operation === "delete" ? `Delete ${id} MCP` : `Configure ${id} MCP`,
        description: `${input.operation === "delete" ? "Delete" : "Write"} this ${input.scope ?? "project"} MCP configuration.`,
        actionPreview: JSON.stringify(input, null, 2),
        risk: "medium",
      },
    }
  },
  execute: async (input, context) => {
    if (!context.executors.mcp_registry) {
      throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
    }
    if (input.operation !== "configure" || !input.server?.secretBindings?.length) {
      return context.executors.mcp_registry(input, context)
    }
    if (!context.requestCredentialInput) {
      throw new SocratesError("credential_input_handler_unavailable", "Secure credential input is unavailable.", { recoverable: true })
    }

    const resolvedSecretEnv: Record<string, string> = {}
    for (const binding of input.server.secretBindings) {
      const decision = await context.requestCredentialInput({
        credentialRequestId: createId("creq"),
        toolCallId: context.toolCallId ?? createId("tcall"),
        serverId: input.server.id,
        ...(input.server.label ? { serverLabel: input.server.label } : {}),
        envKey: binding.envKey,
        source: binding.source,
      })
      if (decision.decision !== "submitted" || !decision.value) {
        throw new SocratesError("credential_input_cancelled", `Credential entry for ${binding.envKey} was cancelled.`, { recoverable: true })
      }
      resolvedSecretEnv[binding.envKey] = decision.value
    }

    return context.executors.mcp_registry(input, context, resolvedSecretEnv)
  },
  summary: (output) => output.summary,
  resultPreview: (output) => JSON.stringify(output, null, 2),
}
