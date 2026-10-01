import type {
  ProjectResource,
  TraceRetrieveMainToolInput,
  TraceRetrieveMainToolOutput,
  TurnEvidenceToolOutput,
} from "@socrates/contracts"
import type { McpRuntime } from "@socrates/mcp"
import type { ToolExecutors } from "@socrates/core"
import { SocratesError } from "@socrates/shared"
import {
  applyPatchWorkspace,
  editWorkspace,
  isWorkspaceMutationLocked,
  readWorkspacePath,
  searchWorkspace,
  shouldSerializeBashInput,
  withWorkspaceMutationLock,
} from "@socrates/workspace"
import type { V2FlowStore } from "../services/v2/flowStore"
import type { SocratesStore } from "../services/store"
import type { ActiveTurns } from "../ws/activeTurns"
import { fetchUrlForTool } from "../ws/urlFetch"
import { currentRuntimeTime } from "../services/store/runtimeContext"
import type { V2TerminalRuntime } from "./terminalRuntime"

const docsMutationOperations = new Set(["edit", "patch_section"])

export type V2ToolExecutorsInput = {
  flowStore: V2FlowStore
  sharedStore: SocratesStore
  activeTurns: ActiveTurns
  terminals: V2TerminalRuntime
  projectId: string
  flowId: string
  goalId: string
  turnId: string
  workspacePath: string
  mcpRuntime?: McpRuntime
  exposeMcpServer?: (serverId: string) => void
}

/**
 * V2 deliberately reuses the same low-level Socrates tools and the same
 * `.socrates` / `~/.Socrates` memory services as Classic. The only replaced
 * pieces are conversation-owned persistence: traces, turn evidence, tool rows,
 * and Terminal rows are read/written through V2FlowStore.
 */
