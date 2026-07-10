import type {
  ApplyPatchToolInput,
  ApplyPatchToolOutput,
  BashToolInput,
  BashToolOutput,
  CurrentTimeToolInput,
  CurrentTimeToolOutput,
  EditToolInput,
  EditToolOutput,
  ListProjectResourcesToolInput,
  ListProjectResourcesToolOutput,
  MemoryNoteToolInput,
  MemoryNoteToolOutput,
  MemoryNotesToolInput,
  MemoryNotesToolOutput,
  MemorySearchInput,
  MemorySearchOutput,
  ReadMemoryJournalToolInput,
  ReadMemoryJournalToolOutput,
  McpRegistryToolInput,
  McpRegistryToolOutput,
  ModelToolDefinition,
  EditFilesToolInput,
  EditFilesToolOutput,
  ProjectDocsToolInput,
  ProjectDocsToolOutput,
  ProjectsToolInput,
  ProjectsToolOutput,
  ReadToolInput,
  ReadToolOutput,
  RepoDocsToolInput,
  RepoDocsToolOutput,
  RuntimeConfig,
  SearchToolInput,
  SearchToolOutput,
  SkillsToolInput,
  SkillsToolOutput,
  SkillWriteToolInput,
  SkillWriteToolOutput,
  SoulToolInput,
  SoulToolOutput,
  ToolDocsToolInput,
  ToolDocsToolOutput,
  ToolName,
  ToolPermission,
  TraceRetrieveGlobalToolInput,
  TraceRetrieveGlobalToolOutput,
  TraceRetrieveMainToolInput,
  TraceRetrieveMainToolOutput,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
  UrlFetchToolInput,
  UrlFetchToolOutput,
  UserProfileToolInput,
  UserProfileToolOutput,
} from "@socrates/contracts"
import type { SocratesError } from "@socrates/shared"

export type FileFreshnessTracker = {
  record: (path: string, contentHash: string | undefined, workspacePath: string) => void
  validate: (path: string, actualHash: string | undefined, workspacePath: string) => void
}

export type ToolExecutorContext = {
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  toolCallId?: string
  workspacePath: string
  runtimeConfig: RuntimeConfig
  fileFreshness?: FileFreshnessTracker
  abortSignal?: AbortSignal
  onOutput?: (output: { stream: "stdout" | "stderr" | "log" | "result"; text?: string; data?: unknown }) => void
}

export type ToolExecutors = {
  read: (input: ReadToolInput, context: ToolExecutorContext) => Promise<ReadToolOutput>
  search: (input: SearchToolInput, context: ToolExecutorContext) => Promise<SearchToolOutput>
  url_fetch: (input: UrlFetchToolInput, context: ToolExecutorContext) => Promise<UrlFetchToolOutput>
  edit: (input: EditToolInput, context: ToolExecutorContext) => Promise<EditToolOutput>
  apply_patch: (input: ApplyPatchToolInput, context: ToolExecutorContext) => Promise<ApplyPatchToolOutput>
  bash: (input: BashToolInput, context: ToolExecutorContext) => Promise<BashToolOutput>
  current_time: (input: CurrentTimeToolInput, context: ToolExecutorContext) => Promise<CurrentTimeToolOutput>
  trace_retrieve: (
    input: TraceRetrieveMainToolInput | TraceRetrieveGlobalToolInput | TraceRetrieveToolInput,
    context: ToolExecutorContext,
  ) => Promise<TraceRetrieveMainToolOutput | TraceRetrieveGlobalToolOutput | TraceRetrieveToolOutput>
  tool_docs: (input: ToolDocsToolInput, context: ToolExecutorContext) => Promise<ToolDocsToolOutput>
  skills: (input: SkillsToolInput, context: ToolExecutorContext) => Promise<SkillsToolOutput>
  projects?: (input: ProjectsToolInput, context: ToolExecutorContext) => Promise<ProjectsToolOutput>
  edit_files?: (input: EditFilesToolInput, context: ToolExecutorContext) => Promise<EditFilesToolOutput>
  project_docs: (input: ProjectDocsToolInput, context: ToolExecutorContext) => Promise<ProjectDocsToolOutput>
  repo_docs: (input: RepoDocsToolInput, context: ToolExecutorContext) => Promise<RepoDocsToolOutput>
  soul: (input: SoulToolInput, context: ToolExecutorContext) => Promise<SoulToolOutput>
  user_profile: (input: UserProfileToolInput, context: ToolExecutorContext) => Promise<UserProfileToolOutput>
  list_project_resources: (
    input: ListProjectResourcesToolInput,
    context: ToolExecutorContext,
  ) => Promise<ListProjectResourcesToolOutput>
  memory_note?: (input: MemoryNoteToolInput, context: ToolExecutorContext) => Promise<MemoryNoteToolOutput>
  memory_notes?: (input: MemoryNotesToolInput, context: ToolExecutorContext) => Promise<MemoryNotesToolOutput>
  memory_search?: (input: MemorySearchInput, context: ToolExecutorContext) => Promise<MemorySearchOutput>
  read_memory_journal?: (input: ReadMemoryJournalToolInput, context: ToolExecutorContext) => Promise<ReadMemoryJournalToolOutput>
  skill_write?: (input: SkillWriteToolInput, context: ToolExecutorContext) => Promise<SkillWriteToolOutput>
  mcp_registry?: (input: McpRegistryToolInput, context: ToolExecutorContext) => Promise<McpRegistryToolOutput>
  mcp_dynamic?: (input: { dynamicName: string; input: unknown }, context: ToolExecutorContext) => Promise<unknown>
}

