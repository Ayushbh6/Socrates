import type { ModelToolDefinition, ToolName } from "@socrates/contracts"
import { applyPatchTool } from "./applyPatchTool"
import { bashTool } from "./bashTool"
import { editTool } from "./editTool"
import { editFilesTool } from "./editFilesTool"
import { listProjectResourcesTool } from "./listProjectResourcesTool"
import { mcpRegistryTool } from "./mcpRegistryTool"
import { projectDocsTool } from "./projectDocsTool"
import { projectsTool } from "./projectsTool"
import { readTool } from "./readTool"
import { repoDocsTool } from "./repoDocsTool"
import { searchTool } from "./searchTool"
import { skillsTool } from "./skillsTool"
import { soulTool } from "./soulTool"
import { toolDocsTool } from "./toolDocsTool"
import { traceRetrieveTool } from "./traceRetrieveTool"
import type { SocratesTool } from "./types"
import { userProfileTool } from "./userProfileTool"

const tools = [
  readTool,
  searchTool,
  editTool,
  applyPatchTool,
  bashTool,
  traceRetrieveTool,
  toolDocsTool,
  skillsTool,
  projectDocsTool,
  repoDocsTool,
  soulTool,
  userProfileTool,
  listProjectResourcesTool,
  mcpRegistryTool,
] as const

export type RegisteredTool = SocratesTool<any, any>

export class ToolRegistry {
  private readonly registeredTools: readonly RegisteredTool[]
  private readonly toolsByName: Map<ToolName, RegisteredTool>

  constructor(registeredTools: readonly RegisteredTool[] = tools) {
    this.registeredTools = registeredTools
    this.toolsByName = new Map<ToolName, RegisteredTool>(registeredTools.map((tool) => [tool.name, tool]))
  }

  list(): RegisteredTool[] {
    return [...this.registeredTools]
  }

  modelDefinitions(additionalTools: ModelToolDefinition[] = []): ModelToolDefinition[] {
    return this.registeredTools.map((tool) => ({
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

const memoryTools = [traceRetrieveTool, projectsTool, toolDocsTool, skillsTool, soulTool, userProfileTool, editFilesTool] as const

export const createMemoryToolRegistry = (): ToolRegistry => new ToolRegistry(memoryTools)