export const createV2ToolExecutors = (input: V2ToolExecutorsInput): ToolExecutors => {
  let skillsDiscoverySeen = false
  let skillsAvailable: boolean | undefined
  const lastTraceTurnIds: string[] = []
  const withFreshness = <C extends object>(context: C): C & { fileFreshness?: ReturnType<ActiveTurns["getFileFreshness"]> } => {
    const tracker = input.activeTurns.getFileFreshness(input.turnId)
    return tracker ? { ...context, fileFreshness: tracker } : context
  }
  const hasVisibleSkills = (): boolean => {
    skillsAvailable ??= input.sharedStore.runSkillsTool(input.projectId, { operation: "list", n: 1 }).totalMatches > 0
    return skillsAvailable
  }
  const requireSkillsDiscovery = (toolName: "read" | "list_project_resources", resourcePath?: string): void => {
    if (skillsDiscoverySeen || !hasVisibleSkills()) return
    throw new SocratesError(
      "skills_discovery_required",
      `Before using ${toolName} for uploaded project resources, call skills({ operation: "list" }) first.`,
      {
        recoverable: true,
        details: { toolName, ...(resourcePath ? { resourcePath } : {}), requiredTool: "skills", requiredOperation: "list" },
      },
    )
  }

  return {
    read: (toolInput, context) => {
      if (isProjectResourceRead(toolInput.path)) requireSkillsDiscovery("read", toolInput.path)
      return readWorkspacePath(toolInput, withFreshness(context))
    },
    search: (toolInput, context) => searchWorkspace(toolInput, context),
    url_fetch: (toolInput, context) => fetchUrlForTool(toolInput, context.abortSignal),
    edit: (toolInput, context) => editWorkspace(toolInput, withFreshness(context)),
    apply_patch: (toolInput, context) => applyPatchWorkspace(toolInput, withFreshness(context)),
    bash: async (toolInput, context) => {
      const execute = () => input.terminals.execute(toolInput, {
        projectId: input.projectId,
        flowId: input.flowId,
        goalId: input.goalId,
        turnId: input.turnId,
        workspacePath: input.workspacePath,
      }, context)
      if (!shouldSerializeBashInput(toolInput)) return execute()
      const waiting = isWorkspaceMutationLocked(input.workspacePath)
      return withWorkspaceMutationLock(input.workspacePath, async () => {
        if (waiting) context.onOutput?.({ stream: "log", text: "Waiting for another workspace mutation in this project to finish...\n" })
        return execute()
      })
    },
    wait: async (toolInput) => input.terminals.wait(toolInput, {
      projectId: input.projectId,
      flowId: input.flowId,
      goalId: input.goalId,
      turnId: input.turnId,
    }),
    current_time: async () => currentRuntimeTime(),
    trace_retrieve: async (toolInput) => {
      const output = await retrieveV2Trace(
        input.sharedStore,
        input.projectId,
        input.flowId,
        toolInput as TraceRetrieveMainToolInput,
        lastTraceTurnIds,
      )
      return output
    },
    memory_search: (toolInput) => input.sharedStore.searchMemory(input.projectId, toolInput, false),
    turn_evidence: async (toolInput): Promise<TurnEvidenceToolOutput> => {
      const lineage = input.flowStore.getTaskLineageForTurn(input.projectId, input.flowId, input.turnId)
      const state = input.flowStore.getCoreContextState(input.flowId, lineage.turnIds)
      const references = state.evidence.slice(-toolInput.limit).map((record) => ({
        id: `evd_${record.ref.evidenceId}`,
        kind: record.ref.sourceType,
        label: record.ref.sourceLocator.slice(0, 160),
      }))
      const selected = toolInput.operation === "inspect" && toolInput.reference
        ? state.evidence.find((record) => `evd_${record.ref.evidenceId}` === toolInput.reference)
        : undefined
      if (toolInput.operation === "inspect" && !selected) {
        throw new SocratesError("v2_evidence_not_found", "That exact Flow evidence reference is not available.", { recoverable: true })
      }
      const raw = selected
        ? selected.exactContent
        : state.evidence.slice(-toolInput.limit).map((record) => `${record.ref.sourceType} ${record.ref.sourceLocator}\n${record.exactContent}`).join("\n\n") ||
          "No tool or Terminal evidence has been recorded for this Flow turn yet."
      const content = raw.slice(0, toolInput.charLimit)
      return {
        operation: toolInput.operation,
        taskId: lineage.taskId,
        rootTurnId: lineage.rootTurnId,
        status: lineage.status,
        resumedCount: lineage.resumedCount,
        content,
        references,
        truncation: {
          truncated: content.length < raw.length,
          charLimit: toolInput.charLimit,
          originalLength: raw.length,
          returnedLength: content.length,
        },
      }
    },
    tool_docs: async (toolInput) => input.sharedStore.runToolDocsTool(input.projectId, toolInput),
    skills: async (toolInput, context) => {
      const attachedArchive = toolInput.operation === "preview_import" && toolInput.attachmentPath
        ? input.flowStore.readCurrentTurnSkillZip({
            projectId: input.projectId,
            flowId: input.flowId,
            turnId: input.turnId,
            attachmentPath: toolInput.attachmentPath,
          })
        : undefined
      const output = toolInput.operation === "preview_import" || toolInput.operation === "commit_import"
        ? await input.sharedStore.runSkillsImportTool(input.projectId, toolInput, {
            conversationId: input.flowId,
            turnId: input.turnId,
            ...(context.abortSignal ? { signal: context.abortSignal } : {}),
            ...(attachedArchive ? { attachedArchive } : {}),
          })
        : input.sharedStore.runSkillsTool(input.projectId, toolInput)
      if (["list", "describe", "search", "read"].includes(toolInput.operation)) skillsDiscoverySeen = true
      return output
    },
    memory_note: async (toolInput) => {
      const source = input.flowStore.getTurnMemorySource(input.projectId, input.flowId, input.turnId)
      return input.sharedStore.createMemoryNote(input.projectId, toolInput, {
        conversationId: input.flowId,
        sessionId: input.turnId,
        turnId: input.turnId,
        ...source,
        sourceRuntime: "v2_flow",
        appendClassicEvent: false,
      })
    },
    project_docs: (toolInput) => docsMutationOperations.has(toolInput.operation)
      ? withWorkspaceMutationLock(input.workspacePath, async () => input.sharedStore.runProjectDocsTool(input.projectId, input.workspacePath, toolInput))
      : Promise.resolve(input.sharedStore.runProjectDocsTool(input.projectId, input.workspacePath, toolInput)),
    repo_docs: (toolInput) => docsMutationOperations.has(toolInput.operation)
      ? withWorkspaceMutationLock(input.workspacePath, async () => input.sharedStore.runRepoDocsTool(input.projectId, input.workspacePath, toolInput))
      : Promise.resolve(input.sharedStore.runRepoDocsTool(input.projectId, input.workspacePath, toolInput)),
    soul: async (toolInput) => input.sharedStore.runSoulTool(input.projectId, toolInput),
    user_profile: async (toolInput) => input.sharedStore.runUserProfileTool(input.projectId, toolInput),
    list_project_resources: async (toolInput) => {
      requireSkillsDiscovery("list_project_resources")
      return listProjectResourcesForTool(input.sharedStore, input.projectId, toolInput)
    },
    focus_ledger: async (toolInput) => input.flowStore.useFocusLedger({
      projectId: input.projectId,
      flowId: input.flowId,
      goalId: input.goalId,
      turnId: input.turnId,
      request: toolInput,
    }),
    mcp_registry: async (toolInput, context, resolvedSecretEnv) => {
      if (!input.mcpRuntime) throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
      const output = await input.mcpRuntime.handleRegistryTool(toolInput, {
        workspacePath: context.workspacePath,
        ...(resolvedSecretEnv ? { resolvedSecretEnv } : {}),
      })
      if (output.tools && output.tools.length > 0) {
        input.exposeMcpServer?.(output.server?.id ?? toolInput.id ?? toolInput.serverId ?? toolInput.name ?? toolInput.serverName ?? toolInput.preset ?? "playwright")
      }
      return output
    },
    mcp_dynamic: (toolInput, context) => {
      if (!input.mcpRuntime) throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
      return input.mcpRuntime.callDynamicTool(toolInput.dynamicName, toolInput.input, {
        cwd: context.workspacePath,
        sessionKey: input.flowId,
        workspacePath: context.workspacePath,
      })
    },
  }
}