export type ApprovalRequest = {
  approvalId: string
  toolCallId: string
  providerToolCallId?: string | undefined
  toolName: ToolName
  actionKind: "shell_command" | "file_write" | "patch_apply" | "git_commit" | "git_push" | "other"
  title: string
  description?: string
  actionPreview: string
  risk: "low" | "medium" | "high"
}

export type ApprovalDecision = {
  decision: "approved" | "rejected"
  reason?: string
}

export type ToolRuntimeContext = Omit<ToolExecutorContext, "onOutput"> & {
  executors: ToolExecutors
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>
  modelCallId?: string | undefined
  stepIndex?: number | undefined
}

export type ToolPolicyDecision =
  | { type: "auto" }
  | { type: "approval_required"; request: Omit<ApprovalRequest, "approvalId" | "toolCallId" | "toolName"> }
  | { type: "denied"; reason: string; code?: string; recoverable?: boolean; details?: SocratesError["details"] }

export type SocratesTool<TInput, TOutput> = ModelToolDefinition & {
  name: ToolName
  modelInputSchema?: ModelToolDefinition["inputSchema"]
  resultSchema: NonNullable<ModelToolDefinition["resultSchema"]>
  permission: ToolPermission
  executeLane: "parallel" | "mutation"
  category: "file" | "search" | "shell" | "patch" | "trace" | "mcp" | "other"
  resultPreview: (output: TOutput) => string
  summary: (output: TOutput) => string
  metrics?: (output: TOutput) => {
    filesRead?: number
    filesEdited?: number
    commandsRun?: number
    searchesRun?: number
  }
  decidePolicy: (input: TInput, context: ToolRuntimeContext) => ToolPolicyDecision | Promise<ToolPolicyDecision>
  execute: (
    input: TInput,
    context: ToolRuntimeContext & {
      onOutput: NonNullable<ToolExecutorContext["onOutput"]>
    },
  ) => Promise<TOutput>
}

export type ToolLifecycleEvent =
  | {
      type: "tool.call.streaming"
      toolCallId: string
      providerToolCallId?: string | undefined
      toolName: ToolName
      category: SocratesTool<unknown, unknown>["category"]
      displayName: string
      argsPreview?: string
      pathPreview?: string
      modelCallId?: string | undefined
      stepIndex?: number | undefined
    }
  | {
      type: "tool.call.started"
      toolCallId: string
      providerToolCallId?: string | undefined
      toolName: ToolName
      category: SocratesTool<unknown, unknown>["category"]
      displayName: string
      argsPreview?: string
      input?: unknown
      requiresApproval: boolean
      modelCallId?: string | undefined
      stepIndex?: number | undefined
    }
  | {
      type: "tool.call.output"
      toolCallId: string
      providerToolCallId?: string | undefined
      stream: "stdout" | "stderr" | "log" | "result"
      text?: string
      data?: unknown
      modelCallId?: string | undefined
      stepIndex?: number | undefined
    }
  | {
      type: "tool.call.completed"
      toolCallId: string
      providerToolCallId?: string | undefined
      toolName: ToolName
      output: unknown
      summary: string
      resultPreview?: string
      metrics?: {
        filesRead?: number
        filesEdited?: number
        commandsRun?: number
        searchesRun?: number
      }
      durationMs?: number
      modelCallId?: string | undefined
      stepIndex?: number | undefined
    }
  | {
      type: "tool.call.failed"
      toolCallId: string
      providerToolCallId?: string | undefined
      toolName: ToolName
      error: SocratesError
      modelCallId?: string | undefined
      stepIndex?: number | undefined
    }
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "approval.resolved"; approvalId: string; toolCallId: string; providerToolCallId?: string | undefined; decision: "approved" | "rejected" }
