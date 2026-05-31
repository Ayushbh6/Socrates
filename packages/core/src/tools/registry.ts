import type { ModelToolDefinition, ToolName } from "@socrates/contracts"
import { applyPatchTool } from "./applyPatchTool"
import { bashTool } from "./bashTool"
import { editTool } from "./editTool"
import { listProjectResourcesTool } from "./listProjectResourcesTool"
import { mcpRegistryTool } from "./mcpRegistryTool"
import { projectNotesTool } from "./projectNotesTool"
import { readTool } from "./readTool"
import { searchTool } from "./searchTool"
import { soulTool } from "./soulTool"
import { socratesMemoryTool } from "./socratesMemoryTool"
import { traceRetrieveTool } from "./traceRetrieveTool"
import type { SocratesTool } from "./types"

const tools = [
  readTool,
  searchTool,
  editTool,
  applyPatchTool,
  bashTool,
  traceRetrieveTool,
  socratesMemoryTool,
  projectNotesTool,
  soulTool,
  listProjectResourcesTool,
  mcpRegistryTool,
] as const

export type RegisteredTool = (typeof tools)[number]

export class ToolRegistry {
  private readonly toolsByName = new Map<ToolName, RegisteredTool>(tools.map((tool) => [tool.name, tool]))

  list(): RegisteredTool[] {
    return [...tools]
  }

  modelDefinitions(additionalTools: ModelToolDefinition[] = []): ModelToolDefinition[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.modelInputSchema ?? tool.inputSchema,
    })).concat(additionalTools)
  }

  get(name: ToolName): SocratesTool<unknown, unknown> | undefined {
    return this.toolsByName.get(name) as SocratesTool<unknown, unknown> | undefined
  }
}

export const createDefaultToolRegistry = (): ToolRegistry => new ToolRegistry()