const retrieveV2Trace = (
  sharedStore: SocratesStore,
  projectId: string,
  flowId: string,
  input: TraceRetrieveMainToolInput,
  lastTraceTurnIds: string[],
): Promise<TraceRetrieveMainToolOutput> => {
  if (input.operation === "inspect") {
    const turnId = input.turnId ?? (input.resultNumber ? lastTraceTurnIds[input.resultNumber - 1] : undefined)
    if (!turnId) return Promise.resolve({ results: [], totalMatches: 0, warnings: ["No matching Seamless Flow turn was found."] })
    return sharedStore.retrieveGlobalToolTraces({
      operation: "inspect",
      projectId,
      turnId,
      ...(input.charLimit ? { charLimit: input.charLimit } : {}),
    }).then(stripGlobalTraceProject)
  }
  const globalInput = input.mode === "audit"
    ? {
        mode: "audit" as const,
        query: input.query,
        scope: "project" as const,
        projectId,
        ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.createdAfter ? { createdAfter: input.createdAfter } : {}),
        ...(input.createdBefore ? { createdBefore: input.createdBefore } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
        ...(input.include ? { include: input.include } : {}),
        ...(input.paths ? { paths: input.paths } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.toolNames ? { toolNames: input.toolNames } : {}),
      }
    : {
        mode: "lexical" as const,
        scope: "project" as const,
        projectId,
        ...(input.query ? { query: input.query } : {}),
        ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.createdAfter ? { createdAfter: input.createdAfter } : {}),
        ...(input.createdBefore ? { createdBefore: input.createdBefore } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
        ...("turnNo" in input && input.turnNo ? { turnNo: input.turnNo } : {}),
      }
  return sharedStore.retrieveGlobalToolTraces(globalInput).then((output) => {
    const stripped = stripGlobalTraceProject(output)
    lastTraceTurnIds.splice(0, lastTraceTurnIds.length, ...stripped.results.map((result) => result.turnId))
    return stripped
  })
}

const stripGlobalTraceProject = (
  output: Awaited<ReturnType<SocratesStore["retrieveGlobalToolTraces"]>>,
): TraceRetrieveMainToolOutput => ({
  results: output.results.map(({ projectTitle: _projectTitle, ...result }) => result),
  totalMatches: output.totalMatches,
  ...(output.warnings ? { warnings: output.warnings } : {}),
})

const isProjectResourceRead = (value: string): boolean => {
  const normalized = value.replaceAll("\\", "/")
  return normalized.startsWith(".socrates/resources/") || normalized.includes("/.socrates/resources/")
}

const listProjectResourcesForTool = (
  store: SocratesStore,
  projectId: string,
  input: Parameters<ToolExecutors["list_project_resources"]>[0],
) => {
  const charLimit = 20_000
  const limit = input.limit ?? 25
  const allResources = store.listResources(projectId).filter((resource) => input.kind ? resource.kind === input.kind : true)
  const resources: Array<Omit<ProjectResource, "projectId">> = []
  for (const resource of allResources) {
    if (resources.length >= limit) break
    const next = {
      id: resource.id,
      name: resource.name,
      kind: resource.kind,
      source: resource.source,
      ...(resource.uri ? { uri: resource.uri } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      ...(resource.sizeBytes === undefined ? {} : { sizeBytes: resource.sizeBytes }),
      status: resource.status,
    }
    if (JSON.stringify([...resources, next]).length > charLimit) break
    resources.push(next)
  }
  const originalLength = JSON.stringify(allResources).length
  const returnedLength = JSON.stringify(resources).length
  const hiddenCount = allResources.length - resources.length
  return {
    resources,
    summary: hiddenCount > 0 ? `Listed ${resources.length} of ${allResources.length} project resources.` : `Listed ${resources.length} project resources.`,
    totalResources: allResources.length,
    truncation: { truncated: hiddenCount > 0, charLimit, originalLength, returnedLength },
    ...(hiddenCount > 0 ? { warnings: [`${hiddenCount} resources were omitted by the output cap.`] } : {}),
  }
}
