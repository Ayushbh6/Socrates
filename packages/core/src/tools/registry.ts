import type { ModelToolDefinition, ToolName } from "@socrates/contracts"
import { bashTool } from "./bashTool"
import { editTool } from "./editTool"
import { listProjectResourcesTool } from "./listProjectResourcesTool"
import { readTool } from "./readTool"
import { searchTool } from "./searchTool"
import { traceRetrieveTool } from "./traceRetrieveTool"
import type { SocratesTool } from "./types"

const tools = [readTool, searchTool, editTool, bashTool, traceRetrieveTool, listProjectResourcesTool] as const

export type RegisteredTool = (typeof tools)[number]

export class ToolRegistry {
  private readonly toolsByName = new Map<ToolName, RegisteredTool>(tools.map((tool) => [tool.name, tool]))

  list(): RegisteredTool[] {
    return [...tools]
  }

  modelDefinitions(): ModelToolDefinition[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
  }

  get(name: ToolName): SocratesTool<unknown, unknown> | undefined {
    return this.toolsByName.get(name) as SocratesTool<unknown, unknown> | undefined
  }
}

export const createDefaultToolRegistry = (): ToolRegistry => new ToolRegistry()
