import type {
  ApplyPatchToolInput,
  ApplyPatchToolOutput,
  BashToolInput,
  BashToolOutput,
  EditToolInput,
  EditToolOutput,
  ListProjectResourcesToolInput,
  ListProjectResourcesToolOutput,
  McpRegistryToolInput,
  McpRegistryToolOutput,
  ModelToolDefinition,
  ReadToolInput,
  ReadToolOutput,
  RuntimeConfig,
  SearchToolInput,
  SearchToolOutput,
  ToolName,
  ToolPermission,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
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
  edit: (input: EditToolInput, context: ToolExecutorContext) => Promise<EditToolOutput>
  apply_patch: (input: ApplyPatchToolInput, context: ToolExecutorContext) => Promise<ApplyPatchToolOutput>
  bash: (input: BashToolInput, context: ToolExecutorContext) => Promise<BashToolOutput>
  trace_retrieve: (input: TraceRetrieveToolInput, context: ToolExecutorContext) => Promise<TraceRetrieveToolOutput>
  list_project_resources: (
    input: ListProjectResourcesToolInput,
    context: ToolExecutorContext,
  ) => Promise<ListProjectResourcesToolOutput>
  mcp_registry?: (input: McpRegistryToolInput, context: ToolExecutorContext) => Promise<McpRegistryToolOutput>
  mcp_dynamic?: (input: { dynamicName: string; input: unknown }, context: ToolExecutorContext) => Promise<unknown>
}

export type ApprovalRequest = {
  approvalId: string
  toolCallId: string
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
  | { type: "denied"; reason: string }

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
      stream: "stdout" | "stderr" | "log" | "result"
      text?: string
      data?: unknown
      modelCallId?: string | undefined
      stepIndex?: number | undefined
    }
  | {
      type: "tool.call.completed"
      toolCallId: string
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
  | { type: "tool.call.failed"; toolCallId: string; toolName: ToolName; error: SocratesError; modelCallId?: string | undefined; stepIndex?: number | undefined }
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "approval.resolved"; approvalId: string; toolCallId: string; decision: "approved" | "rejected" }
